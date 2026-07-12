//! Per-account sync actor. One IMAP connection per account runs a cycle loop:
//! drain commands -> execute due pending actions -> sync folders (new mail,
//! flags, expunges) -> fetch missing bodies -> extend historical backfill.
//!
//! v1 uses short poll cycles (60s) instead of IMAP IDLE: correctness never
//! depends on push, and commands (body fetches, action nudges) interrupt the
//! wait immediately because the loop selects on the command channel.

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
const BODIES_PER_CYCLE: i64 = 30;
const HISTORY_CHUNK: u32 = 500;
const CYCLE_SECS: u64 = 60;
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
}

impl AccountHandle {
    pub fn send(&self, cmd: SyncCmd) {
        let _ = self.tx.send(cmd);
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
    let handle = AccountHandle {
        account_id: config.id,
        tx,
    };
    tokio::spawn(run_actor(ctx, config, rx));
    handle
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

async fn run_actor(ctx: SyncCtx, config: AccountConfig, mut rx: mpsc::UnboundedReceiver<SyncCmd>) {
    let account_id = config.id;
    tracing::debug!(account_id, "sync actor started");
    let mut session: Option<Session> = None;
    let mut backoff_secs: u64 = 1;
    let mut cycle: u64 = 0;

    loop {
        // 1. Ensure a connection.
        if session.is_none() {
            match connect(&ctx, &config).await {
                Ok(s) => {
                    session = Some(s);
                    backoff_secs = 1;
                    ctx.bus.emit(CoreEvent::NetworkState { online: true });
                    set_state(&ctx, account_id, "syncing").await;
                }
                Err(CoreError::NeedsReauth) | Err(CoreError::Auth(_)) => {
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

        // 2. Run one full cycle; on IMAP errors drop the session and reconnect.
        tracing::debug!(account_id, cycle, "sync cycle start");
        let cycle_result = run_cycle(&ctx, &config, &mut s, cycle).await;
        tracing::debug!(
            account_id,
            cycle,
            ok = cycle_result.is_ok(),
            "sync cycle end"
        );
        match cycle_result {
            Ok(()) => {
                session = Some(s);
                set_state(&ctx, account_id, "idle").await;
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
        cycle += 1;

        // 3. Wait for the next cycle or an immediate command.
        let mut deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(CYCLE_SECS);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Err(_) => break, // cycle timer fired
                Ok(None) | Ok(Some(SyncCmd::Shutdown)) => {
                    if let Some(s) = session.take() {
                        imap::logout(s).await;
                    }
                    return;
                }
                Ok(Some(SyncCmd::SyncNow)) | Ok(Some(SyncCmd::RunActions)) => break,
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

async fn run_cycle(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    cycle: u64,
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
        if let Err(e) = sync_folder(ctx, config, session, folder, heavy).await {
            tracing::warn!(folder = %folder.imap_name, "folder sync failed: {e}");
            return Err(e); // connection likely broken; reconnect
        }
    }

    // Body backfill for the inbox first, then everything else.
    fetch_missing_bodies(ctx, config, session).await?;

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
    let total = uids.len() as u64;
    let mut done: u64 = 0;

    for chunk in uids.chunks(HEADER_CHUNK) {
        let set = imap::uid_set(chunk);
        if set.is_empty() {
            continue;
        }
        let headers = imap::fetch_headers(session, &set).await?;
        done += headers.len() as u64;
        store_headers(ctx, config, folder, headers, false).await?;
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
    store_headers(ctx, config, folder, headers, false).await?;
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
                    has_attachments: false,
                    size: fh.size.map(|s| s as i64),
                    snippet: String::new(),
                    references: parsed.references.clone(),
                    list_unsubscribe: parsed.list_unsubscribe.clone(),
                };
                let msg_id = repo::messages::insert(&tx, &nm, thread_id)?;
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
                    let flags_changed = row.is_read != flags.seen || row.is_starred != flags.flagged;
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

async fn fetch_missing_bodies(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
) -> Result<()> {
    let account_id = config.id;
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

    let mut budget = BODIES_PER_CYCLE;
    for folder in ordered {
        if budget <= 0 {
            break;
        }
        let fid = folder.id;
        let missing = ctx
            .db
            .read(move |conn| repo::messages::missing_bodies(conn, fid, BODIES_PER_CYCLE))
            .await?;
        if missing.is_empty() {
            continue;
        }
        imap::select(session, &folder.imap_name).await?;
        for (message_id, uid) in missing {
            if budget <= 0 {
                break;
            }
            budget -= 1;
            store_one_body(ctx, config, session, message_id, uid as u32).await?;
        }
        ctx.bus.emit(CoreEvent::SyncProgress(SyncProgress {
            account_id,
            folder: folder.imap_name.clone(),
            phase: "bodies".into(),
            done: 0,
            total: 0,
        }));
    }
    Ok(())
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

    // Persist raw MIME to disk.
    let dir = ctx.paths.mail_dir(config.id);
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{message_id}.eml"));
    tokio::fs::write(&path, &raw).await?;
    let path_str = path.to_string_lossy().to_string();

    let parsed = crate::mime::parse_message(&raw)?;
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
                !parsed.attachments.is_empty(),
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
