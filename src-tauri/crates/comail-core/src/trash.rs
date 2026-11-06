//! Permanent deletion is a normal ordered action: hide now, remove locally only
//! after the server confirms a verified identity in its Trash mailbox.
use crate::{
    Core,
    db::repo,
    error::{CoreError, Result},
    events::CoreEvent,
    imap,
    models::{ActionResult, roles},
    provider::{self, MailboxBehavior, RemoteKey},
    sync::engine::{SyncCmd, SyncCtx},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

pub const KIND: &str = "delete_permanently";
pub(crate) mod reconcile;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    message_id: i64,
    thread_id: i64,
    account_id: i64,
    folder_id: i64,
    uid: Option<u32>,
    uid_validity: Option<i64>,
    #[serde(default)]
    remote_key: Option<RemoteKey>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStatus {
    pub action_id: i64,
    pub state: String,
    pub error: Option<String>,
}

impl Core {
    pub(crate) async fn delete_trash_threads(&self, thread_ids: Vec<i64>) -> Result<ActionResult> {
        let changed = thread_ids.clone();
        let ids = self
            .db
            .write(move |conn| enqueue(conn, &thread_ids))
            .await?;
        let action_ids = ids.iter().map(|(id, _)| *id).collect();
        self.bus.emit(CoreEvent::MailUpdated {
            thread_ids: changed,
        });
        for account in ids
            .into_iter()
            .map(|(_, account)| account)
            .collect::<HashSet<_>>()
        {
            self.nudge(Some(account), || SyncCmd::RunActions).await;
        }
        Ok(ActionResult { action_ids })
    }

    pub async fn deletion_status(&self, action_ids: Vec<i64>) -> Result<Vec<DeleteStatus>> {
        if action_ids.len() > 1000 {
            return Err(CoreError::DeleteRejected("Too many actions".into()));
        }
        self.db.read(move |conn| {
            action_ids.into_iter().map(|id| {
                Ok(conn.query_row("SELECT id, state, last_error FROM pending_actions WHERE id = ?1 AND kind = ?2",
                    params![id, KIND], |r| Ok(DeleteStatus { action_id: r.get(0)?, state: r.get(1)?, error: r.get(2)? }))?)
            }).collect()
        }).await
    }
}

pub(crate) fn ensure_not_deleting(conn: &Connection, thread_id: i64) -> Result<()> {
    let active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pending_actions WHERE thread_id=?1 AND kind=?2
         AND state IN ('pending','inflight'))",
        params![thread_id, KIND],
        |r| r.get(0),
    )?;
    if active {
        return Err(CoreError::DeleteRejected(
            "Permanent deletion is pending for this conversation".into(),
        ));
    }
    Ok(())
}

/// Migration/discovery captures demoted roles durably; consume their surviving
/// action history once, before normal seven-day action GC can erase user intent.
pub(crate) fn repair_legacy_trash_intent(conn: &mut Connection) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut stmt = tx.prepare(
        "SELECT folder_id,role FROM folder_role_repairs WHERE completed=0 ORDER BY folder_id",
    )?;
    let folders = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut repaired = 0;
    let mut threads = BTreeSet::new();
    for (folder_id, old_role) in folders {
        if old_role == roles::TRASH
            && let Some(source) = repo::folders::get(&tx, folder_id)?.filter(|f| f.role.is_none())
        {
            let Some(target) = repo::folders::by_role(&tx, source.account_id, roles::TRASH)? else {
                continue;
            };
            if !repo::folders::is_permanent_delete_trash(&tx, target.id)? {
                // Discovery may not have found SPECIAL-USE yet. Keep the marker.
                continue;
            }
            let mut stmt = tx.prepare(
                "SELECT m.id,m.thread_id,m.uid FROM messages m JOIN threads t ON t.id=m.thread_id
                 WHERE m.account_id=?1 AND m.folder_id=?2 AND t.account_id=m.account_id
                 AND EXISTS (SELECT 1 FROM pending_actions p WHERE p.account_id=m.account_id
                   AND p.message_id=m.id AND p.kind='trash' AND p.state='done'
                   AND (CASE WHEN json_valid(p.payload) THEN json_extract(p.payload,'$.targetFolderId') END)=?2)")?;
            let rows = stmt
                .query_map(params![source.account_id, folder_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            for (message_id, thread_id, uid) in rows {
                let action_id = crate::enqueue_move(
                    &tx,
                    source.account_id,
                    thread_id,
                    message_id,
                    Some(folder_id),
                    uid,
                    target.id,
                    "trash",
                )?;
                tracing::info!(
                    account_id = source.account_id,
                    folder_id,
                    action_id,
                    message_id,
                    target_folder_id = target.id,
                    "queued legacy Trash intent repair"
                );
                threads.insert(thread_id);
                repaired += 1;
            }
        }
        tx.execute(
            "UPDATE folder_role_repairs SET completed=1 WHERE folder_id=?1",
            [folder_id],
        )?;
    }
    for thread_id in threads {
        repo::threads::recompute(&tx, thread_id)?;
    }
    tx.commit()?;
    Ok(repaired)
}

fn enqueue(conn: &mut Connection, thread_ids: &[i64]) -> Result<Vec<(i64, i64)>> {
    let tx = conn.transaction()?;
    let mut ids = BTreeSet::new();
    for thread_id in thread_ids.iter().copied().collect::<BTreeSet<_>>() {
        let mut stmt = tx.prepare(
            "SELECT id, account_id FROM pending_actions
            WHERE thread_id=?1 AND kind=?2 AND state IN ('pending','inflight')",
        )?;
        ids.extend(
            stmt.query_map(params![thread_id, KIND], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        drop(stmt);
        let mut stmt = tx.prepare(
            "SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id
            JOIN threads t ON t.id=m.thread_id WHERE m.thread_id=?1 AND f.role=?2
            AND f.account_id=m.account_id AND t.account_id=m.account_id",
        )?;
        let rows = stmt
            .query_map(params![thread_id, roles::TRASH], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for message_id in rows {
            let row = repo::messages::get_row(&tx, message_id)?.expect("selected message");
            let existing: Option<i64> = tx.query_row("SELECT max(id) FROM pending_actions
                WHERE message_id=?1 AND account_id=?2 AND kind=?3 AND state IN ('pending','inflight')",
                params![message_id, row.account_id, KIND], |r| r.get(0))?;
            if let Some(id) = existing {
                ids.insert((id, row.account_id));
                continue;
            }
            let source_folder_id = row.folder_id.expect("joined folder");
            let canonical = repo::folders::by_role(&tx, row.account_id, roles::TRASH)?;
            let Some(folder) = canonical else {
                return Err(missing_canonical_trash(row.account_id, source_folder_id));
            };
            if !repo::folders::is_permanent_delete_trash(&tx, folder.id)? {
                return Err(missing_canonical_trash(row.account_id, source_folder_id));
            }
            let folder_id = folder.id;
            let uid = if source_folder_id == folder_id {
                row.uid
                    .and_then(|uid| u32::try_from(uid).ok())
                    .filter(|uid| *uid > 0)
            } else {
                crate::enqueue_move(
                    &tx,
                    row.account_id,
                    thread_id,
                    message_id,
                    Some(source_folder_id),
                    row.uid,
                    folder_id,
                    "trash",
                )?;
                None
            };
            let target = Target {
                message_id,
                thread_id,
                account_id: row.account_id,
                folder_id,
                uid,
                uid_validity: folder.uidvalidity,
                remote_key: provider::remote_key(&row),
            };
            let id = repo::actions::enqueue(
                &tx,
                row.account_id,
                KIND,
                Some(message_id),
                Some(thread_id),
                &serde_json::to_value(target)?,
                None,
            )?;
            ids.insert((id, row.account_id));
        }
        repo::threads::recompute(&tx, thread_id)?;
    }
    tx.commit()?;
    Ok(ids.into_iter().collect())
}

fn missing_canonical_trash(account_id: i64, folder_id: i64) -> CoreError {
    let error = CoreError::DeleteRejected(
        "No canonical server Trash folder; synchronize before deleting".into(),
    );
    tracing::warn!(account_id, folder_id, action_id = ?Option::<i64>::None, %error,
        "permanent delete enqueue rejected");
    error
}

pub(crate) fn batch_key(action: &repo::actions::PendingAction) -> Option<(i64, i64)> {
    if action.kind != KIND {
        return None;
    }
    let target: Target = serde_json::from_value(action.payload.clone()).ok()?;
    Some((target.account_id, target.folder_id))
}

/// Unknown UIDs are safe to queue; only this executor resolves them remotely.
pub(crate) async fn execute_batch(
    ctx: &SyncCtx,
    session: &mut imap::Session,
    actions: &[repo::actions::PendingAction],
) -> Result<()> {
    let Some(first) = actions.first() else {
        return Ok(());
    };
    let first_target: Target = serde_json::from_value(first.payload.clone())
        .map_err(|_| CoreError::DeleteRejected("Invalid deletion identity".into()))?;
    let account_id = first.account_id;
    let folder_id = first_target.folder_id;
    let uncertain = actions
        .iter()
        .any(|a| a.payload["remoteAttempted"].as_bool() == Some(true));
    let (folder, config) = ctx
        .db
        .read(move |conn| {
            let folder = repo::folders::get(conn, folder_id)?
                .ok_or_else(|| preflight_error(uncertain, "Trash folder no longer exists"))?;
            if folder.account_id != account_id
                || folder.role.as_deref() != Some(roles::TRASH)
                || !repo::folders::is_permanent_delete_trash(conn, folder_id)?
            {
                return Err(preflight_error(
                    uncertain,
                    "Permanent deletion requires the server Trash folder",
                ));
            }
            let config = repo::accounts::get_config(conn, account_id)?
                .ok_or_else(|| preflight_error(uncertain, "Account no longer exists"))?;
            Ok((folder, config))
        })
        .await?;
    let caps = session.server_caps().await?;
    if !caps.uidplus {
        return Err(preflight_error(
            uncertain,
            "Server does not support safe UIDPLUS deletion",
        ));
    }
    let behavior = provider::behavior_for(config.provider, &caps);
    let selected = imap::select(session, &folder.imap_name).await?;
    let mut prepared = Vec::new();
    for action in actions {
        let mut target: Target = serde_json::from_value(action.payload.clone())
            .map_err(|_| CoreError::DeleteRejected("Invalid deletion identity".into()))?;
        if target.account_id != account_id
            || target.folder_id != folder_id
            || action.account_id != account_id
            || action.kind != KIND
            || action.message_id.is_some_and(|id| id != target.message_id)
            || action.thread_id.is_some_and(|id| id != target.thread_id)
        {
            fail_target(ctx, action, "Deletion identity does not match action").await?;
            continue;
        }
        // A preceding move may have learned a new UID or stronger provider key.
        let id = target.message_id;
        let (row, recent_move) = ctx
            .db
            .read(move |conn| {
                Ok((
                    repo::messages::get_row(conn, id)?,
                    reconcile::recent_completed_move(conn, id)?,
                ))
            })
            .await?;
        if row.as_ref().is_some_and(|row| {
            action.message_id == Some(row.id)
                && row.account_id == account_id
                && row.folder_id != Some(folder_id)
                && key_matches_row(target.remote_key.as_ref(), row)
        }) {
            fail_target(
                ctx,
                action,
                "Message is not in canonical Trash; the preceding move may have failed",
            )
            .await?;
            continue;
        }
        if let Some(row) = row.filter(|r| {
            action.message_id == Some(r.id)
                && r.account_id == account_id
                && r.folder_id == Some(folder_id)
                && key_matches_row(target.remote_key.as_ref(), r)
        }) {
            target.remote_key = provider::remote_key(&row).or(target.remote_key);
            if folder.uidvalidity == selected.uid_validity {
                target.uid = row
                    .uid
                    .and_then(|uid| u32::try_from(uid).ok())
                    .filter(|uid| *uid > 0);
                target.uid_validity = folder.uidvalidity;
            }
        }
        prepared.push((action, target, recent_move));
    }
    let known = prepared
        .iter()
        .filter_map(|(_, target, _)| {
            (target.uid_validity == selected.uid_validity)
                .then_some(target.uid)
                .flatten()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut identities = HashMap::new();
    for chunk in known.chunks(256) {
        let set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        for remote in imap::fetch_identities(session, &set, behavior.as_ref()).await? {
            identities.insert(remote.uid, remote);
        }
    }
    let mut remote = BatchIdentityOps {
        session,
        behavior: behavior.as_ref(),
        known: identities,
        listing: None,
        expected_exists: selected.exists,
    };
    let mut verified = Vec::new();
    let mut uids = BTreeSet::new();
    let mut deferred = None;
    for (action, mut target, recent_move) in prepared {
        let resolution =
            resolve_target(&mut remote, &target, selected.uid_validity, recent_move).await;
        match resolution {
            Ok(found) if found.is_empty() => {
                finish_confirmed(ctx, vec![(action.id, target)]).await?
            }
            Ok(found) => {
                learn_remote_identity(ctx, action.id, &mut target, &found).await?;
                uids.extend(found.iter().map(|identity| identity.uid));
                verified.push((action.id, target));
            }
            Err(CoreError::DeleteRejected(reason))
                if action.payload["remoteAttempted"].as_bool() != Some(true) =>
            {
                fail_target(ctx, action, &reason).await?;
            }
            Err(CoreError::DeleteRejected(reason)) => {
                deferred.get_or_insert(CoreError::Other(format!(
                    "Deletion outcome requires verification: {reason}"
                )));
            }
            Err(error @ CoreError::ActionDeferred(_)) => {
                deferred.get_or_insert(error);
            }
            Err(error) => return Err(error),
        }
    }
    if !verified.is_empty() {
        // Persist uncertainty before STORE. Verification retries are bounded by
        // the queue, so a lost acknowledgement cannot lock a thread forever.
        let ids = verified.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        ctx.db.write(move |conn| {
            let tx = conn.transaction()?;
            for id in ids {
                tx.execute("UPDATE pending_actions SET payload=json_set(payload,'$.remoteAttempted',json('true')) WHERE id=?1", [id])?;
            }
            tx.commit()?;
            Ok(())
        }).await?;
        behavior
            .expunge_uids(session, &uids.into_iter().collect::<Vec<_>>())
            .await
            .map_err(|e| match e {
                CoreError::DeleteRejected(reason) => {
                    CoreError::Other(format!("Deletion outcome requires verification: {reason}"))
                }
                other => other,
            })?;
        finish_confirmed(ctx, verified).await?;
    }
    // A missing Header identity must not hold verified siblings hostage. Their
    // done states survive the batch's retryable outcome in record_outcomes.
    deferred.map_or(Ok(()), Err)
}

fn preflight_error(uncertain: bool, reason: &str) -> CoreError {
    if uncertain {
        CoreError::Other(format!("Deletion outcome requires verification: {reason}"))
    } else {
        CoreError::DeleteRejected(reason.into())
    }
}

fn key_matches_row(key: Option<&RemoteKey>, row: &repo::messages::MessageRow) -> bool {
    key.is_none_or(|key| key.matches_row(row))
}

async fn learn_remote_identity(
    ctx: &SyncCtx,
    action_id: i64,
    target: &mut Target,
    found: &[imap::FetchedIdentity],
) -> Result<()> {
    let Some(identity) = found.first().cloned() else {
        return Ok(());
    };
    let snapshot = target.clone();
    let learned = identity.remote_key().filter(|key| {
        key.is_stable()
            && target
                .remote_key
                .as_ref()
                .is_none_or(|old| !old.is_stable())
    });
    let durable_key = learned.clone();
    ctx.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let linked = repo::actions::get(&tx, action_id)?
                .is_some_and(|action| action.message_id == Some(snapshot.message_id));
            if linked
                && let Some(row) =
                    repo::messages::get_row(&tx, snapshot.message_id)?.filter(|row| {
                        row.account_id == snapshot.account_id
                            && row.folder_id == Some(snapshot.folder_id)
                            && key_matches_row(snapshot.remote_key.as_ref(), row)
                    })
            {
                provider::persist_identity(&tx, row.id, &identity)?;
            }
            // Preserve a learned stable key across an uncertain STORE/EXPUNGE
            // acknowledgement, even if sync has already removed the local row.
            if let Some(key) = durable_key {
                tx.execute(
                    "UPDATE pending_actions SET payload=json_set(payload,'$.remoteKey',json(?2))
                WHERE id=?1 AND state='inflight'",
                    params![action_id, serde_json::to_string(&key)?],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    if let Some(key) = learned {
        target.remote_key = Some(key);
    }
    Ok(())
}

trait IdentityOps {
    async fn verify(&mut self, uid: u32, key: &RemoteKey) -> Result<Option<imap::FetchedIdentity>>;
    async fn search(&mut self, key: &RemoteKey) -> Result<Vec<imap::FetchedIdentity>>;
    async fn confirm_absent(&mut self, key: &RemoteKey) -> Result<bool>;
}

struct BatchIdentityOps<'a> {
    session: &'a mut imap::Session,
    behavior: &'a dyn MailboxBehavior,
    known: HashMap<u32, imap::FetchedIdentity>,
    listing: Option<reconcile::Listing>,
    expected_exists: u32,
}

impl IdentityOps for BatchIdentityOps<'_> {
    async fn verify(&mut self, uid: u32, key: &RemoteKey) -> Result<Option<imap::FetchedIdentity>> {
        Ok(self
            .known
            .get(&uid)
            .filter(|identity| identity.matches(key))
            .cloned())
    }
    async fn search(&mut self, key: &RemoteKey) -> Result<Vec<imap::FetchedIdentity>> {
        imap::search_remote_identities(self.session, key, self.behavior).await
    }
    async fn confirm_absent(&mut self, key: &RemoteKey) -> Result<bool> {
        // User-initiated deletion needs fresh evidence, independent of sync's
        // ten-minute throttle. Share one full listing across this delete batch.
        if self.listing.is_none() {
            self.listing = Some(
                reconcile::fetch_listing(self.session, self.behavior, self.expected_exists).await?,
            );
        }
        Ok(self
            .listing
            .as_ref()
            .is_some_and(|listing| listing.absent(key)))
    }
}

async fn resolve_target(
    session: &mut impl IdentityOps,
    target: &Target,
    validity: Option<i64>,
    recent_move: bool,
) -> Result<Vec<imap::FetchedIdentity>> {
    let key = target
        .remote_key
        .as_ref()
        .ok_or_else(|| CoreError::DeleteRejected("Message has no safe remote identity".into()))?;
    if let Some(uid) = target.uid {
        if target.uid_validity != validity || validity.is_none() {
            return Err(CoreError::DeleteRejected(
                "Server UIDVALIDITY changed; deletion stopped".into(),
            ));
        }
        if let Some(identity) = session.verify(uid, key).await? {
            return Ok(vec![identity]);
        }
        // An absent old UID may already be gone. Search still verifies that
        // identity; a reused UID is never deleted merely because it exists.
    }
    let found = session.search(key).await?;
    if found.is_empty() && key.is_header() {
        if recent_move {
            return Err(CoreError::ActionDeferred(
                "Header identity was not found after a recent move; waiting for Trash to settle"
                    .into(),
            ));
        }
        if session.confirm_absent(key).await? {
            return Ok(Vec::new());
        }
    }
    validate_hits(key, found)
}

fn validate_hits(
    key: &RemoteKey,
    hits: Vec<imap::FetchedIdentity>,
) -> Result<Vec<imap::FetchedIdentity>> {
    if hits.is_empty() && key.is_header() {
        return Err(CoreError::ActionDeferred(
            "Header identity was not found; a complete Trash listing is required to confirm absence".into(),
        ));
    }
    if hits.len() > 1 && !key.allows_multiple_matches() {
        return Err(CoreError::DeleteRejected(
            "Ambiguous Message-ID in Trash; message was not deleted".into(),
        ));
    }
    Ok(hits)
}

async fn fail_target(
    ctx: &SyncCtx,
    action: &repo::actions::PendingAction,
    reason: &str,
) -> Result<()> {
    let id = action.id;
    let thread_id = action.thread_id;
    tracing::warn!(account_id = action.account_id, folder_id = ?action.payload["folderId"].as_i64(),
        action_id = id, error = reason, "permanent delete target failed");
    let message = reason.to_string();
    ctx.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            repo::actions::set_state(&tx, id, "failed", Some(&message))?;
            if let Some(thread_id) = thread_id {
                repo::threads::recompute(&tx, thread_id)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    ctx.bus.emit(CoreEvent::ActionState {
        action_id: id,
        kind: KIND.into(),
        state: "failed".into(),
        error: Some(reason.into()),
    });
    ctx.bus.emit(CoreEvent::MailUpdated {
        thread_ids: thread_id.into_iter().collect(),
    });
    Ok(())
}

async fn finish_confirmed(ctx: &SyncCtx, completed: Vec<(i64, Target)>) -> Result<()> {
    let (paths, thread_ids) = ctx
        .db
        .write(move |conn| commit_confirmed(conn, &completed))
        .await?;
    ctx.bus.emit(CoreEvent::MailUpdated { thread_ids });
    for (account_id, path) in paths {
        cleanup_cache(ctx, account_id, path).await;
    }
    Ok(())
}

type ConfirmedCleanup = (Vec<(i64, String)>, Vec<i64>);

fn commit_confirmed(
    conn: &mut Connection,
    completed: &[(i64, Target)],
) -> Result<ConfirmedCleanup> {
    let tx = conn.transaction()?;
    let mut paths = BTreeSet::new();
    let mut threads = BTreeSet::new();
    for (action_id, target) in completed {
        let linked = repo::actions::get(&tx, *action_id)?
            .is_some_and(|action| action.message_id == Some(target.message_id));
        if let Some(row) = repo::messages::get_row(&tx, target.message_id)?.filter(|row| {
            linked
                && row.account_id == target.account_id
                && row.folder_id == Some(target.folder_id)
                && key_matches_row(target.remote_key.as_ref(), row)
        }) {
            let mut stmt = tx.prepare("SELECT raw_path FROM messages WHERE id=?1 AND raw_path IS NOT NULL
                UNION SELECT file_path FROM attachments WHERE message_id=?1 AND file_path IS NOT NULL")?;
            paths.extend(
                stmt.query_map([row.id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .into_iter()
                    .map(|p| (target.account_id, p)),
            );
            drop(stmt);
            repo::messages::delete(&tx, row.id)?;
            threads.extend(row.thread_id);
        }
        threads.insert(target.thread_id);
        repo::actions::set_state(&tx, *action_id, "done", None)?;
    }
    for id in &threads {
        repo::threads::recompute(&tx, *id)?;
    }
    tx.commit()?;
    Ok((paths.into_iter().collect(), threads.into_iter().collect()))
}

async fn cleanup_cache(ctx: &SyncCtx, account_id: i64, path: String) {
    let candidate = path.clone();
    let referenced = ctx.db.read(move |conn| Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE raw_path=?1 UNION ALL SELECT 1 FROM attachments WHERE file_path=?1)",
        [candidate], |r| r.get::<_, bool>(0))?)).await.unwrap_or(true);
    if referenced {
        return;
    }
    // Never remove arbitrary user attachment paths or follow links out of an
    // app-managed cache root. A cleanup failure must not undo remote success.
    if let Ok(canonical) = tokio::fs::canonicalize(&path).await {
        for root in [
            ctx.paths.mail_dir(account_id),
            ctx.paths.attachments_dir(account_id),
        ] {
            if let Ok(root) = tokio::fs::canonicalize(root).await
                && canonical.starts_with(&root)
            {
                if let Err(error) = tokio::fs::remove_file(&canonical).await {
                    tracing::warn!(%error, "permanent delete cache cleanup failed");
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests;
