//! Per-account sync actor. One IMAP connection per account runs a cycle loop:
//! drain commands -> execute due pending actions -> sync folders (new mail,
//! flags, expunges) -> extend historical backfill. Bulk message bodies are NOT
//! downloaded on this connection: a separate backfill pool (`run_backfill_pool`)
//! drains them with up to BODY_POOL_CONNS concurrent IMAP connections, so body
//! downloads run in parallel with header sync and never block the cycle.
//!
//! On servers that support it the actor waits in IMAP IDLE between cycles, so
//! new inbox mail wakes it within seconds; the full 60s cycle still runs as a
//! correctness backstop. Servers without IDLE fall back to a short poll. Either
//! way commands (body fetches, action nudges) interrupt the wait immediately
//! because it selects on the command channel.

use crate::accounts::credentials::{self, Slot};
use crate::config::Paths;
use crate::db::repo::{self, folders::Folder, messages::NewMessage};
use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::events::{CoreEvent, EventBus, SyncProgress};
use crate::imap::{self, FetchedHeader, ImapCredentials, Session};
use crate::models::*;
use crate::oauth::tokens::TokenProvider;
use crate::queue;
use std::sync::Arc;
use tokio::sync::mpsc;

const BACKFILL_DAYS: i64 = 90;
const HEADER_CHUNK: usize = 200;
/// Messages whose full bodies are pulled in a single FETCH command.
const BODY_FETCH_CHUNK: usize = 25;
/// Concurrent IMAP connections dedicated to bulk body backfill. Together with
/// the sync actor and the on-demand reader that's BODY_POOL_CONNS + 2
/// connections per account, well under common server caps (Gmail allows 15).
const BODY_POOL_CONNS: usize = 4;
const HISTORY_CHUNK: u32 = 500;
const CYCLE_SECS: u64 = 60;
/// Poll cadence when the server does not support IDLE (near-real-time push).
const IDLE_FALLBACK_SECS: u64 = 20;
/// Re-issue IDLE at least this often (RFC 2177 recommends < 29 min) to keep the
/// connection alive through NAT/firewall idle timeouts.
const IDLE_MAX_SECS: u64 = 300;
const FLAG_WINDOW: i64 = 1000; // most recent N UIDs get flag reconciliation

#[derive(Debug)]
pub enum SyncCmd {
    SyncNow,
    FetchBody { message_id: i64 },
    RunActions,
    Shutdown,
}

#[derive(Clone)]
pub struct AccountHandle {
    pub account_id: i64,
    tx: mpsc::UnboundedSender<SyncCmd>,
    /// Separate channel + connection for on-demand body reads so opening a
    /// message never waits behind a long bulk-sync cycle on the main actor.
    body_tx: mpsc::UnboundedSender<i64>,
}

impl AccountHandle {
    pub fn send(&self, cmd: SyncCmd) {
        // Route priority body fetches to the dedicated reader connection;
        // everything else drives the bulk sync actor.
        match cmd {
            SyncCmd::FetchBody { message_id } => {
                let _ = self.body_tx.send(message_id);
            }
            other => {
                let _ = self.tx.send(other);
            }
        }
    }
}

#[derive(Clone)]
pub struct SyncCtx {
    pub db: Db,
    pub bus: EventBus,
    pub paths: Arc<Paths>,
    pub tokens: TokenProvider,
}

pub fn spawn_account(ctx: SyncCtx, config: AccountConfig) -> AccountHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let (body_tx, body_rx) = mpsc::unbounded_channel();
    let (pool_tx, pool_rx) = mpsc::unbounded_channel();
    let handle = AccountHandle {
        account_id: config.id,
        tx,
        body_tx,
    };
    tokio::spawn(run_actor(ctx.clone(), config.clone(), rx, pool_tx));
    tokio::spawn(run_body_fetcher(ctx.clone(), config.clone(), body_rx));
    tokio::spawn(run_backfill_pool(ctx, config, pool_rx));
    handle
}

/// Dedicated reader connection. Owns its own IMAP session and services only
/// on-demand single-message body fetches (user opened a thread). Kept separate
/// from `run_actor` so reading an email is instant even while the main actor is
/// busy with a long initial backfill. Connects lazily and reconnects on error.
async fn run_body_fetcher(
    ctx: SyncCtx,
    config: AccountConfig,
    mut rx: mpsc::UnboundedReceiver<i64>,
) {
    let account_id = config.id;
    let mut session: Option<Session> = None;
    while let Some(first) = rx.recv().await {
        // Coalesce every request already queued (plus a brief window for the
        // rest of a thread's messages to land) into ONE batch, so opening a
        // thread pulls all its bodies in a single FETCH round-trip instead of
        // one per message. Opening a single message just fetches that one.
        let mut ids = vec![first];
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        while let Ok(id) = rx.try_recv() {
            ids.push(id);
            if ids.len() >= BODY_FETCH_CHUNK {
                break;
            }
        }
        ids.sort_unstable();
        ids.dedup();

        // Try the reused session first; if it's gone stale (servers close idle
        // connections), the fetch fails, so drop it and retry once on a fresh
        // connection. Without the retry the skeleton would hang forever: the
        // requests were already consumed from the channel, and nothing
        // re-nudges them until the user reopens the thread.
        let mut fetched = false;
        for attempt in 0..2 {
            if session.is_none() {
                match connect(&ctx, &config).await {
                    Ok(s) => session = Some(s),
                    Err(e) => {
                        tracing::warn!(account_id, error = %e, "body fetcher: connect failed");
                        break;
                    }
                }
            }
            let Some(s) = session.as_mut() else { break };
            match fetch_bodies_batch(&ctx, &config, s, &ids).await {
                Ok(()) => {
                    fetched = true;
                    break;
                }
                Err(e) => {
                    tracing::warn!(
                        account_id, attempt, error = %e,
                        "body fetcher: batch fetch failed; dropping session",
                    );
                    // The session may be broken; drop it so the retry (and any
                    // later request) reconnects.
                    if let Some(s) = session.take() {
                        imap::logout(s).await;
                    }
                }
            }
        }
        if !fetched {
            // Fetch didn't land. Roll body_state back to "none" for all so both
            // paths recover: a reopen re-nudges, and the bulk backfill (which
            // only scans body_state = 'none') can pick them up. Left at
            // "fetching" they would be stuck and the UI would show an endless
            // skeleton. No event is emitted here on purpose — invalidating the
            // open thread would make get_thread re-nudge immediately and, while
            // offline, spin a tight fail/retry loop.
            for message_id in ids {
                let _ = ctx
                    .db
                    .write(move |conn| repo::messages::set_body_state(conn, message_id, "none"))
                    .await;
            }
        }
    }
}

/// Fetch bodies for a set of messages, grouping by folder so each folder's UIDs
/// go out in a single batched FETCH. Idempotent: already-cached messages are
/// skipped, so a retry after a partial failure only refetches what's missing.
async fn fetch_bodies_batch(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    ids: &[i64],
) -> Result<()> {
    use std::collections::HashMap;
    // folder_id -> [(uid, message_id)]
    let mut by_folder: HashMap<i64, Vec<(u32, i64)>> = HashMap::new();
    for &message_id in ids {
        let row = ctx
            .db
            .read(move |conn| repo::messages::get_row(conn, message_id))
            .await?;
        let Some(row) = row else { continue };
        if row.body_state == "cached" {
            continue;
        }
        let (Some(folder_id), Some(uid)) = (row.folder_id, row.uid) else {
            continue;
        };
        by_folder
            .entry(folder_id)
            .or_default()
            .push((uid as u32, message_id));
    }

    for (folder_id, mut items) in by_folder {
        let folder = ctx
            .db
            .read(move |conn| repo::folders::get(conn, folder_id))
            .await?;
        let Some(folder) = folder else {
            // Folder row gone (deleted/renamed mid-flight): don't fail the whole
            // batch — just release these back to "none" for a later retry.
            reset_bodies_none(ctx, items.iter().map(|(_, m)| *m)).await;
            continue;
        };
        imap::select(session, &folder.imap_name).await?;
        items.sort_unstable_by_key(|(uid, _)| *uid);
        let uids: Vec<u32> = items.iter().map(|(u, _)| *u).collect();
        let set = imap::uid_set(&uids);
        let fetched: HashMap<u32, Vec<u8>> =
            imap::fetch_full_batch(session, &set).await?.into_iter().collect();
        for (uid, message_id) in items {
            match fetched.get(&uid) {
                // A single message deleted mid-fetch would FK-fail its persist;
                // keep that from aborting (and endlessly retrying) the whole
                // batch — log, release it, and move on.
                Some(raw) => {
                    if let Err(e) = persist_body(ctx, config, message_id, raw).await {
                        tracing::warn!(message_id, error = %e, "persist body failed; releasing");
                        reset_bodies_none(ctx, std::iter::once(message_id)).await;
                    }
                }
                None => {
                    // Message vanished from the server; roll back so a reopen or
                    // the backfill retries and expunge reconciliation cleans up.
                    reset_bodies_none(ctx, std::iter::once(message_id)).await;
                }
            }
        }
    }
    Ok(())
}

/// Best-effort reset of message body_state back to "none" (release for retry).
async fn reset_bodies_none(ctx: &SyncCtx, ids: impl Iterator<Item = i64>) {
    for message_id in ids {
        let _ = ctx
            .db
            .write(move |conn| repo::messages::set_body_state(conn, message_id, "none"))
            .await;
    }
}

async fn imap_credentials(ctx: &SyncCtx, config: &AccountConfig) -> Result<ImapCredentials> {
    match config.auth_kind {
        AuthKind::Password => {
            let password = credentials::load_async(config.id, Slot::Password).await?;
            Ok(ImapCredentials::Password {
                user: config.username.clone(),
                password,
            })
        }
        AuthKind::Oauth2 => {
            let token = ctx.tokens.access_token(config.id, config.provider).await?;
            Ok(ImapCredentials::XOAuth2 {
                user: config.username.clone(),
                access_token: token,
            })
        }
    }
}

async fn run_actor(
    ctx: SyncCtx,
    config: AccountConfig,
    mut rx: mpsc::UnboundedReceiver<SyncCmd>,
    pool_tx: mpsc::UnboundedSender<()>,
) {
    let account_id = config.id;
    tracing::debug!(account_id, "sync actor started");
    let mut session: Option<Session> = None;
    // Whether the current connection supports IMAP IDLE (push). Re-probed on
    // every reconnect; `None` until the first successful connect.
    let mut supports_idle: Option<bool> = None;
    let mut backoff_secs: u64 = 1;
    let mut cycle: u64 = 0;
    // When the next cycle is due; only read by the waits below (any wake-up
    // from a wait runs a cycle immediately).
    let mut cycle_due;

    loop {
        // 1. Ensure a connection.
        if session.is_none() {
            match connect(&ctx, &config).await {
                Ok(mut s) => {
                    // Probe IDLE support once per connection; on error assume
                    // no push and fall back to polling.
                    supports_idle = Some(imap::supports_idle(&mut s).await.unwrap_or(false));
                    tracing::info!(
                        account_id,
                        idle = supports_idle == Some(true),
                        "receive: connected; IDLE push {}",
                        if supports_idle == Some(true) { "enabled" } else { "unavailable, polling" },
                    );
                    session = Some(s);
                    backoff_secs = 1;
                    ctx.bus.emit(CoreEvent::NetworkState { online: true });
                    set_state(&ctx, account_id, "syncing").await;
                }
                Err(e @ (CoreError::NeedsReauth | CoreError::Auth(_))) => {
                    tracing::warn!(
                        account_id,
                        imap_host = %config.imap_host,
                        error = %e,
                        "imap connect rejected at auth; marking needs_reauth"
                    );
                    set_state(&ctx, account_id, "needs_reauth").await;
                    // Wait for an external nudge before retrying auth.
                    match rx.recv().await {
                        None | Some(SyncCmd::Shutdown) => return,
                        Some(_) => continue,
                    }
                }
                Err(e) => {
                    tracing::warn!(account_id, "imap connect failed: {e}");
                    ctx.bus.emit(CoreEvent::NetworkState { online: false });
                    set_state(&ctx, account_id, "offline").await;
                    // Backoff, but wake early on commands.
                    let wait = std::time::Duration::from_secs(backoff_secs);
                    backoff_secs = (backoff_secs * 2).min(300);
                    match tokio::time::timeout(wait, rx.recv()).await {
                        Ok(None) | Ok(Some(SyncCmd::Shutdown)) => return,
                        _ => continue,
                    }
                }
            }
        }
        let mut s = session.take().unwrap();

        // 2. Run one cycle; on IMAP errors drop the session and reconnect.
        // Bulk body downloads run on the backfill pool's own connections, so a
        // cycle is only folder/header/flag/action work and stays short.
        tracing::debug!(account_id, cycle, "sync cycle start");
        let cycle_result = run_cycle(&ctx, &config, &mut s, cycle, &pool_tx).await;
        tracing::debug!(
            account_id,
            cycle,
            ok = cycle_result.is_ok(),
            "sync cycle end"
        );
        // Pacing for the next cycle; also applies after errors so a flaky
        // server isn't hammered.
        cycle_due = tokio::time::Instant::now() + std::time::Duration::from_secs(CYCLE_SECS);
        match cycle_result {
            Ok(()) => {
                session = Some(s);
                cycle += 1;
                // Kick the backfill pool for any bodies the cycle uncovered and
                // reflect its remaining work in the account state.
                let (done, total) = ctx
                    .db
                    .read(move |conn| repo::messages::body_progress(conn, account_id))
                    .await
                    .unwrap_or((0, 0));
                if done < total {
                    let _ = pool_tx.send(());
                }
                set_state(
                    &ctx,
                    account_id,
                    if done < total { "syncing" } else { "idle" },
                )
                .await;
            }
            Err(CoreError::NeedsReauth) | Err(CoreError::Auth(_)) => {
                imap::logout(s).await;
                set_state(&ctx, account_id, "needs_reauth").await;
            }
            Err(e) => {
                tracing::warn!(account_id, "sync cycle error: {e}");
                imap::logout(s).await;
                ctx.bus.emit(CoreEvent::NetworkState { online: false });
            }
        }

        // 3. Wait for new mail (IDLE), the next cycle, or an immediate command.
        // The backfill pool drains bodies on its own connections, so the actor
        // is free to IDLE even while thousands of bodies are still downloading.
        let use_idle = supports_idle == Some(true) && session.is_some();

        if use_idle {
            // After a cycle the selected mailbox may be sent/drafts/etc, and
            // IDLE needs a selected mailbox, so re-SELECT the inbox first. v1
            // pushes on the inbox only; other folders arrive via the full cycle.
            let inbox = ctx
                .db
                .read(move |conn| repo::folders::by_role(conn, account_id, roles::INBOX))
                .await;
            match inbox {
                Ok(Some(inbox)) => {
                    let mut s = session.take().unwrap();
                    match imap::select(&mut s, &inbox.imap_name).await {
                        Ok(_) => {
                            // Cap IDLE at the next full cycle so the 60s
                            // correctness backstop is preserved (a message that
                            // slipped in just before IDLE started is still
                            // caught by the timed-out cycle), clamped to
                            // IDLE_MAX_SECS as an upper safety bound.
                            let max = cycle_due
                                .saturating_duration_since(tokio::time::Instant::now())
                                .min(std::time::Duration::from_secs(IDLE_MAX_SECS))
                                .max(std::time::Duration::from_secs(1));
                            tracing::info!(
                                account_id,
                                max_secs = max.as_secs(),
                                "receive: waiting in IDLE for new mail",
                            );
                            match imap::idle_wait(s, &mut rx, max).await {
                                Ok((s, outcome)) => {
                                    session = Some(s);
                                    match outcome {
                                        // New mail pushed by the server: fall
                                        // through, next iteration syncs now.
                                        imap::IdleOutcome::Activity => {
                                            tracing::info!(
                                                account_id,
                                                "receive: IDLE signaled activity, syncing now",
                                            );
                                        }
                                        // Backstop timeout or a sync/action
                                        // nudge: next iteration runs a cycle.
                                        imap::IdleOutcome::Timeout
                                        | imap::IdleOutcome::Command(SyncCmd::SyncNow)
                                        | imap::IdleOutcome::Command(SyncCmd::RunActions) => {}
                                        imap::IdleOutcome::Command(SyncCmd::FetchBody {
                                            message_id,
                                        }) => {
                                            if let Some(ref mut s) = session {
                                                if let Err(e) =
                                                    fetch_one_body(&ctx, &config, s, message_id).await
                                                {
                                                    tracing::warn!("priority body fetch failed: {e}");
                                                }
                                            }
                                        }
                                        imap::IdleOutcome::Command(SyncCmd::Shutdown)
                                        | imap::IdleOutcome::ChannelClosed => {
                                            if let Some(s) = session.take() {
                                                imap::logout(s).await;
                                            }
                                            return;
                                        }
                                    }
                                }
                                Err(e) => {
                                    // Session was consumed by idle_wait; drop
                                    // IDLE state and reconnect next iteration.
                                    tracing::warn!(account_id, "idle failed: {e}");
                                    supports_idle = None;
                                    ctx.bus.emit(CoreEvent::NetworkState { online: false });
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(account_id, "select inbox for idle failed: {e}");
                            imap::logout(s).await;
                            supports_idle = None;
                        }
                    }
                }
                _ => {
                    // No inbox row yet (first onboarding): short wait, then run
                    // a full cycle so the inbox lands promptly.
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(IDLE_FALLBACK_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(None) | Ok(Some(SyncCmd::Shutdown)) => {
                            if let Some(s) = session.take() {
                                imap::logout(s).await;
                            }
                            return;
                        }
                        _ => {}
                    }
                }
            }
        } else {
            // Poll path: server without IDLE (or no live session). Non-IDLE
            // servers poll every IDLE_FALLBACK_SECS; on that timer firing we
            // force a full cycle so the shorter poll actually detects new mail.
            let fallback = supports_idle == Some(false);
            let mut deadline = if fallback {
                tokio::time::Instant::now() + std::time::Duration::from_secs(IDLE_FALLBACK_SECS)
            } else {
                cycle_due
            };
            loop {
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Err(_) => {
                        // Timer fired: next iteration runs a full cycle.
                        break;
                    }
                    Ok(None) | Ok(Some(SyncCmd::Shutdown)) => {
                        if let Some(s) = session.take() {
                            imap::logout(s).await;
                        }
                        return;
                    }
                    Ok(Some(SyncCmd::SyncNow)) | Ok(Some(SyncCmd::RunActions)) => {
                        // Commands need a full cycle (folder sync / action replay).
                        break;
                    }
                    Ok(Some(SyncCmd::FetchBody { message_id })) => {
                        if let Some(ref mut s) = session {
                            if let Err(e) = fetch_one_body(&ctx, &config, s, message_id).await {
                                tracing::warn!("priority body fetch failed: {e}");
                                deadline = tokio::time::Instant::now();
                            }
                        } else {
                            break;
                        }
                    }
                }
            }
        }
    }
}

async fn set_state(ctx: &SyncCtx, account_id: i64, state: &str) {
    let st = state.to_string();
    let _ = ctx
        .db
        .write(move |conn| repo::accounts::set_sync_state(conn, account_id, &st))
        .await;
    ctx.bus.emit(CoreEvent::AccountState {
        account_id,
        sync_state: state.to_string(),
    });
}

async fn connect(ctx: &SyncCtx, config: &AccountConfig) -> Result<Session> {
    let creds = imap_credentials(ctx, config).await?;
    imap::connect(&config.imap_host, config.imap_port, creds).await
}

/// One sync cycle: replay queued actions, then sync every folder's headers,
/// flags, and expunges. Bulk bodies are NOT fetched here — the backfill pool
/// downloads them concurrently on its own connections; this only nudges it.
async fn run_cycle(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    cycle: u64,
    pool_tx: &mpsc::UnboundedSender<()>,
) -> Result<()> {
    let account_id = config.id;

    // Folder discovery: first cycle and then every ~30 cycles.
    if cycle % 30 == 0 {
        discover_folders(ctx, config, session).await?;
    }

    // Execute queued offline actions first - user intent outranks sync.
    queue::execute_due(ctx, config, session).await?;

    let folders = {
        let acc = account_id;
        ctx.db
            .read(move |conn| repo::folders::list(conn, Some(acc)))
            .await?
    };

    // Sync order: inbox first, then sent/drafts, then the rest.
    let mut ordered: Vec<&Folder> = folders.iter().collect();
    ordered.sort_by_key(|f| match f.role.as_deref() {
        Some(roles::INBOX) => 0,
        Some(roles::SENT) => 1,
        Some(roles::DRAFTS) => 2,
        Some(roles::ARCHIVE) => 3,
        _ => 4,
    });

    for folder in ordered {
        if folder.role.as_deref() == Some(roles::ALL) && config.provider != Provider::Gmail {
            continue;
        }
        // Non-inbox folders get new-mail checks every cycle but heavy
        // reconciliation (flags/expunge) only every 5th cycle.
        let heavy = folder.role.as_deref() == Some(roles::INBOX) || cycle % 5 == 0;
        let first_time = folder.backfill_cursor.is_none();
        if let Err(e) = sync_folder(ctx, config, session, folder, heavy).await {
            tracing::warn!(folder = %folder.imap_name, "folder sync failed: {e}");
            return Err(e); // connection likely broken; reconnect
        }
        // Right after the inbox lands for the first time, kick the body pool
        // so recent mail becomes readable within seconds of onboarding, while
        // this connection keeps syncing the remaining folders' headers.
        if first_time && folder.role.as_deref() == Some(roles::INBOX) {
            let _ = pool_tx.send(());
        }
    }

    // GC old finished actions (keep 7 days).
    let _ = ctx
        .db
        .write(move |conn| repo::actions::gc(conn, now_ms() - 7 * 24 * 3600 * 1000))
        .await;

    Ok(())
}

async fn discover_folders(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
) -> Result<()> {
    let account_id = config.id;
    ctx.bus.emit(CoreEvent::SyncProgress(SyncProgress {
        account_id,
        folder: String::new(),
        phase: "folders".into(),
        done: 0,
        total: 0,
    }));
    let remote = imap::list_folders(session).await?;
    ctx.db
        .write(move |conn| {
            for rf in &remote {
                let role = crate::sync::folder_map::detect_role(rf);
                if !crate::sync::folder_map::should_sync(rf, role) {
                    continue;
                }
                repo::folders::upsert(conn, account_id, &rf.name, rf.delimiter.as_deref(), role)?;
            }
            Ok(())
        })
        .await
}

async fn sync_folder(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    folder: &Folder,
    heavy: bool,
) -> Result<()> {
    let account_id = config.id;
    let selected = imap::select(session, &folder.imap_name).await?;

    // UIDVALIDITY handling.
    if let (Some(stored), Some(remote)) = (folder.uidvalidity, selected.uid_validity) {
        if stored != remote {
            tracing::warn!(folder = %folder.imap_name, "UIDVALIDITY changed; resetting uid map");
            let fid = folder.id;
            ctx.db
                .write(move |conn| repo::folders::reset_uid_mappings(conn, fid))
                .await?;
        }
    }
    {
        let (fid, uv, un) = (folder.id, selected.uid_validity, selected.uid_next);
        ctx.db
            .write(move |conn| repo::folders::set_uid_state(conn, fid, uv, un, None))
            .await?;
    }

    let fresh_folder = {
        let fid = folder.id;
        ctx.db
            .read(move |conn| repo::folders::get(conn, fid))
            .await?
            .ok_or_else(|| CoreError::NotFound("folder".into()))?
    };

    if fresh_folder.backfill_cursor.is_none() {
        initial_backfill(ctx, config, session, &fresh_folder).await?;
    } else {
        // New mail since last seen UID.
        let last_seen = fresh_folder.last_seen_uid.max(0) as u32;
        let uid_next = selected.uid_next.unwrap_or(i64::MAX);
        if (last_seen as i64) + 1 < uid_next {
            let set = format!("{}:*", last_seen + 1);
            let headers = imap::fetch_headers(session, &set).await?;
            let new: Vec<FetchedHeader> =
                headers.into_iter().filter(|h| h.uid > last_seen).collect();
            if !new.is_empty() {
                tracing::info!(
                    account_id,
                    folder = %folder.imap_name,
                    count = new.len(),
                    since_uid = last_seen,
                    "receive: new mail on server",
                );
                let thread_ids = store_headers(ctx, config, &fresh_folder, new, true).await?;
                if fresh_folder.role.as_deref() == Some(roles::INBOX) && !thread_ids.is_empty() {
                    ctx.bus.emit(CoreEvent::MailNew {
                        account_id,
                        thread_ids,
                    });
                }
            }
        }
        if heavy {
            reconcile_flags(ctx, session, &fresh_folder).await?;
            reconcile_expunges(ctx, session, &fresh_folder).await?;
        }
        // Historical backfill: extend the window downward.
        if !fresh_folder.backfill_done {
            extend_history(ctx, config, session, &fresh_folder).await?;
        }
    }
    Ok(())
}

async fn initial_backfill(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    folder: &Folder,
) -> Result<()> {
    let account_id = config.id;
    let since = chrono::Utc::now().date_naive() - chrono::Duration::days(BACKFILL_DAYS);
    let uids = imap::uid_search_since(session, since).await?;

    // Resume support: a previous run may have died partway (flaky server, app
    // quit) — skip UIDs whose headers already landed so a restart only fetches
    // what's missing instead of re-downloading the whole window every time.
    let existing: std::collections::HashSet<i64> = {
        let fid = folder.id;
        ctx.db
            .read(move |conn| repo::messages::uids_in_folder(conn, fid))
            .await?
            .into_iter()
            .map(|(_, uid)| uid)
            .collect()
    };
    let missing: Vec<u32> = uids
        .iter()
        .copied()
        .filter(|u| !existing.contains(&(*u as i64)))
        .collect();
    let total = missing.len() as u64;
    let mut done: u64 = 0;

    // Newest chunks first: the top of the inbox fills in immediately instead
    // of after the whole window has downloaded.
    for chunk in missing.chunks(HEADER_CHUNK).rev() {
        let set = imap::uid_set(chunk);
        if set.is_empty() {
            continue;
        }
        let headers = imap::fetch_headers(session, &set).await?;
        done += headers.len() as u64;
        let thread_ids = store_headers(ctx, config, folder, headers, false).await?;
        if !thread_ids.is_empty() {
            // Let the UI fill in live while the backfill runs.
            ctx.bus.emit(CoreEvent::MailUpdated { thread_ids });
        }
        // Checkpoint after every chunk. Chunks run newest-first, so everything
        // from this chunk's lowest UID upward is stored; recording it as the
        // backfill cursor means a dropped connection or app restart resumes
        // from here via the incremental path (extend_history walks on down)
        // instead of restarting the whole window. Before this checkpoint
        // existed, a server that reset connections mid-backfill (Office 365
        // throttling) made every launch re-sync thousands of headers forever.
        let ck = chunk.first().copied().unwrap_or(1) as i64;
        let fid = folder.id;
        ctx.db
            .write(move |conn| repo::folders::set_backfill(conn, fid, Some(ck), ck <= 1))
            .await?;
        ctx.bus.emit(CoreEvent::SyncProgress(SyncProgress {
            account_id,
            folder: folder.imap_name.clone(),
            phase: "headers".into(),
            done,
            total,
        }));
    }

    // Record where the synced window starts, so history can extend below it.
    let min_uid = uids.first().copied().unwrap_or(1) as i64;
    let max_uid = uids.last().copied().unwrap_or(0) as i64;
    let fid = folder.id;
    ctx.db
        .write(move |conn| {
            repo::folders::set_backfill(conn, fid, Some(min_uid), min_uid <= 1)?;
            repo::folders::set_last_seen_uid(conn, fid, max_uid)
        })
        .await?;
    Ok(())
}

async fn extend_history(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    folder: &Folder,
) -> Result<()> {
    let Some(cursor) = folder.backfill_cursor else {
        return Ok(());
    };
    if cursor <= 1 {
        let fid = folder.id;
        ctx.db
            .write(move |conn| repo::folders::set_backfill(conn, fid, Some(1), true))
            .await?;
        return Ok(());
    }
    let hi = (cursor - 1).max(1) as u32;
    let lo = hi.saturating_sub(HISTORY_CHUNK - 1).max(1);
    let set = format!("{lo}:{hi}");
    let headers = imap::fetch_headers(session, &set).await?;
    let thread_ids = store_headers(ctx, config, folder, headers, false).await?;
    if !thread_ids.is_empty() {
        ctx.bus.emit(CoreEvent::MailUpdated { thread_ids });
    }
    let fid = folder.id;
    let new_cursor = lo as i64;
    ctx.db
        .write(move |conn| {
            repo::folders::set_backfill(conn, fid, Some(new_cursor), new_cursor <= 1)
        })
        .await?;
    ctx.bus.emit(CoreEvent::SyncProgress(SyncProgress {
        account_id: config.id,
        folder: folder.imap_name.clone(),
        phase: "history".into(),
        done: 0,
        total: 0,
    }));
    Ok(())
}

/// Insert fetched headers. Returns affected thread ids (new messages only).
async fn store_headers(
    ctx: &SyncCtx,
    config: &AccountConfig,
    folder: &Folder,
    headers: Vec<FetchedHeader>,
    _notify: bool,
) -> Result<Vec<i64>> {
    if headers.is_empty() {
        return Ok(Vec::new());
    }
    let account_id = config.id;
    let account_email = config.email.to_lowercase();
    let folder_id = folder.id;
    let folder_role = folder.role.clone();

    ctx.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let auto_labels = repo::settings::get(&tx)?.auto_labels_enabled;
            let mut thread_ids: Vec<i64> = Vec::new();
            let mut max_uid: i64 = 0;
            let mut inserted = 0u32;

            for fh in &headers {
                max_uid = max_uid.max(fh.uid as i64);

                // Already have this UID?
                if repo::messages::by_folder_uid(&tx, folder_id, fh.uid as i64)?.is_some() {
                    continue;
                }

                let parsed = match crate::mime::parse_header_block(&fh.header_bytes) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                // Dedupe: same Message-ID already stored (e.g. our own sent
                // message APPENDed earlier, or Gmail label duplication).
                if let Some(mid) = &parsed.message_id {
                    if let Some(existing) = repo::messages::by_message_id(&tx, account_id, mid)? {
                        if existing.uid.is_none() {
                            repo::messages::set_uid_and_folder(
                                &tx,
                                existing.id,
                                folder_id,
                                Some(fh.uid as i64),
                            )?;
                        }
                        continue;
                    }
                }

                let date_ms = parsed
                    .date_ms
                    .or(fh.internal_date_ms)
                    .unwrap_or_else(now_ms);

                let from_email = parsed
                    .from
                    .as_ref()
                    .map(|a| a.email.to_lowercase())
                    .unwrap_or_default();
                let is_outgoing =
                    from_email == account_email || folder_role.as_deref() == Some(roles::SENT);

                let thread_id =
                    crate::sync::threading::resolve_thread(&tx, account_id, &parsed, date_ms)?;

                let nm = NewMessage {
                    account_id,
                    folder_id,
                    uid: Some(fh.uid as i64),
                    message_id: parsed.message_id.clone(),
                    gm_msgid: None,
                    gm_thrid: None,
                    subject: parsed.subject.clone(),
                    from: parsed.from.clone(),
                    to: parsed.to.clone(),
                    cc: parsed.cc.clone(),
                    bcc: parsed.bcc.clone(),
                    date: date_ms,
                    internal_date: fh.internal_date_ms,
                    is_read: fh.flags.seen || is_outgoing,
                    is_starred: fh.flags.flagged,
                    is_draft: fh.flags.draft || folder_role.as_deref() == Some(roles::DRAFTS),
                    is_outgoing,
                    is_automated: parsed.is_automated,
                    has_attachments: fh.has_attachments,
                    size: fh.size.map(|s| s as i64),
                    snippet: String::new(),
                    references: parsed.references.clone(),
                    list_unsubscribe: parsed.list_unsubscribe.clone(),
                    sender_addr: parsed.via.clone(),
                };
                let msg_id = repo::messages::insert(&tx, &nm, thread_id)?;
                inserted += 1;
                repo::labels::reconcile_keywords(&tx, msg_id, &fh.flags.keywords)?;
                if auto_labels && !is_outgoing && !nm.is_draft {
                    let facts = crate::autolabel::MessageFacts {
                        from_addr: &from_email,
                        subject: &parsed.subject,
                        is_automated: parsed.is_automated,
                        has_list_headers: parsed.list_unsubscribe.is_some(),
                        sender_known: crate::autolabel::sender_known(&tx, &from_email),
                    };
                    crate::autolabel::apply(&tx, msg_id, &facts)?;
                }
                repo::threads::recompute(&tx, thread_id)?;
                repo::search::index_message(&tx, msg_id)?;

                // Harvest contacts.
                let when = date_ms;
                if is_outgoing {
                    for a in parsed.to.iter().chain(parsed.cc.iter()) {
                        repo::contacts::harvest(&tx, a, true, when)?;
                    }
                } else if let Some(from) = &parsed.from {
                    repo::contacts::harvest(&tx, from, false, when)?;
                }

                if !thread_ids.contains(&thread_id) {
                    thread_ids.push(thread_id);
                }
            }

            if max_uid > 0 {
                repo::folders::set_last_seen_uid(&tx, folder_id, max_uid)?;
            }
            tx.commit()?;
            if inserted > 0 {
                tracing::info!(
                    account_id,
                    folder = %folder_role.as_deref().unwrap_or("?"),
                    fetched = headers.len(),
                    inserted,
                    threads = thread_ids.len(),
                    "receive: stored new message headers",
                );
            }
            Ok(thread_ids)
        })
        .await
}

/// Reconcile read/star flags for the most recent window of UIDs.
async fn reconcile_flags(ctx: &SyncCtx, session: &mut Session, folder: &Folder) -> Result<()> {
    let folder_id = folder.id;
    let max_uid = ctx
        .db
        .read(move |conn| repo::messages::max_uid_in_folder(conn, folder_id))
        .await?;
    if max_uid == 0 {
        return Ok(());
    }
    let lo = (max_uid - FLAG_WINDOW).max(1);
    let set = format!("{lo}:{max_uid}");
    let remote_flags = imap::fetch_flags(session, &set).await?;

    let changed = ctx
        .db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let mut changed_threads: Vec<i64> = Vec::new();
            for (uid, flags) in &remote_flags {
                if let Some(row) = repo::messages::by_folder_uid(&tx, folder_id, *uid as i64)? {
                    // Local pending intent wins over remote state.
                    if repo::actions::has_pending_for_message(&tx, row.id)? {
                        continue;
                    }
                    let flags_changed =
                        row.is_read != flags.seen || row.is_starred != flags.flagged;
                    if flags_changed {
                        repo::messages::set_flags(&tx, row.id, flags.seen, flags.flagged)?;
                    }
                    let labels_changed =
                        repo::labels::reconcile_keywords(&tx, row.id, &flags.keywords)?;
                    if flags_changed || labels_changed {
                        if let Some(tid) = row.thread_id {
                            repo::threads::recompute(&tx, tid)?;
                            if !changed_threads.contains(&tid) {
                                changed_threads.push(tid);
                            }
                        }
                    }
                }
            }
            tx.commit()?;
            Ok(changed_threads)
        })
        .await?;

    if !changed.is_empty() {
        ctx.bus.emit(CoreEvent::MailUpdated {
            thread_ids: changed,
        });
    }
    Ok(())
}

/// Remove local messages whose UIDs vanished from the server (within the
/// synced window).
async fn reconcile_expunges(ctx: &SyncCtx, session: &mut Session, folder: &Folder) -> Result<()> {
    let remote_uids = imap::uid_search_all(session).await?;
    let folder_id = folder.id;
    let cursor = folder.backfill_cursor.unwrap_or(i64::MAX);

    let changed = ctx
        .db
        .write(move |conn| {
            let remote: std::collections::HashSet<i64> =
                remote_uids.iter().map(|u| *u as i64).collect();
            let local = repo::messages::uids_in_folder(conn, folder_id)?;
            let tx = conn.transaction()?;
            let mut changed_threads: Vec<i64> = Vec::new();
            for (id, uid) in local {
                if uid >= cursor && !remote.contains(&uid) {
                    if let Some(row) = repo::messages::get_row(&tx, id)? {
                        // Skip if a pending action is mid-flight for it (a
                        // local move produces exactly this state).
                        if repo::actions::has_pending_for_message(&tx, id)? {
                            continue;
                        }
                        repo::messages::delete(&tx, id)?;
                        if let Some(tid) = row.thread_id {
                            repo::threads::recompute(&tx, tid)?;
                            if !changed_threads.contains(&tid) {
                                changed_threads.push(tid);
                            }
                        }
                    }
                }
            }
            tx.commit()?;
            Ok(changed_threads)
        })
        .await?;

    if !changed.is_empty() {
        ctx.bus.emit(CoreEvent::MailUpdated {
            thread_ids: changed,
        });
    }
    Ok(())
}

/// One unit of backfill-pool work: a single folder's chunk of UIDs, pulled in
/// one batched FETCH.
struct BodyChunk {
    folder_name: String,
    /// (message_id, uid) pairs.
    items: Vec<(i64, i64)>,
}

/// Background body backfill. Waits for a nudge from the sync actor (headers
/// just landed) or a periodic backstop tick, then drains every missing body
/// for the account with up to BODY_POOL_CONNS concurrent IMAP connections.
/// Runs beside the main actor, so folder/header sync, IDLE, and offline
/// actions never wait behind bulk body downloads. Exits when the account
/// handle is dropped (the nudge channel closes).
async fn run_backfill_pool(
    ctx: SyncCtx,
    config: AccountConfig,
    mut rx: mpsc::UnboundedReceiver<()>,
) {
    let account_id = config.id;
    loop {
        if let Ok(None) =
            tokio::time::timeout(std::time::Duration::from_secs(CYCLE_SECS), rx.recv()).await
        {
            return; // channel closed: account removed / shutdown
        }
        // Coalesce nudges that piled up while the previous drain ran.
        while rx.try_recv().is_ok() {}
        if let Err(e) = drain_missing_bodies(&ctx, &config).await {
            tracing::warn!(account_id, error = %e, "body backfill: drain failed");
        }
    }
}

/// Fetch ALL missing bodies for the account, inbox first, by handing
/// folder-grouped chunks to a shared queue serviced by up to BODY_POOL_CONNS
/// parallel connections. Loops until a scan finds nothing left; bails out when
/// a full round makes no forward progress (server unreachable, or every
/// remaining UID vanished) so it can't spin — the next nudge or backstop tick
/// retries.
async fn drain_missing_bodies(ctx: &SyncCtx, config: &AccountConfig) -> Result<()> {
    use std::collections::{HashSet, VecDeque};
    use std::sync::atomic::{AtomicU64, Ordering};

    let account_id = config.id;
    // Message ids attempted this drain whose bodies the server didn't return
    // (expunged mid-sync): skipped for the rest of the drain so it terminates;
    // expunge reconciliation removes the rows.
    let skip: Arc<std::sync::Mutex<HashSet<i64>>> = Arc::default();
    let mut did_work = false;

    loop {
        let folders = ctx
            .db
            .read(move |conn| repo::folders::list(conn, Some(account_id)))
            .await?;
        let mut ordered: Vec<&Folder> = folders.iter().collect();
        ordered.sort_by_key(|f| match f.role.as_deref() {
            Some(roles::INBOX) => 0,
            Some(roles::SENT) => 1,
            _ => 2,
        });

        let mut chunks: VecDeque<BodyChunk> = VecDeque::new();
        for folder in ordered {
            let fid = folder.id;
            let missing = ctx
                .db
                .read(move |conn| repo::messages::missing_bodies(conn, fid, i64::MAX))
                .await?;
            let missing: Vec<(i64, i64)> = {
                let skip = skip.lock().unwrap();
                missing
                    .into_iter()
                    .filter(|(mid, _)| !skip.contains(mid))
                    .collect()
            };
            for chunk in missing.chunks(BODY_FETCH_CHUNK) {
                chunks.push_back(BodyChunk {
                    folder_name: folder.imap_name.clone(),
                    items: chunk.to_vec(),
                });
            }
        }

        if chunks.is_empty() {
            if did_work {
                tracing::info!(account_id, "body backfill: drained");
                set_state(ctx, account_id, "idle").await;
            }
            return Ok(());
        }
        did_work = true;
        set_state(ctx, account_id, "syncing").await;
        tracing::debug!(
            account_id,
            chunks = chunks.len(),
            "body backfill: starting round"
        );

        // Fan the queue out to a pool of connections. Each worker owns its own
        // session and pops chunks until the queue is empty or its connection
        // breaks, so a slow chunk never stalls the others. Office 365 throttles
        // concurrent IMAP FETCH streams hard (it resets extra connections), so
        // it gets a smaller pool — more workers there just die and burn
        // reconnect round-trips.
        let cap = match config.provider {
            Provider::Microsoft => 2,
            _ => BODY_POOL_CONNS,
        };
        let workers = cap.min(chunks.len());
        let queue = Arc::new(tokio::sync::Mutex::new(chunks));
        let persisted = Arc::new(AtomicU64::new(0));
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(tokio::spawn(body_worker(
                ctx.clone(),
                config.clone(),
                queue.clone(),
                skip.clone(),
                persisted.clone(),
            )));
        }
        for h in handles {
            let _ = h.await;
        }
        if persisted.load(Ordering::Relaxed) == 0 {
            return Err(CoreError::Imap(
                "body backfill made no progress; will retry".into(),
            ));
        }
        // Re-scan: headers that landed while this round ran get picked up too.
    }
}

/// One backfill-pool connection: pops chunks off the shared queue until it is
/// empty or the connection breaks. On error the chunk goes back on the queue
/// for the surviving workers (or the next round).
async fn body_worker(
    ctx: SyncCtx,
    config: AccountConfig,
    queue: Arc<tokio::sync::Mutex<std::collections::VecDeque<BodyChunk>>>,
    skip: Arc<std::sync::Mutex<std::collections::HashSet<i64>>>,
    persisted: Arc<std::sync::atomic::AtomicU64>,
) {
    let account_id = config.id;
    let mut session = match connect(&ctx, &config).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(account_id, error = %e, "body worker: connect failed");
            return;
        }
    };
    let mut selected: Option<String> = None;
    loop {
        let chunk = queue.lock().await.pop_front();
        let Some(chunk) = chunk else { break };
        match fetch_body_chunk(&ctx, &config, &mut session, &mut selected, &chunk, &skip).await {
            Ok(n) => {
                persisted.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
                // Live "Sync x/total": one COUNT per chunk, not per message.
                let (done, total) = ctx
                    .db
                    .read(move |conn| repo::messages::body_progress(conn, account_id))
                    .await
                    .unwrap_or((0, 0));
                ctx.bus.emit(CoreEvent::SyncProgress(SyncProgress {
                    account_id,
                    folder: chunk.folder_name.clone(),
                    phase: "bodies".into(),
                    done,
                    total,
                }));
            }
            Err(e) => {
                tracing::warn!(account_id, error = %e, "body worker: chunk failed; stopping");
                queue.lock().await.push_front(chunk);
                // Connection presumed broken; dropping the session closes it.
                return;
            }
        }
    }
    imap::logout(session).await;
}

/// Fetch one chunk's bodies over `session` and persist them. Returns how many
/// bodies were cached. UIDs the server didn't return have vanished; they go
/// into `skip` so the drain terminates (expunge reconciliation drops the rows).
async fn fetch_body_chunk(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    selected: &mut Option<String>,
    chunk: &BodyChunk,
    skip: &std::sync::Mutex<std::collections::HashSet<i64>>,
) -> Result<u64> {
    if selected.as_deref() != Some(chunk.folder_name.as_str()) {
        imap::select(session, &chunk.folder_name).await?;
        *selected = Some(chunk.folder_name.clone());
    }
    let mut uids: Vec<u32> = chunk.items.iter().map(|&(_, uid)| uid as u32).collect();
    uids.sort_unstable();
    let by_uid: std::collections::HashMap<u32, i64> = chunk
        .items
        .iter()
        .map(|&(mid, uid)| (uid as u32, mid))
        .collect();
    let bodies = imap::fetch_full_batch(session, &imap::uid_set(&uids)).await?;

    let mut cached = 0u64;
    let mut returned: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for (uid, raw) in bodies {
        let Some(&message_id) = by_uid.get(&uid) else {
            continue;
        };
        persist_body(ctx, config, message_id, &raw).await?;
        returned.insert(uid);
        cached += 1;
    }
    let mut skip = skip.lock().unwrap();
    for &(mid, uid) in &chunk.items {
        if !returned.contains(&(uid as u32)) {
            skip.insert(mid);
        }
    }
    Ok(cached)
}

/// Priority fetch of a single message body (user opened it).
async fn fetch_one_body(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    message_id: i64,
) -> Result<()> {
    let row = ctx
        .db
        .read(move |conn| repo::messages::get_row(conn, message_id))
        .await?
        .ok_or_else(|| CoreError::NotFound("message".into()))?;
    if row.body_state == "cached" {
        return Ok(());
    }
    let (Some(folder_id), Some(uid)) = (row.folder_id, row.uid) else {
        return Ok(());
    };
    let folder = ctx
        .db
        .read(move |conn| repo::folders::get(conn, folder_id))
        .await?
        .ok_or_else(|| CoreError::NotFound("folder".into()))?;
    imap::select(session, &folder.imap_name).await?;
    store_one_body(ctx, config, session, message_id, uid as u32).await
}

async fn store_one_body(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    message_id: i64,
    uid: u32,
) -> Result<()> {
    let Some(raw) = imap::fetch_full(session, uid).await? else {
        // Message vanished; expunge reconciliation will clean up.
        return Ok(());
    };
    persist_body(ctx, config, message_id, &raw).await
}

/// Parse one already-fetched raw message, persist it to disk + DB, and notify
/// the UI. Shared by the single-body path and the bulk backfill.
async fn persist_body(
    ctx: &SyncCtx,
    config: &AccountConfig,
    message_id: i64,
    raw: &[u8],
) -> Result<()> {
    // Persist raw MIME to disk.
    let dir = ctx.paths.mail_dir(config.id);
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{message_id}.eml"));
    tokio::fs::write(&path, raw).await?;
    let path_str = path.to_string_lossy().to_string();

    let parsed = crate::mime::parse_message(raw)?;
    let config_id = config.id;
    let thread_id = ctx
        .db
        .write(move |conn| {
            let tx = conn.transaction()?;
            repo::messages::store_body(
                &tx,
                message_id,
                parsed.text.as_deref(),
                parsed.html.as_deref(),
                Some(&path_str),
                // Real files only, mirroring BODYSTRUCTURE's disposition check
                // and the message-card footer (both ignore inline images), so
                // the list paperclip stays consistent before and after backfill.
                parsed.attachments.iter().any(|a| !a.is_inline),
                Some(&parsed.snippet),
            )?;
            let atts: Vec<repo::messages::NewAttachment> = parsed
                .attachments
                .iter()
                .map(|a| repo::messages::NewAttachment {
                    message_id,
                    part_id: Some(a.part_id.as_str()),
                    filename: a.filename.as_deref(),
                    mime_type: a.mime_type.as_deref(),
                    size: Some(a.size),
                    content_id: a.content_id.as_deref(),
                    is_inline: a.is_inline,
                })
                .collect();
            repo::messages::replace_attachments(&tx, message_id, &atts)?;
            repo::search::index_message(&tx, message_id)?;
            for ics in &parsed.calendar_parts {
                for ev in crate::calendar::parse_ics(ics) {
                    repo::calendar::upsert(&tx, config_id, message_id, &ev)?;
                }
            }
            let tid: Option<i64> =
                repo::messages::get_row(&tx, message_id)?.and_then(|r| r.thread_id);
            if let Some(tid) = tid {
                repo::threads::recompute(&tx, tid)?;
            }
            tx.commit()?;
            Ok(tid)
        })
        .await?;

    if let Some(tid) = thread_id {
        ctx.bus.emit(CoreEvent::MailUpdated {
            thread_ids: vec![tid],
        });
    }
    Ok(())
}
