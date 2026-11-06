//! Pending-action executor. Local mutations already happened optimistically
//! when the action was enqueued (see Core::perform_action); this module
//! replays the intent against the server, in order, when connected.

use crate::accounts::credentials::{self, Slot};
use crate::db::repo;
use crate::error::{CoreError, Result};
use crate::events::CoreEvent;
use crate::imap::{self, Session};
use crate::models::*;
use crate::smtp;
use crate::sync::engine::SyncCtx;
use tokio::time::{Duration, Instant};

#[cfg(test)]
mod deferred_tests;
#[cfg(test)]
mod delete_tests;
#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod move_tests;

const MAX_ATTEMPTS: i64 = 8;
const MAX_ACTIONS_PER_SLICE: i64 = 20;
const MAX_SLICE_DURATION: Duration = Duration::from_secs(2);

/// Outcome of one fair pending-action execution slice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActionSliceResult {
    /// Actions atomically claimed and attempted during this slice.
    pub processed: usize,
    /// More IMAP/SMTP actions are ready now; the caller should schedule another
    /// slice without waiting for the normal sync interval.
    pub due_remaining: bool,
}

pub async fn execute_due(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
) -> Result<ActionSliceResult> {
    let account_id = config.id;
    let started = Instant::now();
    let due = ctx
        .db
        .read(move |conn| repo::actions::due(conn, account_id, now_ms(), MAX_ACTIONS_PER_SLICE))
        .await?;
    let mut processed = 0;

    let mut due = due.into_iter().peekable();
    while let Some(first) = due.next() {
        // This is a cooperative budget: never abandon an action midway through
        // an IMAP/SMTP command, but do not start another after the slice expires.
        if started.elapsed() >= MAX_SLICE_DURATION {
            break;
        }

        let key = crate::trash::batch_key(&first);
        let mut group = vec![first];
        if key.is_some() {
            while due
                .peek()
                .is_some_and(|next| crate::trash::batch_key(next) == key)
            {
                group.push(due.next().unwrap());
            }
        }
        // Claim in a single transaction before sending any remote command.
        let group = ctx
            .db
            .write(move |conn| {
                let tx = conn.transaction()?;
                let mut claimed = Vec::new();
                for action in group {
                    if repo::actions::try_claim(&tx, action.id)? {
                        if action.kind == crate::trash::KIND {
                            resume_delete_budget(&tx, action.id, now_ms())?;
                        }
                        claimed.push(action);
                    }
                }
                tx.commit()?;
                Ok(claimed)
            })
            .await?;
        if group.is_empty() {
            continue;
        }
        processed += group.len();
        for action in &group {
            ctx.bus.emit(CoreEvent::ActionState {
                action_id: action.id,
                kind: action.kind.clone(),
                state: "inflight".into(),
                error: None,
            });
        }
        let outcome = if group[0].kind == crate::trash::KIND {
            crate::trash::execute_batch(ctx, session, &group).await
        } else {
            execute_one(ctx, config, session, &group[0]).await
        };
        record_outcomes(ctx, &group, &outcome).await?;
        // Persist every claimed action's outcome before abandoning the stream.
        if let Err(error) = outcome
            && (matches!(error, CoreError::NeedsReauth | CoreError::Auth(_))
                || needs_fresh_session(&error))
        {
            return Err(error);
        }
    }

    let due_remaining = ctx
        .db
        .read(move |conn| repo::actions::has_due(conn, account_id, now_ms()))
        .await?;
    Ok(ActionSliceResult {
        processed,
        due_remaining,
    })
}

async fn record_outcomes(
    ctx: &SyncCtx,
    group: &[repo::actions::PendingAction],
    outcome: &Result<()>,
) -> Result<()> {
    let account_id = group
        .first()
        .map(|action| action.account_id)
        .unwrap_or_default();
    for action in group {
        let action_id = action.id;
        // A batch may confirm already-absent UIDs before a later target
        // fails. Never turn that durable remote confirmation into a retry
        // or restore the successfully deleted message.
        if action.kind == crate::trash::KIND {
            let settled = ctx
                .db
                .read(move |conn| Ok(repo::actions::get(conn, action_id)?.map(|a| a.state)))
                .await?;
            if settled.as_deref() == Some("failed") {
                continue; // The delete executor already emitted the per-message failure.
            }
            if settled.as_deref() == Some("done") {
                ctx.bus.emit(CoreEvent::ActionState {
                    action_id,
                    kind: action.kind.clone(),
                    state: "done".into(),
                    error: None,
                });
                continue;
            }
        }
        if action.kind == crate::trash::KIND
            && let Err(error) = outcome
        {
            let message = error.to_string();
            let auth_paused = matches!(error, CoreError::NeedsReauth | CoreError::Auth(_));
            let rejected = matches!(
                error,
                CoreError::DeleteRejected(_) | CoreError::ActionRejected(_)
            );
            let result = ctx
                .db
                .write(move |conn| {
                    if auth_paused {
                        record_delete_auth_pause(conn, action_id, now_ms(), &message)
                    } else {
                        record_delete_failure(conn, action_id, now_ms(), &message, rejected)
                    }
                })
                .await?;
            if let Some((state, message, thread_id)) = result {
                tracing::warn!(
                    account_id = action.account_id,
                    folder_id = ?action.payload["folderId"].as_i64(),
                    action_id,
                    state,
                    error = %message,
                    "permanent delete did not complete",
                );
                ctx.bus.emit(CoreEvent::ActionState {
                    action_id,
                    kind: action.kind.clone(),
                    state: state.into(),
                    error: Some(message),
                });
                if state == "failed" {
                    ctx.bus.emit(CoreEvent::MailUpdated {
                        thread_ids: thread_id.into_iter().collect(),
                    });
                }
            }
            continue;
        }
        match outcome {
            Ok(()) => {
                ctx.db
                    .write(move |conn| repo::actions::set_state(conn, action_id, "done", None))
                    .await?;
                ctx.bus.emit(CoreEvent::ActionState {
                    action_id,
                    kind: action.kind.clone(),
                    state: "done".into(),
                    error: None,
                });
            }
            Err(e @ (CoreError::NeedsReauth | CoreError::Auth(_))) => {
                // Leave pending; the actor will pause on reauth. Log the real
                // cause: for SMTP this is usually the mail host rejecting auth
                // (e.g. Office365 tenants disable SMTP AUTH by default), which
                // was previously silent and looked like a stuck "Sending…".
                tracing::warn!(
                    account_id, action_id, kind = %action.kind, error = %e,
                    "action needs auth; pausing (check mail-host auth / SMTP AUTH enabled)",
                );
                let msg = "authentication required".to_string();
                ctx.db
                    .write(move |conn| {
                        repo::actions::bump_attempt(conn, action_id, now_ms() + 60_000, &msg)
                    })
                    .await?;
                ctx.bus.emit(CoreEvent::ActionState {
                    action_id,
                    kind: action.kind.clone(),
                    state: if action.kind == "send" || action.kind == crate::trash::KIND {
                        "paused"
                    } else {
                        "pending"
                    }
                    .into(),
                    error: Some(e.to_string()),
                });
            }
            Err(e @ CoreError::ActionDeferred(_)) => {
                let msg = e.to_string();
                let deferred = ctx
                    .db
                    .write(move |conn| record_deferral(conn, action_id, now_ms(), &msg))
                    .await?;
                if let Some((state, error)) = deferred {
                    ctx.bus.emit(CoreEvent::ActionState {
                        action_id,
                        kind: action.kind.clone(),
                        state: state.into(),
                        error: Some(error),
                    });
                    if state == "failed" && is_move_kind(&action.kind) {
                        ctx.bus.emit(CoreEvent::MailUpdated {
                            thread_ids: deletion_thread_id(action).into_iter().collect(),
                        });
                    }
                }
            }
            Err(e) => {
                let msg = e.to_string();
                let attempts = action.attempts + 1;
                tracing::warn!(
                    account_id, action_id, kind = %action.kind, attempts, error = %msg,
                    "action attempt failed",
                );
                if terminal_failure(&action.kind, attempts, e) {
                    let m = msg.clone();
                    let failed_thread = (action.kind == crate::trash::KIND)
                        .then(|| deletion_thread_id(action))
                        .flatten();
                    ctx.db
                        .write(move |conn| {
                            let tx = conn.transaction()?;
                            repo::actions::set_state(&tx, action_id, "failed", Some(&m))?;
                            rollback_failed_move(&tx, action_id)?;
                            if let Some(thread_id) = failed_thread {
                                repo::threads::recompute(&tx, thread_id)?;
                            }
                            tx.commit()?;
                            Ok(())
                        })
                        .await?;
                    ctx.bus.emit(CoreEvent::ActionState {
                        action_id,
                        kind: action.kind.clone(),
                        state: "failed".into(),
                        error: Some(msg),
                    });
                    if action.kind == crate::trash::KIND || is_move_kind(&action.kind) {
                        ctx.bus.emit(CoreEvent::MailUpdated {
                            thread_ids: deletion_thread_id(action).into_iter().collect(),
                        });
                    }
                } else {
                    // Exponential backoff with jitter.
                    let delay = (1 << attempts.min(8)) * 1000 + (action_id % 997);
                    let m = msg.clone();
                    ctx.db
                        .write(move |conn| {
                            repo::actions::bump_attempt(conn, action_id, now_ms() + delay, &m)
                        })
                        .await?;
                    ctx.bus.emit(CoreEvent::ActionState {
                        action_id,
                        kind: action.kind.clone(),
                        state: "pending".into(),
                        error: Some(msg),
                    });
                }
            }
        }
    }
    Ok(())
}

const MAX_DELETE_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// Close a persisted auth pause at resumption, preserving all executor payload.
fn resume_delete_budget(conn: &rusqlite::Connection, action_id: i64, now: i64) -> Result<i64> {
    let Some(action) = repo::actions::get(conn, action_id)? else {
        return Ok(0);
    };
    let paused_ms = action.payload["deleteAuthPausedMs"]
        .as_i64()
        .unwrap_or(0)
        .max(0);
    let Some(start) = action.payload["deleteAuthPausedAt"].as_i64() else {
        return Ok(paused_ms);
    };
    let paused_ms = paused_ms.saturating_add(now.saturating_sub(start).max(0));
    conn.execute(
        "UPDATE pending_actions SET payload=json_remove(json_set(payload,
         '$.deleteAuthPausedMs', ?2), '$.deleteAuthPausedAt') WHERE id=?1",
        rusqlite::params![action_id, paused_ms],
    )?;
    Ok(paused_ms)
}

fn record_delete_auth_pause(
    conn: &mut rusqlite::Connection,
    action_id: i64,
    now: i64,
    error: &str,
) -> Result<Option<(&'static str, String, Option<i64>)>> {
    let tx = conn.transaction()?;
    let Some(action) =
        repo::actions::get(&tx, action_id)?.filter(|action| action.state == "inflight")
    else {
        return Ok(None);
    };
    let pause_start = action.payload["deleteAuthPausedAt"].as_i64().unwrap_or(now);
    tx.execute(
        "UPDATE pending_actions SET state='pending', not_before=?2, last_error=?3,
         payload=json_set(payload, '$.deleteAuthPausedAt', ?4)
         WHERE id=?1 AND state='inflight'",
        rusqlite::params![action_id, now.saturating_add(60_000), error, pause_start],
    )?;
    tx.commit()?;
    Ok(Some((
        "paused",
        error.to_string(),
        deletion_thread_id(&action),
    )))
}

/// Non-auth failures consume a durable budget excluding authentication pauses.
/// Exhaustion releases visibility without claiming remote deletion succeeded.
fn record_delete_failure(
    conn: &mut rusqlite::Connection,
    action_id: i64,
    now: i64,
    error: &str,
    rejected: bool,
) -> Result<Option<(&'static str, String, Option<i64>)>> {
    let tx = conn.transaction()?;
    let Some(action) =
        repo::actions::get(&tx, action_id)?.filter(|action| action.state == "inflight")
    else {
        return Ok(None);
    };
    let paused_ms = resume_delete_budget(&tx, action_id, now)?;
    let attempts = action.attempts.saturating_add(1);
    let budget_start = action.created_at.saturating_add(paused_ms);
    let expired = attempts >= MAX_ATTEMPTS || now.saturating_sub(budget_start) >= MAX_DELETE_AGE_MS;
    let terminal = expired || rejected;
    let message = if expired {
        format!(
            "Permanent delete retry budget exhausted; synchronize before retrying. Last error: {error}"
        )
    } else {
        error.to_string()
    };
    let deadline = budget_start.saturating_add(MAX_DELETE_AGE_MS);
    let delay = (1_i64 << attempts.min(8)) * 1000 + action_id % 997;
    let move_retry_at = action
        .message_id
        .map(|id| crate::trash::reconcile::completed_move_retry_at(&tx, id, now))
        .transpose()?
        .flatten()
        .unwrap_or(now);
    // Do not exhaust eight quick retries while a five-minute move grace is active.
    let retry_at = now.saturating_add(delay).max(move_retry_at).min(deadline);
    repo::actions::bump_attempt(&tx, action_id, retry_at, &message)?;
    let thread_id = deletion_thread_id(&action);
    if terminal {
        repo::actions::set_state(&tx, action_id, "failed", Some(&message))?;
        if let Some(thread_id) = thread_id {
            repo::threads::recompute(&tx, thread_id)?;
        }
    }
    tx.commit()?;
    Ok(Some((
        if terminal { "failed" } else { "pending" },
        message,
        thread_id,
    )))
}

const MAX_DEFERRALS: u64 = 32;
const MAX_DEFERRAL_AGE_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_DEFERRAL_DELAY_MS: i64 = 15 * 60 * 1000;
const DEFERRAL_EXHAUSTED: &str = "Could not verify remote move; synchronize and retry";

/// Identity waits have their own durable budget: they must not consume remote
/// attempts, but must eventually release later actions on the same message.
fn record_deferral(
    conn: &mut rusqlite::Connection,
    action_id: i64,
    now: i64,
    error: &str,
) -> Result<Option<(&'static str, String)>> {
    let tx = conn.transaction()?;
    let Some(action) =
        repo::actions::get(&tx, action_id)?.filter(|action| action.state == "inflight")
    else {
        return Ok(None);
    };
    // Read the persisted payload, not the executor's possibly stale snapshot.
    let deferrals = action.payload["deferrals"]
        .as_u64()
        .unwrap_or(0)
        .saturating_add(1);
    let first_deferred_at = action.payload["firstDeferredAt"].as_i64().unwrap_or(now);
    let expired =
        deferrals >= MAX_DEFERRALS || now.saturating_sub(first_deferred_at) >= MAX_DEFERRAL_AGE_MS;
    let (state, message) = if expired {
        (
            "failed",
            format!("{DEFERRAL_EXHAUSTED}. Last deferral: {error}"),
        )
    } else {
        ("pending", error.to_string())
    };
    let delay =
        (5_000_i64 * (1_i64 << deferrals.saturating_sub(1).min(8))).min(MAX_DEFERRAL_DELAY_MS);
    let retry_at = (!expired).then(|| {
        now.saturating_add(delay)
            .min(first_deferred_at.saturating_add(MAX_DEFERRAL_AGE_MS))
    });
    tx.execute(
        "UPDATE pending_actions
         SET state = ?2, not_before = ?3, last_error = ?4,
             payload = json_set(payload, '$.deferrals', ?5, '$.firstDeferredAt', ?6),
             finished_at = CASE WHEN ?2 = 'failed' THEN ?7 ELSE finished_at END
         WHERE id = ?1 AND state = 'inflight'",
        rusqlite::params![
            action_id,
            state,
            retry_at,
            message,
            deferrals.min(i64::MAX as u64) as i64,
            first_deferred_at,
            now
        ],
    )?;
    if expired {
        rollback_failed_move(&tx, action_id)?;
    }
    tx.commit()?;
    Ok(Some((state, message)))
}

fn is_move_kind(kind: &str) -> bool {
    matches!(
        kind,
        "move" | "trash" | "archive" | "unarchive" | "spam" | "not_spam"
    )
}

fn rollback_failed_move(conn: &rusqlite::Connection, action_id: i64) -> Result<()> {
    let Some(action) = repo::actions::get(conn, action_id)? else {
        return Ok(());
    };
    if !is_move_kind(&action.kind) {
        return Ok(());
    }
    let Some(message_id) = action.message_id else {
        return Ok(());
    };
    let Some(source_id) = action.payload["srcFolderId"].as_i64() else {
        return Ok(());
    };
    let Some(source) = repo::folders::get(conn, source_id)? else {
        return Ok(());
    };
    if source.account_id != action.account_id {
        return Ok(());
    }
    let Some(row) = repo::messages::get_row(conn, message_id)? else {
        return Ok(());
    };
    // A later optimistic move owns a different destination; do not undo it.
    if row.folder_id != action.payload["targetFolderId"].as_i64() {
        return Ok(());
    }
    conn.execute(
        "UPDATE messages SET folder_id=?1, uid=?2 WHERE id=?3 AND account_id=?4",
        rusqlite::params![
            source_id,
            action.payload["srcUid"].as_i64(),
            message_id,
            action.account_id
        ],
    )?;
    if let Some(thread_id) = row.thread_id {
        repo::threads::recompute(conn, thread_id)?;
    }
    Ok(())
}

fn deletion_thread_id(action: &repo::actions::PendingAction) -> Option<i64> {
    action
        .thread_id
        .or_else(|| action.payload["threadId"].as_i64())
}

fn terminal_failure(kind: &str, attempts: i64, error: &CoreError) -> bool {
    if matches!(error, CoreError::ActionDeferred(_)) {
        return false;
    }
    if matches!(error, CoreError::ActionRejected(_)) {
        return true;
    }
    if kind == crate::trash::KIND {
        return attempts >= MAX_ATTEMPTS || matches!(error, CoreError::DeleteRejected(_));
    }
    attempts >= MAX_ATTEMPTS || is_permanent(&error.to_string())
}

fn needs_fresh_session(error: &CoreError) -> bool {
    if matches!(
        error,
        CoreError::ActionDeferred(_) | CoreError::ActionRejected(_)
    ) {
        return false;
    }
    matches!(
        error,
        CoreError::Imap(_) | CoreError::Io(_) | CoreError::Network(_) | CoreError::Tls(_)
    ) || is_connection_failure(&error.to_string())
}

fn is_permanent(msg: &str) -> bool {
    // IMAP tagged NO responses and SMTP 5xx are not going to succeed on retry.
    msg.contains("NO ") || msg.contains("550") || msg.contains("553") || msg.contains("bad ")
}

fn is_connection_failure(msg: &str) -> bool {
    let msg = msg.to_ascii_lowercase();
    msg.contains("connect")
        || msg.contains("broken")
        || msg.contains("closed")
        || msg.contains("timed out")
        || msg.contains("unexpected eof")
}

async fn execute_one(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    action: &repo::actions::PendingAction,
) -> Result<()> {
    match action.kind.as_str() {
        "mark_read" => flag_action(ctx, config, session, action, "\\Seen", true).await,
        "mark_unread" => flag_action(ctx, config, session, action, "\\Seen", false).await,
        "star" => flag_action(ctx, config, session, action, "\\Flagged", true).await,
        "unstar" => flag_action(ctx, config, session, action, "\\Flagged", false).await,
        "archive" | "unarchive" | "trash" | "spam" | "not_spam" | "move" => {
            let caps = session.server_caps().await?;
            let behavior = crate::provider::behavior_for(config.provider, &caps);
            let mut remote = SessionRemote {
                session,
                behavior: behavior.as_ref(),
            };
            move_action(ctx, &mut remote, action).await
        }
        "add_label" => keyword_action(ctx, config, session, action, true).await,
        "remove_label" => keyword_action(ctx, config, session, action, false).await,
        "send" => send_action(ctx, config, session, action).await,
        // Local-only kinds recorded for undo history.
        "snooze" | "unsnooze" => Ok(()),
        other => {
            tracing::warn!("unknown action kind {other}");
            Ok(())
        }
    }
}

#[cfg(test)]
fn local_remote_location(
    message_id: i64,
    folder_id: Option<i64>,
    uid: Option<i64>,
) -> Result<(i64, u32)> {
    match (folder_id, uid.and_then(|uid| u32::try_from(uid).ok())) {
        (Some(folder_id), Some(uid)) => Ok((folder_id, uid)),
        _ => Err(CoreError::ActionDeferred(format!(
            "message {message_id} has no resolved remote UID yet"
        ))),
    }
}

/// Captured locations are ordered so legacy read-before-move actions can use
/// the later move's source without waiting for that move to run.
fn remote_candidates(
    conn: &rusqlite::Connection,
    action: &repo::actions::PendingAction,
) -> Result<Vec<(repo::folders::Folder, u32, Option<i64>)>> {
    let mut out = Vec::new();
    let Some(id) = action.message_id else {
        return Ok(out);
    };
    let Some(row) = repo::messages::get_row(conn, id)? else {
        return Ok(out);
    };
    let mut push = |folder_id: Option<i64>,
                    uid: Option<u32>,
                    validity: Option<i64>,
                    current: bool|
     -> Result<()> {
        if let (Some(folder_id), Some(uid)) = (folder_id, uid)
            && let Some(folder) = repo::folders::get(conn, folder_id)?
            && folder.account_id == action.account_id
        {
            let epoch = if current {
                folder.uidvalidity
            } else {
                validity
            };
            out.push((folder, uid, epoch));
        }
        Ok(())
    };
    push(
        row.folder_id,
        row.uid
            .and_then(|u| u32::try_from(u).ok())
            .filter(|u| *u > 0),
        None,
        true,
    )?;
    push(
        action.payload["folderId"].as_i64(),
        payload_uid(&action.payload, "uid")?,
        action.payload["uidValidity"].as_i64(),
        false,
    )?;
    let mut stmt = conn.prepare("SELECT payload FROM pending_actions WHERE message_id=?1 AND account_id=?2 AND id>?3 AND state IN ('pending','inflight') AND kind IN ('move','trash','archive','unarchive','spam','not_spam') ORDER BY id")?;
    let payloads = stmt.query_map(rusqlite::params![id, action.account_id, action.id], |r| {
        r.get::<_, String>(0)
    })?;
    for payload in payloads {
        let payload: serde_json::Value = serde_json::from_str(&payload?)?;
        push(
            payload["srcFolderId"].as_i64(),
            payload_uid(&payload, "srcUid")?,
            payload["srcUidValidity"].as_i64(),
            false,
        )?;
    }
    Ok(out)
}

async fn resolve_remote(
    ctx: &SyncCtx,
    remote: &mut impl MoveRemote,
    action: &repo::actions::PendingAction,
) -> Result<Option<(repo::folders::Folder, u32)>> {
    let Some(message_id) = action.message_id else {
        return Ok(None);
    };
    let row = ctx
        .db
        .read(move |conn| repo::messages::get_row(conn, message_id))
        .await?;
    let Some(row) = row else { return Ok(None) };
    let snapshot = action.clone();
    let candidates = ctx
        .db
        .read(move |conn| remote_candidates(conn, &snapshot))
        .await?;
    for (folder, uid, validity) in candidates {
        let selected_validity = remote.select_source(&folder.imap_name).await?;
        if validity.is_some() && validity == selected_validity {
            return Ok(Some((folder, uid)));
        }
    }
    if let Some(folder_id) = row.folder_id {
        let folder = ctx
            .db
            .read(move |conn| repo::folders::get(conn, folder_id))
            .await?;
        if let Some(folder) = folder {
            remote.select_source(&folder.imap_name).await?;
            if let Some(key) = crate::provider::remote_key(&row) {
                let hits = remote.search_key(&key).await?;
                if let [uid] = hits.as_slice() {
                    return Ok(Some((folder, *uid)));
                }
            }
        }
    }
    Err(CoreError::ActionDeferred(format!(
        "message {message_id} has no verified remote identity yet"
    )))
}

trait MoveRemote {
    fn select_source(
        &mut self,
        folder: &str,
    ) -> impl std::future::Future<Output = Result<Option<i64>>> + Send;
    fn uid_exists(&mut self, uid: u32) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn search_key(
        &mut self,
        key: &crate::provider::RemoteKey,
    ) -> impl std::future::Future<Output = Result<Vec<u32>>> + Send;
    fn verify_key(
        &mut self,
        uid: u32,
        key: &crate::provider::RemoteKey,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn move_uid(
        &mut self,
        uid: u32,
        target: &str,
    ) -> impl std::future::Future<Output = Result<Option<u32>>> + Send;
}

struct SessionRemote<'a> {
    session: &'a mut Session,
    behavior: &'a dyn crate::provider::MailboxBehavior,
}

impl MoveRemote for SessionRemote<'_> {
    async fn select_source(&mut self, folder: &str) -> Result<Option<i64>> {
        Ok(imap::select(self.session, folder).await?.uid_validity)
    }

    async fn uid_exists(&mut self, uid: u32) -> Result<bool> {
        Ok(imap::uid_search_set(self.session, &[uid])
            .await?
            .contains(&uid))
    }

    async fn search_key(&mut self, key: &crate::provider::RemoteKey) -> Result<Vec<u32>> {
        imap::uid_search_remote_key(self.session, key, self.behavior).await
    }

    async fn verify_key(&mut self, uid: u32, key: &crate::provider::RemoteKey) -> Result<bool> {
        imap::verify_remote_key(self.session, uid, key, self.behavior).await
    }

    async fn move_uid(&mut self, uid: u32, target: &str) -> Result<Option<u32>> {
        imap::uid_move(self.session, uid, target).await
    }
}

struct MoveIdentity {
    source: repo::folders::Folder,
    target: repo::folders::Folder,
    uid: Option<u32>,
    uid_validity: Option<u32>,
    message_id: Option<String>,
    key: Option<crate::provider::RemoteKey>,
}

fn payload_uid(payload: &serde_json::Value, key: &str) -> Result<Option<u32>> {
    if payload[key].is_null() {
        return Ok(None);
    }
    payload[key]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
        .map(Some)
        .ok_or_else(|| {
            CoreError::ActionRejected(format!("invalid {key}: expected a positive 32-bit value"))
        })
}

fn load_move_identity(
    conn: &rusqlite::Connection,
    action: &repo::actions::PendingAction,
) -> Result<MoveIdentity> {
    let folder = |key: &str| -> Result<repo::folders::Folder> {
        let id = action.payload[key]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(|| CoreError::ActionRejected(format!("move missing {key}")))?;
        let folder = repo::folders::get(conn, id)?.ok_or_else(|| {
            CoreError::ActionDeferred(format!("move {key} folder is unavailable"))
        })?;
        if folder.account_id != action.account_id {
            return Err(CoreError::ActionRejected(format!(
                "move {key} belongs to another account"
            )));
        }
        Ok(folder)
    };
    let source = folder("srcFolderId")?;
    let target = folder("targetFolderId")?;
    if source.id == target.id {
        return Err(CoreError::ActionRejected(
            "move source and target are identical".into(),
        ));
    }
    let uid = payload_uid(&action.payload, "srcUid")?;
    let uid_validity = payload_uid(&action.payload, "srcUidValidity")?;
    let row = action
        .message_id
        .map(|id| repo::messages::get_row(conn, id))
        .transpose()?
        .flatten();
    if row
        .as_ref()
        .is_some_and(|row| row.account_id != action.account_id)
    {
        return Err(CoreError::ActionRejected(
            "move message belongs to another account".into(),
        ));
    }
    let mut key = row.as_ref().and_then(crate::provider::remote_key);
    let message_id = match &action.payload["srcMessageId"] {
        serde_json::Value::Null => row.and_then(|row| row.message_id),
        serde_json::Value::String(value) => Some(value.clone()),
        _ => return Err(CoreError::ActionRejected("invalid srcMessageId".into())),
    };
    if message_id.as_ref().is_some_and(|value| {
        let trimmed = value.trim();
        let normalized = trimmed
            .strip_prefix('<')
            .and_then(|id| id.strip_suffix('>'))
            .unwrap_or(trimmed);
        normalized.is_empty()
            || normalized.len() > 998
            || !value.is_ascii()
            || value.chars().any(char::is_control)
    }) {
        return Err(CoreError::ActionRejected(
            "invalid source Message-ID".into(),
        ));
    }
    if let Some(message_id) = &message_id
        && key.is_none()
    {
        key = crate::provider::key_from_parts(None, Some(message_id), None, None);
    }
    Ok(MoveIdentity {
        key,
        source,
        target,
        uid,
        uid_validity,
        message_id,
    })
}

fn unique_source_uid(mut matches: Vec<u32>) -> Result<u32> {
    matches.sort_unstable();
    matches.dedup();
    match matches.as_slice() {
        [uid] if *uid > 0 => Ok(*uid),
        [] => Err(CoreError::ActionDeferred(
            "move source Message-ID not found; awaiting source sync or remote reconciliation"
                .into(),
        )),
        _ => Err(CoreError::ActionDeferred(
            "move source Message-ID is ambiguous; refusing to choose a UID".into(),
        )),
    }
}

async fn persist_move_identity(
    ctx: &SyncCtx,
    action: &repo::actions::PendingAction,
    identity: &MoveIdentity,
    uid: u32,
    uid_validity: u32,
) -> Result<()> {
    let action_id = action.id;
    let account_id = action.account_id;
    let message_id = identity.message_id.clone();
    ctx.db.write(move |conn| {
        let changed = conn.execute(
            "UPDATE pending_actions
             SET payload = json_set(payload, '$.srcUid', ?3, '$.srcUidValidity', ?4, '$.srcMessageId', ?5)
             WHERE id = ?1 AND account_id = ?2 AND state = 'inflight'",
            rusqlite::params![action_id, account_id, uid, uid_validity, message_id],
        )?;
        if changed != 1 {
            return Err(CoreError::ActionDeferred("move action is no longer claimed".into()));
        }
        Ok(())
    }).await
}

/// A chained move's optimistic row can already point at a later destination.
/// Only the captured source epoch/UID or an exact remote Message-ID match may
/// identify the source. In particular, never borrow the local row's new UID.
async fn resolve_source(
    ctx: &SyncCtx,
    remote: &mut impl MoveRemote,
    action: &repo::actions::PendingAction,
    identity: &MoveIdentity,
) -> Result<u32> {
    let validity = remote
        .select_source(&identity.source.imap_name)
        .await?
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            CoreError::ActionDeferred("source SELECT did not provide valid UIDVALIDITY".into())
        })?;
    let uid = if let Some(uid) = identity
        .uid
        .filter(|_| identity.uid_validity == Some(validity))
    {
        if remote.uid_exists(uid).await? {
            Some(uid)
        } else {
            None
        }
    } else {
        None
    };
    let uid = match uid {
        Some(uid) => uid,
        None => {
            let key = identity.key.as_ref().ok_or_else(|| CoreError::ActionDeferred(
                "move lacks verified source UID/UIDVALIDITY and remote key; awaiting identity reconciliation".into(),
            ))?;
            unique_source_uid(remote.search_key(key).await?)?
        }
    };
    persist_move_identity(ctx, action, identity, uid, validity).await?;
    Ok(uid)
}

async fn flag_action(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    action: &repo::actions::PendingAction,
    flag: &str,
    add: bool,
) -> Result<()> {
    if action.message_id.is_none() {
        return Ok(());
    }
    let caps = session.server_caps().await?;
    let behavior = crate::provider::behavior_for(config.provider, &caps);
    let mut remote = SessionRemote {
        session,
        behavior: behavior.as_ref(),
    };
    match resolve_remote(ctx, &mut remote, action).await? {
        Some((_folder, uid)) => imap::store_flag(session, uid, flag, add).await,
        None => Ok(()), // deleted remotely; flag intent is moot
    }
}

/// Push a label as a custom IMAP keyword on the message's current remote copy.
async fn keyword_action(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    action: &repo::actions::PendingAction,
    add: bool,
) -> Result<()> {
    if action.message_id.is_none() {
        return Ok(());
    }
    let Some(keyword) = action.payload["keyword"].as_str() else {
        return Ok(());
    };
    let caps = session.server_caps().await?;
    let behavior = crate::provider::behavior_for(config.provider, &caps);
    let mut remote = SessionRemote {
        session,
        behavior: behavior.as_ref(),
    };
    match resolve_remote(ctx, &mut remote, action).await? {
        Some((_folder, uid)) => imap::store_flag(session, uid, keyword, add).await,
        None => Ok(()), // deleted remotely; label intent is moot
    }
}

async fn move_action(
    ctx: &SyncCtx,
    remote: &mut impl MoveRemote,
    action: &repo::actions::PendingAction,
) -> Result<()> {
    let snapshot = action.clone();
    let identity = ctx
        .db
        .read(move |conn| load_move_identity(conn, &snapshot))
        .await?;
    let uid = resolve_source(ctx, remote, action, &identity).await?;
    // Sync may have relinked a later destination meanwhile; never clear or
    // overwrite its UID after the remote move.
    let copied_uid = remote.move_uid(uid, &identity.target.imap_name).await?;
    // COPYUID carries a target epoch that Option<u32> cannot preserve. Select
    // and verify identity in the current namespace before adopting its UID.
    let lookup: Result<(Option<u32>, Option<i64>)> = async {
        let validity = remote.select_source(&identity.target.imap_name).await?;
        let Some(key) = identity.key.as_ref() else {
            return Ok((None, validity));
        };
        if let Some(uid) = copied_uid
            && remote.verify_key(uid, key).await?
        {
            return Ok((Some(uid), validity));
        }
        let hits = remote.search_key(key).await?;
        Ok((
            if let [uid] = hits.as_slice() {
                Some(*uid)
            } else {
                None
            },
            validity,
        ))
    }
    .await;
    let (destination, validity) = match lookup {
        Ok(result) => result,
        Err(error) => {
            // Never replay a confirmed move after identity bookkeeping fails.
            tracing::warn!(action_id = action.id, %error, "move completed; destination lookup deferred to sync");
            return Ok(());
        }
    };
    let Some(validity) = validity.filter(|v| *v > 0 && u32::try_from(*v).is_ok()) else {
        return Ok(());
    };
    let message_id = action.message_id;
    let target = identity.target;
    ctx.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let Some(current) = repo::folders::get(&tx, target.id)? else {
                return Ok(());
            };
            if current.uidvalidity != Some(validity) {
                if current.uidvalidity != target.uidvalidity {
                    return Ok(());
                }
                repo::folders::reset_uid_mappings(&tx, target.id)?;
                repo::folders::set_uid_state(&tx, target.id, Some(validity), None, None)?;
            }
            tx.execute(
                "UPDATE messages SET uid=?1 WHERE id=?2 AND folder_id=?3 AND uid IS NULL",
                rusqlite::params![destination, message_id, target.id],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
}

async fn send_action(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    action: &repo::actions::PendingAction,
) -> Result<()> {
    let Some(draft_id) = action.payload["draftId"].as_i64() else {
        return Err(CoreError::Other("send action without draftId".into()));
    };
    tracing::info!(account_id = config.id, draft_id, "smtp send: starting");

    // Load everything needed to build the message.
    let (detail, references) = ctx
        .db
        .read(move |conn| {
            let detail = repo::messages::detail(conn, draft_id)?;
            // Reference chain from the replied-to message.
            let irt: Option<i64> = conn
                .query_row(
                    "SELECT in_reply_to_message_id FROM drafts_meta WHERE message_id = ?1",
                    rusqlite::params![draft_id],
                    |r| r.get(0),
                )
                .unwrap_or(None);
            let mut refs: Vec<String> = Vec::new();
            let mut in_reply_to: Option<String> = None;
            if let Some(parent_id) = irt {
                let mut stmt =
                    conn.prepare("SELECT ref_message_id FROM message_refs WHERE message_id = ?1")?;
                refs = stmt
                    .query_map(rusqlite::params![parent_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if let Some(parent) = repo::messages::get_row(conn, parent_id)?
                    && let Some(pmid) = parent.message_id
                {
                    refs.push(pmid.clone());
                    in_reply_to = Some(pmid);
                }
            }
            Ok((detail, (refs, in_reply_to)))
        })
        .await?;

    let (refs, in_reply_to) = references;
    // The actor's config is a snapshot from when it started; read the sender
    // name fresh so a rename in Settings applies to the next send.
    let account_id = config.id;
    let display_name = ctx
        .db
        .read(move |conn| repo::accounts::get(conn, account_id))
        .await?
        .map_or_else(|| config.display_name.clone(), |a| a.display_name);
    let from = Address {
        name: display_name,
        email: config.email.clone(),
    };
    let domain = config
        .email
        .split('@')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    let bcc = ctx
        .db
        .read(move |conn| {
            let json: String = conn.query_row(
                "SELECT bcc_json FROM messages WHERE id = ?1",
                rusqlite::params![draft_id],
                |r| r.get(0),
            )?;
            Ok(serde_json::from_str::<Vec<Address>>(&json).unwrap_or_default())
        })
        .await?;

    // Staged attachments (read from disk at dispatch time).
    let att_rows: Vec<(String, String)> = ctx
        .db
        .read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT file_path, filename FROM draft_attachments WHERE draft_id = ?1")?;
            let rows = stmt
                .query_map(rusqlite::params![draft_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await?;
    // Defense in depth: only ever read files inside our own staging root, so a
    // stale/crafted `draft_attachments` row can't turn dispatch into an
    // arbitrary local-file read. `save_draft` copies picked files in here.
    let staging_root = tokio::fs::canonicalize(ctx.paths.draft_attachments_dir())
        .await
        .ok();
    let mut attachments = Vec::new();
    for (path, filename) in att_rows {
        let canon = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| CoreError::Other(format!("attachment {filename}: {e}")))?;
        let within = staging_root
            .as_ref()
            .is_some_and(|root| canon.starts_with(root));
        if !within {
            return Err(CoreError::Other(format!(
                "attachment {filename}: refusing to read file outside the staging area"
            )));
        }
        let bytes = tokio::fs::read(&canon)
            .await
            .map_err(|e| CoreError::Other(format!("attachment {filename}: {e}")))?;
        let mime_type = mime_guess_from_name(&filename);
        attachments.push(crate::mime::OutgoingAttachment {
            filename,
            mime_type,
            bytes,
        });
    }

    let out = crate::mime::OutgoingMessage {
        from: from.clone(),
        to: &detail.to,
        cc: &detail.cc,
        bcc: &bcc,
        subject: &detail.subject,
        body_text: detail.text_body.as_deref().unwrap_or(""),
        body_html: detail.html_body.as_deref(),
        in_reply_to: in_reply_to.as_deref(),
        references: &refs,
        message_id_domain: &domain,
        attachments,
    };
    let (msg_id, raw) = crate::mime::build_message(&out)?;
    tracing::debug!(
        account_id = config.id,
        draft_id,
        message_id = %msg_id,
        bytes = raw.len(),
        attachments = out.attachments.len(),
        to = detail.to.len(),
        cc = detail.cc.len(),
        bcc = bcc.len(),
        "smtp send: message built",
    );

    // SMTP auth.
    let auth = match config.auth_kind {
        AuthKind::Password => {
            smtp::SmtpAuth::Password(credentials::load_async(config.id, Slot::Password).await?)
        }
        AuthKind::Oauth2 => {
            smtp::SmtpAuth::XOAuth2(ctx.tokens.access_token(config.id, config.provider).await?)
        }
    };

    let recipients: Vec<String> = detail
        .to
        .iter()
        .chain(detail.cc.iter())
        .chain(bcc.iter())
        .map(|a| a.email.clone())
        .collect();
    if recipients.is_empty() {
        return Err(CoreError::Smtp("no recipients".into()));
    }

    tracing::info!(
        account_id = config.id,
        host = %config.smtp_host,
        port = config.smtp_port,
        recipients = recipients.len(),
        "smtp send: dispatching",
    );
    smtp::send_raw(config, &auth, &config.email, &recipients, &raw).await?;
    tracing::info!(account_id = config.id, "smtp send: accepted by server");

    // Append to Sent (Gmail does this automatically).
    if config.provider != Provider::Gmail {
        let sent = ctx
            .db
            .read({
                let account_id = config.id;
                move |conn| repo::folders::by_role(conn, account_id, roles::SENT)
            })
            .await?;
        if let Some(sent) = sent {
            match imap::append(session, &sent.imap_name, &raw, true).await {
                Ok(_) => tracing::debug!(
                    account_id = config.id,
                    folder = %sent.imap_name,
                    "smtp send: appended copy to Sent",
                ),
                Err(e) => tracing::warn!("append to sent failed (message was sent): {e}"),
            }
        }
    }

    // Flip the local draft into a sent message.
    let sent_folder_id = ctx
        .db
        .read({
            let account_id = config.id;
            move |conn| Ok(repo::folders::by_role(conn, account_id, roles::SENT)?.map(|f| f.id))
        })
        .await?;
    // mail-parser strips angle brackets from Message-IDs; store the same form
    // so the Sent-folder sync dedupes against this row instead of duplicating.
    let msg_id_bare = msg_id.trim_matches(['<', '>']).to_string();
    // The Sent-folder sync dedupes this row by Message-ID and never harvests
    // it, so record the recipients here or frequent contacts never rank up.
    let sent_to: Vec<Address> = detail
        .to
        .iter()
        .chain(detail.cc.iter())
        .chain(bcc.iter())
        .cloned()
        .collect();
    let account_id = config.id;
    let thread_id = ctx
        .db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let sent_at = now_ms();
            tx.execute(
                "UPDATE messages SET is_draft = 0, is_outgoing = 1, is_read = 1,
                        message_id = ?2, folder_id = COALESCE(?3, folder_id), uid = NULL, date = ?4
                 WHERE id = ?1",
                rusqlite::params![draft_id, msg_id_bare, sent_folder_id, sent_at],
            )?;
            for a in &sent_to {
                repo::contacts::harvest(&tx, account_id, a, true, sent_at)?;
            }
            tx.execute(
                "DELETE FROM drafts_meta WHERE message_id = ?1",
                rusqlite::params![draft_id],
            )?;
            let tid: Option<i64> =
                repo::messages::get_row(&tx, draft_id)?.and_then(|r| r.thread_id);
            if let Some(tid) = tid {
                repo::threads::recompute(&tx, tid)?;
            }
            repo::search::index_message(&tx, draft_id)?;
            tx.commit()?;
            Ok(tid)
        })
        .await?;

    if let Some(tid) = thread_id {
        ctx.bus.emit(CoreEvent::MailUpdated {
            thread_ids: vec![tid],
        });
    }
    tracing::info!(
        account_id = config.id,
        draft_id,
        thread_id = ?thread_id,
        "smtp send: complete",
    );
    Ok(())
}

/// Tiny extension-based MIME guess for outgoing attachments.
fn mime_guess_from_name(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "eml" => "message/rfc822",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn partial_delete_batch_preserves_done_members_on_error() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::config::Paths::for_tests(root.path());
        let db = crate::db::Db::open(&paths.db_file()).unwrap();
        let group = db
            .write(|conn| {
                crate::db::testutil::seed_account(conn);
                let mut group = Vec::new();
                for _ in 0..3 {
                    let id = repo::actions::enqueue(
                        conn,
                        1,
                        crate::trash::KIND,
                        None,
                        None,
                        &serde_json::json!({}),
                        None,
                    )?;
                    assert!(repo::actions::try_claim(conn, id)?);
                    group.push(repo::actions::get(conn, id)?.unwrap());
                }
                // The remote batch confirmed only its first target absent.
                repo::actions::set_state(conn, group[0].id, "done", None)?;
                repo::actions::set_state(conn, group[2].id, "failed", Some("independent failure"))?;
                Ok(group)
            })
            .await
            .unwrap();
        let ctx = SyncCtx {
            db,
            bus: crate::events::EventBus::new(),
            paths: std::sync::Arc::new(paths),
            tokens: crate::oauth::tokens::TokenProvider::new(),
        };
        let mut events = ctx.bus.subscribe();
        for error in [
            CoreError::Imap("lost EXPUNGE acknowledgement".into()),
            CoreError::DeleteRejected("remaining target rejected before write".into()),
        ] {
            let expected = if matches!(error, CoreError::DeleteRejected(_)) {
                "failed"
            } else {
                "pending"
            };
            let id = group[1].id;
            ctx.db
                .write(move |conn| {
                    conn.execute(
                        "UPDATE pending_actions SET state='inflight' WHERE id=?1",
                        [id],
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
            record_outcomes(&ctx, &group, &Err(error)).await.unwrap();
            let ids = (group[0].id, group[1].id, group[2].id);
            let states = ctx
                .db
                .read(move |conn| {
                    Ok((
                        repo::actions::get(conn, ids.0)?.unwrap(),
                        repo::actions::get(conn, ids.1)?.unwrap(),
                        repo::actions::get(conn, ids.2)?.unwrap(),
                    ))
                })
                .await
                .unwrap();
            assert_eq!(states.0.state, "done");
            assert_eq!(states.0.attempts, 0);
            assert_eq!(states.1.state, expected);
            assert_eq!(states.2.state, "failed");
            assert_eq!(states.2.attempts, 0);
            assert!(
                matches!(events.try_recv().unwrap(), CoreEvent::ActionState { state, .. } if state == "done")
            );
            assert!(
                matches!(events.try_recv().unwrap(), CoreEvent::ActionState { state, .. } if state == expected)
            );
        }
    }

    #[tokio::test]
    async fn auth_failure_preserves_send_pause_and_bounded_delete_retry() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::config::Paths::for_tests(root.path());
        let db = crate::db::Db::open(&paths.db_file()).unwrap();
        let group = db
            .write(|conn| {
                crate::db::testutil::seed_account(conn);
                ["send", crate::trash::KIND, "star"]
                    .into_iter()
                    .map(|kind| {
                        let id = repo::actions::enqueue(
                            conn,
                            1,
                            kind,
                            None,
                            None,
                            &serde_json::json!({}),
                            None,
                        )?;
                        assert!(repo::actions::try_claim(conn, id)?);
                        Ok(repo::actions::get(conn, id)?.unwrap())
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .await
            .unwrap();
        let ctx = SyncCtx {
            db,
            bus: crate::events::EventBus::new(),
            paths: std::sync::Arc::new(paths),
            tokens: crate::oauth::tokens::TokenProvider::new(),
        };
        let mut events = ctx.bus.subscribe();
        record_outcomes(&ctx, &group, &Err(CoreError::NeedsReauth))
            .await
            .unwrap();
        for (action, expected) in group.into_iter().zip(["paused", "paused", "pending"]) {
            assert!(
                matches!(events.try_recv().unwrap(), CoreEvent::ActionState {
                action_id, kind, state, error: Some(_),
            } if action_id == action.id && kind == action.kind && state == expected)
            );
            let stored = ctx
                .db
                .read(move |conn| Ok(repo::actions::get(conn, action.id)?.unwrap()))
                .await
                .unwrap();
            assert_eq!(stored.state, "pending");
            assert_eq!(
                stored.attempts,
                if action.kind == crate::trash::KIND {
                    0
                } else {
                    1
                }
            );
        }
    }

    #[test]
    fn uncertain_deletion_exhausts_retry_budget() {
        for error in [
            CoreError::Imap("NO after STORE".into()),
            CoreError::Imap("unexpected tagged response".into()),
            CoreError::Network("closed".into()),
            CoreError::Other("550 bad transport".into()),
        ] {
            assert!(terminal_failure(
                crate::trash::KIND,
                MAX_ATTEMPTS + 100,
                &error
            ));
        }
        assert!(terminal_failure(
            crate::trash::KIND,
            1,
            &CoreError::DeleteRejected("UIDVALIDITY changed".into())
        ));
        assert!(terminal_failure(
            "star",
            MAX_ATTEMPTS,
            &CoreError::Other("temporary quota".into())
        ));
        assert!(needs_fresh_session(&CoreError::Imap(
            "unexpected tagged response".into()
        )));
    }

    #[test]
    fn timed_out_action_forces_a_fresh_session() {
        assert!(is_connection_failure("UID MOVE timed out after 30s"));
        assert!(is_connection_failure("connection closed"));
        assert!(!is_connection_failure("temporary mailbox quota"));
    }
}
