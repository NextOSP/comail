//! comail-core: all email logic, no Tauri dependency. The host embeds `Core`,
//! calls its async methods, and forwards `CoreEvent`s to the UI.

pub mod accounts;
pub mod ai;
pub mod autolabel;
pub mod caldav;
pub mod calendar;
pub mod config;
pub mod db;
pub mod embed;
pub mod error;
pub mod events;
pub mod imap;
pub mod mime;
pub mod models;
pub mod oauth;
pub mod preview;
pub mod queue;
pub mod scheduler;
pub mod search;
pub mod smtp;
pub mod sync;

use crate::accounts::credentials::{self, Slot};
use crate::config::Paths;
use crate::db::repo;
use crate::db::Db;
use crate::embed::Embedder;
use crate::error::{CoreError, Result};
use crate::events::{CoreEvent, EventBus};
use crate::models::*;
use crate::oauth::tokens::TokenProvider;
use crate::sync::engine::{spawn_account, AccountHandle, SyncCmd, SyncCtx};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// An AI feature, each routed to a configurable model tier.
#[derive(Clone, Copy)]
enum Scenario {
    /// Ask-your-inbox agentic Q&A.
    Ask,
    /// Drafting / rewriting replies.
    Draft,
    /// Thread summaries.
    Summarize,
    /// Learning the user's writing voice.
    Voice,
    /// Palette natural-language commands (tiny prompt, latency-sensitive).
    Command,
}

/// Resolve the model id a scenario should use: its configured tier's model, or
/// the legacy single `ai_model` when that tier is left blank.
fn resolve_ai_model(settings: &Settings, scenario: Scenario) -> String {
    let tier = match scenario {
        Scenario::Ask => settings.ai_tier_ask.as_str(),
        Scenario::Draft => settings.ai_tier_draft.as_str(),
        Scenario::Summarize => settings.ai_tier_summarize.as_str(),
        Scenario::Voice => settings.ai_tier_voice.as_str(),
        // Palette parsing wants the fastest model available.
        Scenario::Command => "instant",
    };
    let picked = match tier {
        "instant" => &settings.ai_model_instant,
        "cheap" => &settings.ai_model_cheap,
        "intelligent" => &settings.ai_model_intelligent,
        _ => &settings.ai_model,
    };
    if picked.trim().is_empty() {
        settings.ai_model.clone()
    } else {
        picked.clone()
    }
}

#[derive(Clone)]
pub struct Core {
    pub db: Db,
    pub bus: EventBus,
    paths: Arc<Paths>,
    tokens: TokenProvider,
    handles: Arc<RwLock<HashMap<i64, AccountHandle>>>,
    cal_handles: Arc<RwLock<HashMap<i64, caldav::task::CalTaskHandle>>>,
    embed: Arc<embed::EmbedState>,
}

impl Core {
    pub async fn start(paths: Paths) -> Result<Core> {
        paths.ensure()?;
        let db = Db::open(&paths.db_file())?;
        let bus = EventBus::new();
        let core = Core {
            db,
            bus,
            paths: Arc::new(paths),
            tokens: TokenProvider::new(),
            handles: Arc::new(RwLock::new(HashMap::new())),
            cal_handles: Arc::new(RwLock::new(HashMap::new())),
            embed: Arc::new(embed::EmbedState::new()),
        };

        // Make saved OAuth app registrations available before any actor
        // needs a token refresh.
        let settings = core.db.read(|conn| repo::settings::get(conn)).await?;
        apply_oauth_settings(&settings);

        // Spawn actors for existing accounts.
        let configs = core
            .db
            .read(|conn| repo::accounts::list_configs(conn))
            .await?;
        for cfg in configs {
            core.spawn_actor(cfg).await;
        }

        // Calendar sync tasks for accounts with a connected CalDAV server.
        let cal_accounts = core
            .db
            .read(|conn| repo::caldav::all_configs(conn))
            .await?;
        for cfg in cal_accounts {
            core.spawn_cal_task(cfg.account_id).await;
        }

        scheduler::spawn(
            core.db.clone(),
            core.bus.clone(),
            core.handles.clone(),
            core.cal_handles.clone(),
        );

        // Make the bundled default model available for offline first run, then
        // start the background embedding worker.
        core.provision_bundled_model().await;
        embed::worker::spawn(core.db.clone(), core.embed.clone(), core.paths.clone());

        // One-shot auto-label backfill: after the 007 migration the categories
        // exist but old mail is unclassified; run once in the background.
        {
            let c = core.clone();
            tokio::spawn(async move {
                let needed = c
                    .db
                    .read(|conn| {
                        let s = repo::settings::get(conn)?;
                        if !s.auto_labels_enabled {
                            return Ok(false);
                        }
                        let memberships: i64 = conn.query_row(
                            "SELECT COUNT(*) FROM message_labels ml
                             JOIN labels l ON l.id = ml.label_id WHERE l.is_auto = 1",
                            [],
                            |r| r.get(0),
                        )?;
                        let msgs: i64 = conn.query_row(
                            "SELECT COUNT(*) FROM messages WHERE is_outgoing = 0",
                            [],
                            |r| r.get(0),
                        )?;
                        Ok(memberships == 0 && msgs > 0)
                    })
                    .await
                    .unwrap_or(false);
                if needed {
                    match c.relabel_auto().await {
                        Ok(n) => tracing::info!("auto-label backfill categorized {n} messages"),
                        Err(e) => tracing::warn!("auto-label backfill failed: {e}"),
                    }
                }
            });
        }

        Ok(core)
    }

    /// Copy the installer-bundled default model into the data dir if it isn't
    /// there yet, so semantic search works with no network on first launch.
    /// Best-effort: if the resource is missing (e.g. dev builds), the worker
    /// falls back to downloading on demand.
    async fn provision_bundled_model(&self) {
        let models_dir = self.paths.models_dir();
        let spec = embed::spec_or_default(embed::DEFAULT_MODEL);
        if embed::model_present(&models_dir, spec.key) {
            return;
        }
        if let Some(src) = bundled_model_dir(spec.key) {
            let dst = embed::model_dir(&models_dir, spec.key);
            if let Err(e) = copy_model_files(&src, &dst).await {
                tracing::warn!("bundled model copy failed: {e}");
            }
        }
    }

    fn sync_ctx(&self) -> SyncCtx {
        SyncCtx {
            db: self.db.clone(),
            bus: self.bus.clone(),
            paths: self.paths.clone(),
            tokens: self.tokens.clone(),
        }
    }

    async fn spawn_actor(&self, cfg: AccountConfig) {
        let handle = spawn_account(self.sync_ctx(), cfg);
        self.handles.write().await.insert(handle.account_id, handle);
    }

    async fn spawn_cal_task(&self, account_id: i64) {
        let handle = caldav::task::spawn(
            self.db.clone(),
            self.bus.clone(),
            self.tokens.clone(),
            account_id,
        );
        self.cal_handles.write().await.insert(account_id, handle);
    }

    async fn nudge_cal(&self, account_id: Option<i64>) {
        let handles = self.cal_handles.read().await;
        match account_id {
            Some(id) => {
                if let Some(h) = handles.get(&id) {
                    h.nudge();
                }
            }
            None => {
                for h in handles.values() {
                    h.nudge();
                }
            }
        }
    }

    async fn nudge(&self, account_id: Option<i64>, cmd_for: impl Fn() -> SyncCmd) {
        let handles = self.handles.read().await;
        match account_id {
            Some(id) => {
                if let Some(h) = handles.get(&id) {
                    h.send(cmd_for());
                }
            }
            None => {
                for h in handles.values() {
                    h.send(cmd_for());
                }
            }
        }
    }

    // ---------- accounts ----------

    pub async fn list_accounts(&self) -> Result<Vec<Account>> {
        self.db.read(|conn| repo::accounts::list(conn)).await
    }

    pub async fn test_connection(&self, args: &AddPasswordAccountArgs) -> ConnectionTestResult {
        let creds = imap::ImapCredentials::Password {
            user: args.username.clone(),
            password: args.password.clone(),
        };
        match imap::connect(&args.imap_host, args.imap_port, creds).await {
            Ok(session) => {
                imap::logout(session).await;
                ConnectionTestResult {
                    ok: true,
                    error: None,
                }
            }
            Err(e) => ConnectionTestResult {
                ok: false,
                error: Some(e.to_ipc_json()),
            },
        }
    }

    pub async fn add_account_password(&self, args: AddPasswordAccountArgs) -> Result<Account> {
        // Verify credentials before storing anything.
        let probe = self.test_connection(&args).await;
        if !probe.ok {
            return Err(CoreError::Auth(
                probe.error.unwrap_or_else(|| "connection failed".into()),
            ));
        }

        let a = args.clone();
        let id = self
            .db
            .write(move |conn| {
                repo::accounts::insert(
                    conn,
                    &repo::accounts::NewAccount {
                        email: &a.email,
                        display_name: a.display_name.as_deref(),
                        provider: Provider::Imap,
                        auth_kind: AuthKind::Password,
                        username: &a.username,
                        imap_host: &a.imap_host,
                        imap_port: a.imap_port,
                        smtp_host: &a.smtp_host,
                        smtp_port: a.smtp_port,
                    },
                )
            })
            .await?;

        credentials::store_async(id, Slot::Password, args.password.clone()).await?;

        let cfg = self
            .db
            .read(move |conn| repo::accounts::get_config(conn, id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))?;
        self.spawn_actor(cfg).await;

        self.db
            .read(move |conn| repo::accounts::get(conn, id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))
    }

    pub async fn start_oauth(
        &self,
        provider: Provider,
        open_url: impl FnOnce(String) + Send,
    ) -> Result<Account> {
        let outcome = oauth::flow::authorize(provider, open_url).await?;
        let servers = match provider {
            Provider::Gmail => &accounts::providers::GMAIL,
            Provider::Microsoft => &accounts::providers::MICROSOFT,
            Provider::Imap => return Err(CoreError::Auth("not an oauth provider".into())),
        };

        let email = outcome.email.clone();
        let id = self
            .db
            .write(move |conn| {
                repo::accounts::insert(
                    conn,
                    &repo::accounts::NewAccount {
                        email: &email,
                        display_name: None,
                        provider,
                        auth_kind: AuthKind::Oauth2,
                        username: &email,
                        imap_host: servers.imap_host,
                        imap_port: servers.imap_port,
                        smtp_host: servers.smtp_host,
                        smtp_port: servers.smtp_port,
                    },
                )
            })
            .await?;

        self.tokens
            .store_initial(
                id,
                outcome.access_token,
                outcome.expires_in,
                outcome.refresh_token,
            )
            .await?;

        let cfg = self
            .db
            .read(move |conn| repo::accounts::get_config(conn, id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))?;
        self.spawn_actor(cfg).await;

        self.db
            .read(move |conn| repo::accounts::get(conn, id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))
    }

    pub async fn remove_account(&self, account_id: i64) -> Result<()> {
        if let Some(h) = self.handles.write().await.remove(&account_id) {
            h.send(SyncCmd::Shutdown);
        }
        self.cal_handles.write().await.remove(&account_id);
        credentials::delete_all(account_id);
        self.db
            .write(move |conn| repo::accounts::delete(conn, account_id))
            .await?;
        let _ = tokio::fs::remove_dir_all(self.paths.mail_dir(account_id)).await;
        Ok(())
    }

    pub async fn sync_now(&self, account_id: Option<i64>) {
        self.nudge(account_id, || SyncCmd::SyncNow).await;
    }

    pub async fn get_sync_status(&self) -> Result<Vec<SyncStatus>> {
        let accounts = self.db.read(|conn| repo::accounts::list(conn)).await?;
        Ok(accounts
            .into_iter()
            .map(|a| SyncStatus {
                account_id: a.id,
                state: a.sync_state,
                progress: None,
            })
            .collect())
    }

    // ---------- reading ----------

    pub async fn list_threads(
        &self,
        view: View,
        split_id: Option<i64>,
        account_id: Option<i64>,
        label_id: Option<i64>,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<ThreadPage> {
        // Split conventions: -1 = Important (human), -2 = Other (automated),
        // positive ids = stored custom split rules.
        let split = match split_id {
            Some(-1) => Some(SplitRuleQuery {
                is_automated: Some(false),
                ..Default::default()
            }),
            Some(-2) => Some(SplitRuleQuery {
                is_automated: Some(true),
                ..Default::default()
            }),
            Some(id) if id > 0 => self
                .db
                .read(move |conn| repo::splits::get(conn, id))
                .await?
                .map(|s| s.query),
            _ => None,
        };
        self.db
            .read(move |conn| {
                repo::threads::list(
                    conn,
                    &repo::threads::ListArgs {
                        view,
                        split,
                        account_id,
                        label_id,
                        cursor,
                        limit: limit.clamp(1, 200),
                    },
                )
            })
            .await
    }

    pub async fn get_thread(&self, thread_id: i64) -> Result<ThreadDetail> {
        let detail = self
            .db
            .read(move |conn| {
                let thread = repo::threads::get_summary(conn, thread_id)?
                    .ok_or_else(|| CoreError::NotFound(format!("thread {thread_id}")))?;
                let messages = repo::messages::list_for_thread(conn, thread_id)?;
                Ok(ThreadDetail { thread, messages })
            })
            .await?;
        // Kick off priority fetches for any unfetched bodies. "fetching" is
        // re-nudged too: a fetch command can be dropped (offline, reconnect),
        // and the fetch itself is idempotent once the body is cached.
        for m in &detail.messages {
            if m.body_state == "none" || m.body_state == "fetching" {
                self.request_body(m.account_id, m.id).await;
            }
        }
        Ok(detail)
    }

    async fn request_body(&self, account_id: i64, message_id: i64) {
        let _ = self
            .db
            .write(move |conn| repo::messages::set_body_state(conn, message_id, "fetching"))
            .await;
        self.nudge(Some(account_id), || SyncCmd::FetchBody { message_id })
            .await;
    }

    pub async fn get_body(&self, message_id: i64) -> Result<MessageDetail> {
        let detail = self
            .db
            .read(move |conn| repo::messages::detail(conn, message_id))
            .await?;
        if detail.body_state == "none" || detail.body_state == "fetching" {
            self.request_body(detail.account_id, message_id).await;
        }
        Ok(detail)
    }

    pub async fn list_folders(&self, account_id: Option<i64>) -> Result<Vec<FolderInfo>> {
        self.db
            .read(move |conn| repo::folders::list_info(conn, account_id))
            .await
    }

    // ---------- actions ----------

    pub async fn perform_action(&self, args: PerformActionArgs) -> Result<ActionResult> {
        let mut action_ids: Vec<i64> = Vec::new();
        let mut touched_accounts: Vec<i64> = Vec::new();

        for thread_id in args.thread_ids.clone() {
            let kind = args.kind;
            let params = args.params.clone();
            let ids = self
                .db
                .write(move |conn| apply_thread_action(conn, thread_id, kind, params.as_ref()))
                .await?;
            for (aid, account_id) in ids {
                action_ids.push(aid);
                if !touched_accounts.contains(&account_id) {
                    touched_accounts.push(account_id);
                }
            }
        }

        self.bus.emit(CoreEvent::MailUpdated {
            thread_ids: args.thread_ids.clone(),
        });
        for acc in touched_accounts {
            self.nudge(Some(acc), || SyncCmd::RunActions).await;
        }
        Ok(ActionResult { action_ids })
    }

    pub async fn undo_last(&self) -> Result<bool> {
        let cutoff = now_ms() - 30_000;
        let last = self
            .db
            .read(move |conn| repo::actions::last_undoable(conn, cutoff))
            .await?;
        let Some(last) = last else { return Ok(false) };

        // Undo the whole gesture: same kind, created within 150ms of it.
        let (kind, created) = (last.kind.clone(), last.created_at);
        let undone_threads = self
            .db
            .write(move |conn| {
                let mut stmt = conn.prepare(
                    "SELECT id FROM pending_actions
                     WHERE kind = ?1 AND ABS(created_at - ?2) <= 150
                       AND state IN ('pending','inflight','done')",
                )?;
                let ids = stmt
                    .query_map(rusqlite::params![kind, created], |r| r.get::<_, i64>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(stmt);
                let mut threads = Vec::new();
                for id in ids {
                    if let Some(action) = repo::actions::get(conn, id)? {
                        if let Some(tid) = revert_action(conn, &action)? {
                            if !threads.contains(&tid) {
                                threads.push(tid);
                            }
                        }
                    }
                }
                Ok(threads)
            })
            .await?;

        if !undone_threads.is_empty() {
            self.bus.emit(CoreEvent::MailUpdated {
                thread_ids: undone_threads,
            });
        }
        self.nudge(None, || SyncCmd::RunActions).await;
        Ok(true)
    }

    pub async fn cancel_send(&self, action_id: i64) -> Result<bool> {
        self.db
            .write(move |conn| repo::actions::try_cancel(conn, action_id))
            .await
    }

    // ---------- compose ----------

    pub async fn save_draft(&self, args: SaveDraftArgs) -> Result<i64> {
        // Stage every attachment into an app-managed dir up front, so the paths
        // persisted to `draft_attachments` (and later read at dispatch) are
        // always files the app itself copied - never an arbitrary path handed
        // in by the frontend. Snapshotting here also fixes the sent bytes at
        // compose time rather than whatever the source file becomes later.
        let staging_root = self.paths.draft_attachments_dir();
        let mut staged: Vec<crate::models::DraftAttachmentIn> =
            Vec::with_capacity(args.attachments.len());
        for att in &args.attachments {
            let file_path =
                stage_draft_attachment(&staging_root, &att.file_path, &att.filename).await?;
            staged.push(crate::models::DraftAttachmentIn {
                file_path,
                filename: att.filename.clone(),
            });
        }
        self.db
            .write(move |conn| {
                let tx = conn.transaction()?;

                let drafts_folder =
                    repo::folders::by_role(&tx, args.account_id, roles::DRAFTS)?.map(|f| f.id);

                // Thread: replies join the parent's thread.
                let thread_id = if let Some(parent_id) = args.in_reply_to_message_id {
                    repo::messages::get_row(&tx, parent_id)?.and_then(|r| r.thread_id)
                } else {
                    None
                };

                let draft_id = match args.draft_id {
                    Some(id) => {
                        tx.execute(
                            "UPDATE messages SET subject = ?2, to_json = ?3, cc_json = ?4,
                                    bcc_json = ?5, date = ?6 WHERE id = ?1 AND is_draft = 1",
                            rusqlite::params![
                                id,
                                args.subject,
                                serde_json::to_string(&args.to)?,
                                serde_json::to_string(&args.cc)?,
                                serde_json::to_string(&args.bcc)?,
                                now_ms(),
                            ],
                        )?;
                        id
                    }
                    None => {
                        let account_email: String = tx.query_row(
                            "SELECT email FROM accounts WHERE id = ?1",
                            rusqlite::params![args.account_id],
                            |r| r.get(0),
                        )?;
                        let tid = match thread_id {
                            Some(t) => t,
                            None => repo::threads::create(
                                &tx,
                                args.account_id,
                                None,
                                &crate::mime::normalize_subject(&args.subject),
                            )?,
                        };
                        let nm = repo::messages::NewMessage {
                            account_id: args.account_id,
                            folder_id: drafts_folder.unwrap_or(0),
                            uid: None,
                            message_id: None,
                            gm_msgid: None,
                            gm_thrid: None,
                            subject: args.subject.clone(),
                            from: Some(Address {
                                name: None,
                                email: account_email,
                            }),
                            to: args.to.clone(),
                            cc: args.cc.clone(),
                            bcc: args.bcc.clone(),
                            date: now_ms(),
                            internal_date: None,
                            is_read: true,
                            is_starred: false,
                            is_draft: true,
                            is_outgoing: true,
                            is_automated: false,
                            has_attachments: false,
                            size: None,
                            snippet: crate::mime::make_snippet(&args.body_text),
                            references: Vec::new(),
                            list_unsubscribe: None,
                        };
                        let id = repo::messages::insert(&tx, &nm, tid)?;
                        tx.execute(
                            "INSERT INTO drafts_meta (message_id, mode, in_reply_to_message_id)
                             VALUES (?1, ?2, ?3)",
                            rusqlite::params![id, args.mode, args.in_reply_to_message_id],
                        )?;
                        id
                    }
                };

                tx.execute(
                    "INSERT INTO message_bodies (message_id, text_body, html_body) VALUES (?1, ?2, ?3)
                     ON CONFLICT(message_id) DO UPDATE SET text_body = excluded.text_body,
                                                           html_body = excluded.html_body",
                    rusqlite::params![draft_id, args.body_text, args.body_html],
                )?;
                tx.execute(
                    "UPDATE messages SET body_state = 'cached', snippet = ?2 WHERE id = ?1",
                    rusqlite::params![draft_id, crate::mime::make_snippet(&args.body_text)],
                )?;
                // Staged outgoing attachments: replace on every save.
                tx.execute(
                    "DELETE FROM draft_attachments WHERE draft_id = ?1",
                    rusqlite::params![draft_id],
                )?;
                for att in &staged {
                    tx.execute(
                        "INSERT INTO draft_attachments (draft_id, file_path, filename) VALUES (?1,?2,?3)",
                        rusqlite::params![draft_id, att.file_path, att.filename],
                    )?;
                }
                tx.execute(
                    "UPDATE messages SET has_attachments = ?2 WHERE id = ?1",
                    rusqlite::params![draft_id, (!staged.is_empty()) as i64],
                )?;
                if let Some(tid) = repo::messages::get_row(&tx, draft_id)?.and_then(|r| r.thread_id)
                {
                    repo::threads::recompute(&tx, tid)?;
                }
                tx.commit()?;
                Ok(draft_id)
            })
            .await
    }

    pub async fn delete_draft(&self, draft_id: i64) -> Result<()> {
        self.db
            .write(move |conn| {
                let row = repo::messages::get_row(conn, draft_id)?;
                repo::messages::delete(conn, draft_id)?;
                if let Some(tid) = row.and_then(|r| r.thread_id) {
                    repo::threads::recompute(conn, tid)?;
                }
                Ok(())
            })
            .await
    }

    pub async fn queue_send(&self, args: QueueSendArgs) -> Result<QueueSendResult> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let dispatch_at = args
            .send_at
            .unwrap_or_else(|| now_ms() + settings.undo_send_seconds * 1000);

        let draft_id = args.draft_id;
        let (action_id, account_id) = self
            .db
            .write(move |conn| {
                let row = repo::messages::get_row(conn, draft_id)?
                    .ok_or_else(|| CoreError::NotFound("draft".into()))?;
                let payload = serde_json::json!({ "draftId": draft_id });
                let aid = repo::actions::enqueue(
                    conn,
                    row.account_id,
                    "send",
                    Some(draft_id),
                    row.thread_id,
                    &payload,
                    Some(dispatch_at),
                )?;
                Ok((aid, row.account_id))
            })
            .await?;

        // If sending now (after undo window), the scheduler nudges the actor
        // when due; nudge immediately anyway to keep latency minimal offline->online.
        let _ = account_id;
        Ok(QueueSendResult {
            action_id,
            dispatch_at,
        })
    }

    /// Extract an attachment from its message's raw MIME to a stable path on
    /// disk (idempotent) and return that path.
    pub async fn get_attachment(&self, attachment_id: i64) -> Result<String> {
        let (message_id, part_id, filename) = self
            .db
            .read(move |conn| {
                conn.query_row(
                    "SELECT message_id, part_id, filename FROM attachments WHERE id = ?1",
                    rusqlite::params![attachment_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .await?;

        let row = self
            .db
            .read(move |conn| repo::messages::get_row(conn, message_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("message".into()))?;
        let raw_path = row
            .raw_path
            .ok_or_else(|| CoreError::NotFound("raw message not synced yet".into()))?;
        let part_id = part_id.ok_or_else(|| CoreError::NotFound("attachment part".into()))?;

        let raw = tokio::fs::read(&raw_path).await?;
        let (bytes, parsed_name) = crate::mime::extract_attachment(&raw, &part_id)?;

        let safe_name = safe_filename(
            &filename
                .or(parsed_name)
                .unwrap_or_else(|| format!("attachment-{attachment_id}")),
        );
        let dir = self
            .paths
            .attachments_dir(row.account_id)
            .join(attachment_id.to_string());
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join(&safe_name);
        tokio::fs::write(&path, &bytes).await?;

        let path_str = path.to_string_lossy().to_string();
        let p = path_str.clone();
        self.db
            .write(move |conn| {
                conn.execute(
                    "UPDATE attachments SET file_path = ?2 WHERE id = ?1",
                    rusqlite::params![attachment_id, p],
                )?;
                Ok(())
            })
            .await?;
        Ok(path_str)
    }

    /// Extract an attachment in memory and convert it to a safe, inert
    /// preview payload (sanitized HTML / text / cell grid / base64 media).
    pub async fn preview_attachment(
        &self,
        attachment_id: i64,
    ) -> Result<preview::AttachmentPreview> {
        let (message_id, part_id, filename, mime_type) = self
            .db
            .read(move |conn| {
                conn.query_row(
                    "SELECT message_id, part_id, filename, mime_type FROM attachments WHERE id = ?1",
                    rusqlite::params![attachment_id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .await?;

        let row = self
            .db
            .read(move |conn| repo::messages::get_row(conn, message_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("message".into()))?;
        let raw_path = row
            .raw_path
            .ok_or_else(|| CoreError::NotFound("raw message not synced yet".into()))?;
        let part_id = part_id.ok_or_else(|| CoreError::NotFound("attachment part".into()))?;

        let raw = tokio::fs::read(&raw_path).await?;
        // Parsing untrusted office/spreadsheet formats is CPU-bound; keep it
        // off the async runtime threads.
        tokio::task::spawn_blocking(move || {
            let (bytes, parsed_name) = crate::mime::extract_attachment(&raw, &part_id)?;
            let name = filename.or(parsed_name);
            Ok(preview::build_preview(
                &bytes,
                name.as_deref(),
                mime_type.as_deref(),
            ))
        })
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?
    }

    pub async fn list_contacts(&self, prefix: String, limit: i64) -> Result<Vec<Address>> {
        self.db
            .read(move |conn| repo::contacts::autocomplete(conn, &prefix, limit.clamp(1, 50)))
            .await
    }

    /// Contact suggestions for the search screen: every query token must match
    /// (accent-insensitive), ranked by how much the user emails that contact.
    /// Search operators are stripped first so "from:x be" still suggests on "be".
    pub async fn suggest_contacts(
        &self,
        query: String,
        limit: i64,
    ) -> Result<Vec<ContactSuggestion>> {
        let text = search::parse(&query).text;
        self.db
            .read(move |conn| repo::contacts::suggest(conn, &text, limit.clamp(1, 20)))
            .await
    }

    // ---------- calendar ----------

    pub async fn list_events(&self, start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>> {
        let (mut events, masters) = self
            .db
            .read(move |conn| {
                Ok((
                    repo::calendar::list_range(conn, start_ms, end_ms)?,
                    repo::calendar::recurring_masters(conn, end_ms)?,
                ))
            })
            .await?;

        // Expand recurring series into concrete occurrences. Occurrences keep
        // the master's row id (edits/deletes address the whole series in v1);
        // unsupported rules fall back to the master row alone.
        for m in masters {
            let Some(rrule) = m.event.rrule.clone() else { continue };
            let duration = m
                .event
                .ends_at
                .map(|e| e - m.event.starts_at)
                .unwrap_or(1_800_000);
            let Some(occs) = caldav::rrule::expand(
                &rrule,
                m.event.starts_at,
                duration,
                m.ical_raw.as_deref(),
                start_ms,
                end_ms,
            ) else {
                continue; // unsupported rule: the master entry stands alone
            };
            events.retain(|e| e.id != m.event.id);
            for occ in occs {
                let mut e = m.event.clone();
                e.starts_at = occ.start;
                e.ends_at = Some(occ.end);
                events.push(e);
            }
        }
        events.sort_by_key(|e| e.starts_at);
        Ok(events)
    }

    /// Invite events carried by one message (the thread invite card).
    pub async fn events_for_message(&self, message_id: i64) -> Result<Vec<CalendarEvent>> {
        self.db
            .read(move |conn| repo::calendar::for_message(conn, message_id))
            .await
    }

    /// Create a meeting. The event lands on the local calendar immediately;
    /// if it has attendees, an invite email with an ICS (METHOD:REQUEST) is
    /// drafted and queued through the normal send pipeline (undo window,
    /// offline queueing, sent-folder append all apply).
    pub async fn create_event(&self, args: CreateEventArgs) -> Result<CalendarEvent> {
        if args.summary.trim().is_empty() {
            return Err(CoreError::Other("event needs a title".into()));
        }
        if args.ends_at <= args.starts_at {
            return Err(CoreError::Other("event must end after it starts".into()));
        }
        let account_id = args.account_id;
        let account = self
            .db
            .read(move |conn| repo::accounts::get(conn, account_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))?;

        let uid = format!("{}-{}@comail", now_ms(), crate::mime::rand_token());
        let attendees: Vec<EventAttendee> = args
            .attendees
            .iter()
            .map(|a| EventAttendee {
                email: a.email.clone(),
                name: a.name.clone(),
                partstat: Some("NEEDS-ACTION".into()),
            })
            .collect();

        let ev = args.clone();
        let organizer_email = account.email.clone();
        let uid_for_db = uid.clone();
        let event_id = self
            .db
            .write(move |conn| {
                repo::calendar::insert_local(
                    conn,
                    account_id,
                    &uid_for_db,
                    ev.summary.trim(),
                    ev.location.as_deref(),
                    ev.description.as_deref(),
                    ev.join_url.as_deref(),
                    &organizer_email,
                    &attendees,
                    ev.starts_at,
                    ev.ends_at,
                    ev.all_day,
                )
            })
            .await?;

        if !args.attendees.is_empty() {
            let organizer = Address {
                name: account.display_name.clone(),
                email: account.email.clone(),
            };
            let ics = calendar::build_request_ics(&calendar::InviteSpec {
                uid: &uid,
                sequence: 0,
                summary: args.summary.trim(),
                description: args.description.as_deref(),
                location: args.location.as_deref(),
                join_url: args.join_url.as_deref(),
                organizer: &organizer,
                attendees: &args.attendees,
                starts_at_ms: args.starts_at,
                ends_at_ms: args.ends_at,
                dtstamp_ms: now_ms(),
            });
            let body_text = invite_body_text(&args);
            self.send_calendar_mail(
                account_id,
                args.attendees.clone(),
                format!("Invitation: {}", args.summary.trim()),
                body_text,
                &ics,
            )
            .await?;
        }

        self.enqueue_cal_push(event_id, account_id, "cal_put").await?;
        self.db
            .read(move |conn| repo::calendar::get(conn, event_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("event".into()))
    }

    /// Answer an invite: store our response and email an ICS METHOD:REPLY to
    /// the organizer (the standard-compliant path every calendar understands).
    pub async fn rsvp_event(&self, args: RsvpEventArgs) -> Result<CalendarEvent> {
        let partstat = match args.response.as_str() {
            "accepted" => "ACCEPTED",
            "tentative" => "TENTATIVE",
            "declined" => "DECLINED",
            _ => return Err(CoreError::Other("invalid RSVP response".into())),
        };
        let event_id = args.event_id;
        let (ev, uid_seq) = self
            .db
            .read(move |conn| {
                Ok((
                    repo::calendar::get(conn, event_id)?,
                    repo::calendar::uid_and_sequence(conn, event_id)?,
                ))
            })
            .await?;
        let ev = ev.ok_or_else(|| CoreError::NotFound("event".into()))?;
        let (uid, sequence) = uid_seq.ok_or_else(|| CoreError::NotFound("event".into()))?;

        let account_id = ev.account_id;
        let account = self
            .db
            .read(move |conn| repo::accounts::get(conn, account_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))?;

        // Reply goes to the organizer; without one there is nobody to notify,
        // but we still record the response locally.
        if let Some(organizer) = ev.organizer.clone().filter(|o| !o.is_empty()) {
            let me = Address {
                name: account.display_name.clone(),
                email: account.email.clone(),
            };
            let ics = calendar::build_reply_ics(&calendar::ReplySpec {
                uid: &uid,
                sequence,
                summary: ev.summary.as_deref(),
                partstat,
                organizer_email: &organizer,
                attendee: &me,
                starts_at_ms: ev.starts_at,
                ends_at_ms: ev.ends_at,
                dtstamp_ms: now_ms(),
            });
            let verb = match partstat {
                "ACCEPTED" => "Accepted",
                "TENTATIVE" => "Tentative",
                _ => "Declined",
            };
            let title = ev.summary.clone().unwrap_or_else(|| "(no title)".into());
            self.send_calendar_mail(
                account_id,
                vec![Address {
                    name: None,
                    email: organizer,
                }],
                format!("{verb}: {title}"),
                format!(
                    "{} has responded {} to: {title}",
                    account.email,
                    verb.to_lowercase()
                ),
                &ics,
            )
            .await?;
        }

        self.db
            .write(move |conn| repo::calendar::set_rsvp(conn, event_id, partstat))
            .await?;
        // CalDAV-backed invites also sync the PARTSTAT change to the server.
        self.enqueue_cal_push(event_id, ev.account_id, "cal_put")
            .await?;
        self.db
            .read(move |conn| repo::calendar::get(conn, event_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("event".into()))
    }

    /// Edit an event we organize. The change is applied locally at once,
    /// attendees get an updated REQUEST ICS (bumped SEQUENCE) when `notify`,
    /// and CalDAV-backed events are flagged for the next push.
    pub async fn update_event(&self, args: UpdateEventArgs) -> Result<CalendarEvent> {
        if args.summary.trim().is_empty() {
            return Err(CoreError::Other("event needs a title".into()));
        }
        if args.ends_at <= args.starts_at {
            return Err(CoreError::Other("event must end after it starts".into()));
        }
        let event_id = args.event_id;
        let existing = self
            .db
            .read(move |conn| repo::calendar::get(conn, event_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("event".into()))?;
        if !existing.is_local {
            return Err(CoreError::Other(
                "only events you organize can be edited".into(),
            ));
        }

        // Preserve responses attendees already gave; new addresses start out
        // NEEDS-ACTION.
        let attendees: Vec<EventAttendee> = args
            .attendees
            .iter()
            .map(|a| EventAttendee {
                email: a.email.clone(),
                name: a.name.clone(),
                partstat: existing
                    .attendees
                    .iter()
                    .find(|old| old.email.eq_ignore_ascii_case(&a.email))
                    .and_then(|old| old.partstat.clone())
                    .or_else(|| Some("NEEDS-ACTION".into())),
            })
            .collect();

        let args_for_db = args.clone();
        let atts_for_db = attendees.clone();
        self.db
            .write(move |conn| repo::calendar::update_local_fields(conn, &args_for_db, &atts_for_db))
            .await?;

        if args.notify && !args.attendees.is_empty() {
            let account_id = existing.account_id;
            let account = self
                .db
                .read(move |conn| repo::accounts::get(conn, account_id))
                .await?
                .ok_or_else(|| CoreError::NotFound("account".into()))?;
            let (uid, sequence) = self
                .db
                .read(move |conn| repo::calendar::uid_and_sequence(conn, event_id))
                .await?
                .ok_or_else(|| CoreError::NotFound("event".into()))?;
            let organizer = Address {
                name: account.display_name.clone(),
                email: account.email.clone(),
            };
            let ics = calendar::build_request_ics(&calendar::InviteSpec {
                uid: &uid,
                sequence,
                summary: args.summary.trim(),
                description: args.description.as_deref(),
                location: args.location.as_deref(),
                join_url: args.join_url.as_deref(),
                organizer: &organizer,
                attendees: &args.attendees,
                starts_at_ms: args.starts_at,
                ends_at_ms: args.ends_at,
                dtstamp_ms: now_ms(),
            });
            let body = invite_body_text(&CreateEventArgs {
                account_id,
                summary: args.summary.clone(),
                description: args.description.clone(),
                location: args.location.clone(),
                join_url: args.join_url.clone(),
                starts_at: args.starts_at,
                ends_at: args.ends_at,
                all_day: args.all_day,
                attendees: args.attendees.clone(),
            });
            self.send_calendar_mail(
                account_id,
                args.attendees.clone(),
                format!("Updated invitation: {}", args.summary.trim()),
                body,
                &ics,
            )
            .await?;
        }

        self.enqueue_cal_push(event_id, existing.account_id, "cal_put")
            .await?;
        self.db
            .read(move |conn| repo::calendar::get(conn, event_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("event".into()))
    }

    /// Delete an event. Organized events with attendees email a METHOD:CANCEL
    /// when `notify`; CalDAV-backed rows become tombstones deleted at the next
    /// push, purely local rows disappear immediately.
    pub async fn delete_event(&self, event_id: i64, notify: bool) -> Result<()> {
        let ev = self
            .db
            .read(move |conn| repo::calendar::get(conn, event_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("event".into()))?;

        if notify && ev.is_local && !ev.attendees.is_empty() {
            let account_id = ev.account_id;
            let account = self
                .db
                .read(move |conn| repo::accounts::get(conn, account_id))
                .await?
                .ok_or_else(|| CoreError::NotFound("account".into()))?;
            let (uid, sequence) = self
                .db
                .read(move |conn| repo::calendar::uid_and_sequence(conn, event_id))
                .await?
                .ok_or_else(|| CoreError::NotFound("event".into()))?;
            let organizer = Address {
                name: account.display_name.clone(),
                email: account.email.clone(),
            };
            let to: Vec<Address> = ev
                .attendees
                .iter()
                .map(|a| Address {
                    name: a.name.clone(),
                    email: a.email.clone(),
                })
                .collect();
            let title = ev.summary.clone().unwrap_or_else(|| "(no title)".into());
            let ics = calendar::build_cancel_ics(&calendar::InviteSpec {
                uid: &uid,
                sequence: sequence + 1,
                summary: &title,
                description: None,
                location: ev.location.as_deref(),
                join_url: None,
                organizer: &organizer,
                attendees: &to,
                starts_at_ms: ev.starts_at,
                ends_at_ms: ev.ends_at.unwrap_or(ev.starts_at + 1_800_000),
                dtstamp_ms: now_ms(),
            });
            self.send_calendar_mail(
                account_id,
                to,
                format!("Cancelled: {title}"),
                format!("{title} has been cancelled."),
                &ics,
            )
            .await?;
        }

        // CalDAV rows need the server-side DELETE; keep a tombstone and let
        // the push path finish the job. Everything else goes right away.
        if ev.calendar_id.is_some() {
            self.db
                .write(move |conn| repo::calendar::mark_deleted(conn, event_id))
                .await?;
            self.enqueue_cal_push(event_id, ev.account_id, "cal_delete")
                .await?;
        } else {
            self.db
                .write(move |conn| repo::calendar::hard_delete(conn, event_id))
                .await?;
        }
        Ok(())
    }

    // ---------- caldav ----------

    /// Connect a calendar server to an account. Generic servers store the app
    /// password in the keyring; Google reuses the account's OAuth tokens (the
    /// caller must have completed the calendar-scope re-consent first).
    /// Discovery doubles as the connection test - nothing persists on failure.
    pub async fn connect_calendar(&self, args: ConnectCalendarArgs) -> Result<Vec<Calendar>> {
        let account_id = args.account_id;
        let kind = if args.kind == "google" { "google" } else { "generic" };
        let base_url = match kind {
            "google" => caldav::GOOGLE_CALDAV_BASE.to_string(),
            _ => {
                let url = args
                    .url
                    .clone()
                    .filter(|u| !u.trim().is_empty())
                    .ok_or_else(|| CoreError::CalDav("server URL is required".into()))?;
                let mut url = url.trim().to_string();
                if !url.contains("://") {
                    url = format!("https://{url}");
                }
                url
            }
        };

        // Build auth without persisting anything yet.
        let auth = match kind {
            "google" => caldav::DavAuth::Bearer(
                self.tokens.access_token(account_id, Provider::Gmail).await?,
            ),
            _ => {
                let user = args.username.clone().unwrap_or_default();
                let pass = args
                    .password
                    .clone()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| CoreError::CalDav("password is required".into()))?;
                caldav::DavAuth::Basic(user, pass)
            }
        };
        let transport = caldav::HttpTransport::new(auth)?;
        let discovery = caldav::discovery::discover(&transport, &base_url).await?;

        // Persist: keyring first, then config + collections.
        if kind == "generic" {
            if let Some(pass) = args.password.clone() {
                credentials::store_async(account_id, Slot::CaldavPassword, pass).await?;
            }
        }
        let cfg = repo::caldav::CaldavConfig {
            account_id,
            kind: kind.to_string(),
            base_url,
            username: args.username.clone(),
            principal_url: discovery.principal_url.clone(),
            home_set_url: Some(discovery.home_set_url.clone()),
            enabled: true,
            last_error: None,
        };
        let calendars = discovery.calendars.clone();
        let out = self
            .db
            .write(move |conn| {
                let tx = conn.transaction()?;
                repo::caldav::upsert_config(&tx, &cfg)?;
                let mut first_id = None;
                for c in &calendars {
                    let id = repo::caldav::upsert_calendar(
                        &tx,
                        account_id,
                        &c.url,
                        c.display_name.as_deref(),
                        c.color.as_deref(),
                        false,
                    )?;
                    first_id.get_or_insert(id);
                }
                if let Some(id) = first_id {
                    // Keep an existing default if one is set; else first wins.
                    let has_default: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM calendars WHERE account_id = ?1 AND is_default = 1",
                        rusqlite::params![account_id],
                        |r| r.get(0),
                    )?;
                    if has_default == 0 {
                        repo::caldav::set_default_calendar(&tx, account_id, id)?;
                    }
                }
                let list = repo::caldav::list_calendars(&tx, Some(account_id))?;
                tx.commit()?;
                Ok(list)
            })
            .await?;

        self.spawn_cal_task(account_id).await;
        self.nudge_cal(Some(account_id)).await;
        Ok(out)
    }

    /// Google calendar connection: re-run the OAuth consent with the
    /// calendar scope added (scopes are fixed at consent time, so the account
    /// must re-consent) and swap in the widened tokens, then discover.
    pub async fn connect_google_calendar(
        &self,
        account_id: i64,
        open_url: impl FnOnce(String) + Send,
    ) -> Result<Vec<Calendar>> {
        let account = self
            .db
            .read(move |conn| repo::accounts::get(conn, account_id))
            .await?
            .ok_or_else(|| CoreError::NotFound("account".into()))?;
        if account.provider != Provider::Gmail {
            return Err(CoreError::CalDav(
                "google calendar needs a Gmail account".into(),
            ));
        }

        let outcome = oauth::flow::authorize_with(
            Provider::Gmail,
            &[oauth::providers::GOOGLE_CALENDAR_SCOPE],
            Some(&account.email),
            open_url,
        )
        .await?;
        if !outcome.email.eq_ignore_ascii_case(&account.email) {
            return Err(CoreError::Auth(format!(
                "consent was granted for {} - expected {}",
                outcome.email, account.email
            )));
        }
        self.tokens
            .store_initial(
                account_id,
                outcome.access_token,
                outcome.expires_in,
                outcome.refresh_token,
            )
            .await?;

        self.connect_calendar(ConnectCalendarArgs {
            account_id,
            kind: "google".into(),
            url: None,
            username: None,
            password: None,
        })
        .await
    }

    /// Disconnect the calendar server: events stay locally, sync bookkeeping
    /// is cleared, credentials removed.
    pub async fn disconnect_calendar(&self, account_id: i64) -> Result<()> {
        self.cal_handles.write().await.remove(&account_id);
        self.db
            .write(move |conn| repo::caldav::delete_config(conn, account_id))
            .await?;
        let _ = tokio::task::spawn_blocking(move || {
            let _ = credentials::store(account_id, Slot::CaldavPassword, "");
        })
        .await;
        self.bus.emit(CoreEvent::CalendarUpdated { account_id });
        Ok(())
    }

    pub async fn list_calendars(&self, account_id: Option<i64>) -> Result<Vec<Calendar>> {
        self.db
            .read(move |conn| repo::caldav::list_calendars(conn, account_id))
            .await
    }

    pub async fn set_calendar_enabled(&self, calendar_id: i64, enabled: bool) -> Result<()> {
        self.db
            .write(move |conn| repo::caldav::set_calendar_enabled(conn, calendar_id, enabled))
            .await?;
        let cal = self
            .db
            .read(move |conn| repo::caldav::get_calendar(conn, calendar_id))
            .await?;
        if let Some(cal) = cal {
            self.bus
                .emit(CoreEvent::CalendarUpdated { account_id: cal.account_id });
        }
        Ok(())
    }

    pub async fn calendar_sync_now(&self, account_id: Option<i64>) {
        self.nudge_cal(account_id).await;
    }

    /// Queue a CalDAV write for the account's calendar task, when the account
    /// has one configured. No-op otherwise (purely local calendars).
    async fn enqueue_cal_push(&self, event_id: i64, account_id: i64, kind: &str) -> Result<()> {
        let kind = kind.to_string();
        self.db
            .write(move |conn| {
                if repo::caldav::get_config(conn, account_id)?.is_none() {
                    return Ok(());
                }
                // Dirty guards the row against being clobbered by a pull that
                // runs between now and the push.
                if kind == "cal_put" {
                    repo::calendar::mark_dirty(conn, event_id)?;
                }
                let payload = serde_json::json!({ "eventId": event_id });
                repo::actions::enqueue(conn, account_id, &kind, None, None, &payload, None)?;
                Ok(())
            })
            .await?;
        self.nudge_cal(Some(account_id)).await;
        Ok(())
    }

    /// Draft + queue an email carrying an ICS part, through the normal send
    /// pipeline. The ICS is staged like an attachment.
    async fn send_calendar_mail(
        &self,
        account_id: i64,
        to: Vec<Address>,
        subject: String,
        body_text: String,
        ics: &str,
    ) -> Result<()> {
        let tmp_dir = self.paths.data_dir.join("tmp");
        tokio::fs::create_dir_all(&tmp_dir).await?;
        let tmp_path = tmp_dir.join(format!("invite-{}.ics", crate::mime::rand_token()));
        tokio::fs::write(&tmp_path, ics.as_bytes()).await?;

        let draft_id = self
            .save_draft(SaveDraftArgs {
                draft_id: None,
                account_id,
                to,
                cc: Vec::new(),
                bcc: Vec::new(),
                subject,
                body_text,
                body_html: None,
                mode: "new".into(),
                in_reply_to_message_id: None,
                attachments: vec![DraftAttachmentIn {
                    file_path: tmp_path.to_string_lossy().into_owned(),
                    filename: "invite.ics".into(),
                }],
            })
            .await?;
        // The draft staged its own copy; the temp file can go.
        let _ = tokio::fs::remove_file(&tmp_path).await;
        self.queue_send(QueueSendArgs {
            draft_id,
            send_at: None,
        })
        .await?;
        Ok(())
    }

    // ---------- AI ----------

    async fn ai_config(&self, scenario: Scenario) -> Result<ai::AiConfig> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        self.ai_config_from(&settings, scenario).await
    }

    /// Build an [`ai::AiConfig`] for `scenario` from already-loaded settings,
    /// picking the model for the scenario's tier (all tiers share the base URL
    /// and stored API key).
    async fn ai_config_from(&self, settings: &Settings, scenario: Scenario) -> Result<ai::AiConfig> {
        let api_key = match credentials::load_async(0, Slot::AiApiKey).await {
            Ok(k) => k,
            // Local endpoints (LM Studio, Ollama over http://) need no key;
            // hosted ones do, so fail early with a pointer to Settings.
            Err(_) if settings.ai_base_url.starts_with("http://") => String::new(),
            Err(_) => {
                return Err(CoreError::Other(
                    "AI is not configured. Add an API key in Settings (not needed for local endpoints like LM Studio)"
                        .into(),
                ))
            }
        };
        Ok(ai::AiConfig {
            base_url: settings.ai_base_url.clone(),
            model: resolve_ai_model(settings, scenario),
            api_key,
        })
    }

    pub async fn set_ai_key(&self, api_key: String) -> Result<()> {
        if api_key.trim().is_empty() {
            credentials::delete_all(0);
            return Ok(());
        }
        credentials::store_async(0, Slot::AiApiKey, api_key.trim().to_string()).await
    }

    pub async fn ai_status(&self) -> Result<AiStatus> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let configured = credentials::load_async(0, Slot::AiApiKey).await.is_ok()
            || settings.ai_base_url.starts_with("http://");
        Ok(AiStatus {
            configured,
            model: settings.ai_model,
            base_url: settings.ai_base_url,
        })
    }

    /// Model ids from the configured endpoint. Works keyless on OpenRouter,
    /// so this is available before an API key is saved.
    pub async fn ai_list_models(&self) -> Result<Vec<String>> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let api_key = credentials::load_async(0, Slot::AiApiKey)
            .await
            .unwrap_or_default();
        ai::list_models(&settings.ai_base_url, &api_key).await
    }

    /// Parse a natural-language palette query ("meeting tomorrow 8pm ...")
    /// into a structured intent the UI can execute.
    pub async fn ai_command(&self, query: String) -> Result<AiIntent> {
        let cfg = self.ai_config(Scenario::Command).await?;
        ai::intent(&cfg, &query).await
    }

    pub async fn ai_summarize(&self, thread_id: i64) -> Result<String> {
        let cfg = self.ai_config(Scenario::Summarize).await?;
        let detail = self.get_thread(thread_id).await?;
        let context = ai::thread_context(&detail.messages, 24_000);
        ai::chat(&cfg, ai::summarize_prompt(&detail.thread.subject, &context)).await
    }

    /// Draft or rewrite email body text. With a thread, the reply is grounded
    /// in its content; without, it's freeform writing from the instruction.
    /// When `voice` (or the persisted setting) is on, the draft imitates the
    /// user's learned writing style and their similar past sent emails.
    pub async fn ai_draft(
        &self,
        thread_id: Option<i64>,
        reply_to_message_id: Option<i64>,
        instruction: String,
        sender_name: String,
        voice: Option<bool>,
    ) -> Result<String> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let cfg = self.ai_config_from(&settings, Scenario::Draft).await?;
        let use_voice = voice.unwrap_or(settings.voice_drafting);

        let (subject, context, reply_target) = match thread_id {
            Some(tid) => {
                let detail = self.get_thread(tid).await?;
                (
                    detail.thread.subject.clone(),
                    ai::thread_context(&detail.messages, 24_000),
                    ai::reply_target_line(&detail.messages, reply_to_message_id),
                )
            }
            None => (String::new(), String::new(), String::new()),
        };

        if use_voice {
            let query = format!("{subject}\n{instruction}");
            let examples = self.voice_examples(&query, 3).await.unwrap_or_default();
            return ai::chat(
                &cfg,
                ai::draft_prompt_voiced(
                    &subject,
                    &context,
                    &reply_target,
                    &instruction,
                    &sender_name,
                    &settings.voice_profile,
                    &examples,
                ),
            )
            .await;
        }

        ai::chat(
            &cfg,
            ai::draft_prompt(&subject, &context, &reply_target, &instruction, &sender_name),
        )
        .await
    }

    /// Copy-edit a draft body (plain text or simple HTML) without changing
    /// meaning, tone, or language. Returns the corrected draft.
    pub async fn ai_proofread(&self, body: String) -> Result<String> {
        let cfg = self.ai_config(Scenario::Draft).await?;
        ai::chat(&cfg, ai::proofread_prompt(&body)).await
    }

    /// Distill the user's writing voice from their sent mail and persist it as
    /// a style profile. Returns the profile text.
    pub async fn ai_learn_voice(&self) -> Result<String> {
        let cfg = self.ai_config(Scenario::Voice).await?;
        let samples = self
            .db
            .read(|conn| {
                let rows = repo::messages::list_sent_bodies(conn, None, 30)?;
                Ok::<_, CoreError>(
                    rows.into_iter()
                        .map(|(_, subj, body)| format!("Subject: {subj}\n{body}"))
                        .collect::<Vec<_>>(),
                )
            })
            .await?;
        if samples.is_empty() {
            return Err(CoreError::Other(
                "No sent emails to learn from yet. Send or sync some mail first.".into(),
            ));
        }
        let profile = ai::chat(&cfg, ai::voice_profile_prompt(&samples)).await?;

        let p = profile.clone();
        let now = now_ms();
        self.db
            .write(move |conn| {
                let mut s = repo::settings::get(conn)?;
                s.voice_profile = p;
                s.voice_learned_at = now;
                repo::settings::set(conn, &s)
            })
            .await?;
        Ok(profile)
    }

    /// Up to `k` (incoming → the user's reply) exchanges from their sent mail
    /// most relevant to `query`, for few-shot voice imitation. Prefers semantic
    /// retrieval; falls back to recent sent mail when the index is empty.
    async fn voice_examples(&self, query: &str, k: usize) -> Result<Vec<(String, String)>> {
        let hits = self.vector_hits(query, 40).await.unwrap_or_default();
        let hit_ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        self.db
            .read(move |conn| {
                let sent_ids = repo::messages::filter_sent(conn, &hit_ids)?;
                let mut out: Vec<(String, String)> = Vec::new();
                for mid in sent_ids {
                    if out.len() >= k {
                        break;
                    }
                    if let Some(pair) = build_example_pair(conn, mid)? {
                        out.push(pair);
                    }
                }
                if out.is_empty() {
                    // No index / no similar sent mail: use recent sent as exemplars.
                    for (_, subject, body) in repo::messages::list_sent_bodies(conn, None, k as i64)? {
                        out.push((format!("(Compose a new email. Subject: {subject})"), body));
                    }
                }
                Ok::<_, CoreError>(out)
            })
            .await
    }

    // ---------- search ----------

    pub async fn search(&self, query: String, limit: i64) -> Result<Vec<ThreadSummary>> {
        let parsed = search::parse(&query);
        let limit = limit.clamp(1, 100);
        let t0 = std::time::Instant::now();

        // The lexical DB read and the semantic branch (a CPU-bound model
        // forward pass + KNN) are independent - run them concurrently so
        // latency is max(lexical, semantic), not their sum. Semantic is
        // best-effort and skipped for queries too short to carry meaning.
        let lex_fut = {
            let q = parsed.clone();
            self.db
                .read(move |conn| repo::search::lexical_thread_ids(conn, &q, repo::search::candidate_cap(limit)))
        };
        let vec_fut = async {
            if parsed.text.chars().count() < 3 {
                Vec::new()
            } else {
                self.vector_hits(&parsed.text, 200).await.unwrap_or_default()
            }
        };
        let (lexical, vec_hits) = tokio::join!(lex_fut, vec_fut);
        let lexical = lexical?;
        let t_branches = t0.elapsed();

        let parsed2 = parsed.clone();
        let out = self
            .db
            .read(move |conn| repo::search::fuse(conn, &parsed2, lexical, &vec_hits, limit))
            .await;
        tracing::debug!(
            "search '{}': branches {:?}, fuse+hydrate {:?}",
            parsed.text,
            t_branches,
            t0.elapsed() - t_branches
        );
        out
    }

    /// Embed `text` as a query and return the top-`k` (message_id, score) hits
    /// from the in-memory index. Empty when no local model is loaded. Query
    /// embeddings are cached, so repeated or backspaced-over queries skip the
    /// model forward pass entirely.
    async fn vector_hits(&self, text: &str, k: usize) -> Result<Vec<(i64, f32)>> {
        let Some(embedder) = self.embed.embedder().await else {
            return Ok(Vec::new());
        };
        let qv = match self.embed.cached_query(text).await {
            Some(v) => v,
            None => {
                let t = text.to_string();
                let v = tokio::task::spawn_blocking(move || embedder.embed_query(&t))
                    .await
                    .map_err(|e| CoreError::Other(format!("embed query join: {e}")))??;
                self.embed.cache_query(text.to_string(), v.clone()).await;
                v
            }
        };
        let idx = self.embed.index.read().await;
        Ok(idx.search(&qv, k))
    }

    // ---------- semantic index / RAG ----------

    pub async fn embedding_status(&self) -> Result<EmbeddingStatus> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let enabled = settings.embedding_backend == "local";
        let model = settings.embedding_model.clone();
        let model_id = embed::spec_or_default(&model).key.to_string();
        let m = model_id.clone();
        let (total, embedded, pending) = self
            .db
            .read(move |conn| repo::embeddings::counts(conn, &m))
            .await?;
        let ready = self.embed.embedder().await.is_some()
            && *self.embed.active_model.read().await == model_id;
        Ok(EmbeddingStatus {
            enabled,
            model: model_id,
            total,
            embedded,
            pending,
            ready,
        })
    }

    /// Requeue the whole mailbox for (re-)embedding. The worker drains it.
    pub async fn semantic_reindex(&self) -> Result<i64> {
        let n = self
            .db
            .write(|conn| repo::embeddings::mark_all_pending(conn))
            .await?;
        Ok(n as i64)
    }

    /// RAG: answer a natural-language question grounded in the most relevant
    /// messages, returning the answer plus its source citations.
    /// Answer a question about the mailbox. Seeds with a semantic-search RAG
    /// pass, then hands the model a `search_inbox` tool so it can reformulate
    /// queries and dig deeper on its own before answering. Falls back to a plain
    /// one-shot RAG answer if the model/endpoint doesn't support tool calling.
    pub async fn ai_ask(&self, question: String, request_id: String) -> Result<AskResult> {
        const MAX_ROUNDS: usize = 4;
        let cfg = self.ai_config(Scenario::Ask).await?;

        // RAG seed: the model always starts from the best semantic matches.
        let mut sources = self.retrieve_details(&question, 8).await?;
        if sources.is_empty() {
            return Ok(AskResult {
                answer: "I couldn't find anything relevant in your mailbox. \
                         Make sure semantic search is enabled and indexing has finished."
                    .into(),
                citations: Vec::new(),
            });
        }
        // Surface the seed sources immediately; more are emitted as the model searches.
        self.emit_ask_citations(&request_id, &sources);

        let mut initial_context = String::new();
        for (i, m) in sources.iter().enumerate() {
            initial_context.push_str(&ai::format_excerpt(i + 1, m));
        }
        let mut messages: Vec<serde_json::Value> = vec![
            serde_json::json!({ "role": "system", "content": ai::AGENTIC_ASK_SYSTEM }),
            serde_json::json!({
                "role": "user",
                "content": format!("Emails:\n\n{initial_context}\nQuestion: {question}"),
            }),
        ];
        let tools = ai::search_inbox_tool();

        // Agentic loop: let the model call search_inbox until it answers or we
        // hit the round cap. `answer = Some` means the model produced text.
        let mut answer: Option<String> = None;
        let mut used_tools = false;
        for round in 0..MAX_ROUNDS {
            match ai::chat_tools(&cfg, messages.clone(), tools.clone()).await {
                Ok(ai::ChatStep::Content(text)) => {
                    answer = Some(text);
                    break;
                }
                Ok(ai::ChatStep::Tools { assistant, calls }) => {
                    used_tools = true;
                    messages.push(assistant);
                    for call in calls {
                        let (result, added) = if call.name == "search_inbox" {
                            self.run_search_inbox(&call.arguments, &mut sources).await
                        } else {
                            (format!("Unknown tool: {}", call.name), 0)
                        };
                        messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": result,
                        }));
                        if added > 0 {
                            self.emit_ask_citations(&request_id, &sources);
                        }
                    }
                }
                Err(e) => {
                    // A first-round failure means the model/endpoint has no tool
                    // support - degrade to a plain streamed RAG answer. A failure
                    // mid-conversation is a real error.
                    if round == 0 && !used_tools {
                        break;
                    }
                    return Err(e);
                }
            }
        }

        let answer = match answer {
            Some(text) => {
                if !text.is_empty() {
                    self.bus.emit(CoreEvent::AskDelta {
                        request_id: request_id.clone(),
                        delta: text.clone(),
                    });
                }
                text
            }
            None => {
                // Cap reached while still searching, or tool-less fallback: force
                // a final streamed answer over everything gathered, tools off.
                messages.push(serde_json::json!({
                    "role": "system",
                    "content": "Now answer the user's question using ONLY the numbered excerpts \
                                above. Cite them like [1]. If the answer isn't there, say you \
                                couldn't find it. Concise plain text, no preamble.",
                }));
                let bus = self.bus.clone();
                let rid = request_id.clone();
                ai::chat_stream_json(&cfg, messages, move |delta| {
                    bus.emit(CoreEvent::AskDelta {
                        request_id: rid.clone(),
                        delta: delta.to_string(),
                    });
                })
                .await?
            }
        };
        self.bus.emit(CoreEvent::AskDone { request_id });

        Ok(AskResult {
            answer,
            citations: Self::ask_citations(&sources),
        })
    }

    /// Semantic-search `query` and hydrate the top-`k` hits into message details.
    async fn retrieve_details(&self, query: &str, k: usize) -> Result<Vec<MessageDetail>> {
        let hits = self.vector_hits(query, k).await?;
        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        self.db
            .read(move |conn| {
                let mut out = Vec::new();
                for id in ids {
                    if let Ok(d) = repo::messages::detail(conn, id) {
                        out.push(d);
                    }
                }
                Ok::<_, CoreError>(out)
            })
            .await
    }

    /// Execute a `search_inbox` tool call: run the search, append any *new*
    /// messages to `sources` with stable citation numbers, and return the
    /// excerpt block for the model plus how many new sources were added.
    async fn run_search_inbox(
        &self,
        arguments: &str,
        sources: &mut Vec<MessageDetail>,
    ) -> (String, usize) {
        let args: serde_json::Value =
            serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
        let query = args["query"].as_str().unwrap_or("").trim().to_string();
        if query.is_empty() {
            return ("(empty query - nothing searched)".into(), 0);
        }
        if sources.len() >= 24 {
            return ("Source limit reached; answer with what you already have.".into(), 0);
        }
        let limit = args["limit"].as_u64().unwrap_or(6).clamp(1, 8) as usize;
        let details = self.retrieve_details(&query, limit).await.unwrap_or_default();

        let mut block = String::new();
        let mut added = 0;
        for d in details {
            if sources.iter().any(|s| s.id == d.id) {
                continue; // already cited under an earlier number
            }
            block.push_str(&ai::format_excerpt(sources.len() + 1, &d));
            sources.push(d);
            added += 1;
            if sources.len() >= 24 {
                break;
            }
        }
        let text = if added == 0 {
            format!("No new results for \"{query}\".")
        } else {
            format!("Results for \"{query}\":\n\n{block}")
        };
        (text, added)
    }

    fn emit_ask_citations(&self, request_id: &str, sources: &[MessageDetail]) {
        self.bus.emit(CoreEvent::AskCitations {
            request_id: request_id.to_string(),
            citations: Self::ask_citations(sources),
        });
    }

    fn ask_citations(sources: &[MessageDetail]) -> Vec<AskCitation> {
        sources
            .iter()
            .map(|d| AskCitation {
                message_id: d.id,
                thread_id: d.thread_id,
                subject: d.subject.clone(),
                from: d.from.name.clone().unwrap_or_else(|| d.from.email.clone()),
                date: d.date,
                snippet: d.snippet.clone(),
            })
            .collect()
    }

    // ---------- snippets / splits / settings ----------

    pub async fn list_snippets(&self) -> Result<Vec<Snippet>> {
        self.db.read(|conn| repo::snippets::list(conn)).await
    }

    pub async fn save_snippet(
        &self,
        id: Option<i64>,
        name: String,
        shortcut: Option<String>,
        subject: Option<String>,
        body_text: String,
    ) -> Result<Snippet> {
        self.db
            .write(move |conn| {
                repo::snippets::save(
                    conn,
                    id,
                    &name,
                    shortcut.as_deref(),
                    subject.as_deref(),
                    &body_text,
                )
            })
            .await
    }

    pub async fn delete_snippet(&self, id: i64) -> Result<()> {
        self.db
            .write(move |conn| repo::snippets::delete(conn, id))
            .await
    }

    pub async fn use_snippet(&self, id: i64) -> Result<()> {
        self.db
            .write(move |conn| repo::snippets::bump_usage(conn, id))
            .await
    }

    pub async fn list_splits(&self) -> Result<Vec<SplitRule>> {
        self.db.read(|conn| repo::splits::list(conn)).await
    }

    pub async fn save_split(
        &self,
        id: Option<i64>,
        name: String,
        position: i64,
        query: SplitRuleQuery,
    ) -> Result<SplitRule> {
        self.db
            .write(move |conn| repo::splits::save(conn, id, &name, position, &query))
            .await
    }

    pub async fn delete_split(&self, id: i64) -> Result<()> {
        self.db
            .write(move |conn| repo::splits::delete(conn, id))
            .await
    }

    pub async fn list_labels(&self) -> Result<Vec<Label>> {
        self.db.read(|conn| repo::labels::list(conn)).await
    }

    pub async fn save_label(
        &self,
        id: Option<i64>,
        name: String,
        color: String,
        position: i64,
    ) -> Result<Label> {
        self.db
            .write(move |conn| repo::labels::save(conn, id, &name, &color, position))
            .await
    }

    pub async fn delete_label(&self, id: i64) -> Result<()> {
        self.db
            .write(move |conn| repo::labels::delete(conn, id))
            .await
    }

    /// Re-run the auto-label classifier over all stored incoming mail.
    /// Clears existing auto memberships first; returns how many messages
    /// received a category.
    pub async fn relabel_auto(&self) -> Result<i64> {
        let labeled = self
            .db
            .write(|conn| {
                let tx = conn.transaction()?;
                tx.execute(
                    "DELETE FROM message_labels WHERE label_id IN
                     (SELECT id FROM labels WHERE is_auto = 1)",
                    [],
                )?;
                let rows: Vec<(i64, String, Option<String>, bool, Option<String>)> = {
                    let mut stmt = tx.prepare(
                        "SELECT id, COALESCE(from_addr, ''), subject, is_automated, list_unsubscribe
                         FROM messages WHERE is_outgoing = 0 AND is_draft = 0",
                    )?;
                    let collected = stmt
                        .query_map([], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    collected
                };
                let mut labeled = 0i64;
                for (id, from, subject, is_automated, unsub) in rows {
                    let facts = autolabel::MessageFacts {
                        from_addr: &from,
                        subject: subject.as_deref().unwrap_or(""),
                        is_automated,
                        has_list_headers: unsub.is_some(),
                        sender_known: autolabel::sender_known(&tx, &from),
                    };
                    if autolabel::apply(&tx, id, &facts)? {
                        labeled += 1;
                    }
                }
                tx.commit()?;
                Ok(labeled)
            })
            .await?;
        // Labels changed across many threads; a blanket refresh is fine here.
        self.bus.emit(CoreEvent::MailUpdated { thread_ids: vec![] });
        Ok(labeled)
    }

    /// Exact unread counts for every split tab and sidebar row in one call.
    pub async fn unread_counts(&self, account_id: Option<i64>) -> Result<UnreadCounts> {
        self.db
            .read(move |conn| {
                let splits = repo::splits::list(conn)?;
                let labels = repo::labels::list(conn)?;
                repo::counts::unread_counts(conn, account_id, &splits, &labels)
            })
            .await
    }

    pub async fn get_settings(&self) -> Result<Settings> {
        self.db.read(|conn| repo::settings::get(conn)).await
    }

    pub async fn set_settings(&self, settings: Settings) -> Result<()> {
        apply_oauth_settings(&settings);
        self.db
            .write(move |conn| repo::settings::set(conn, &settings))
            .await
    }
}

/// Build a (incoming → the user's reply) example from one of their sent
/// messages: the reply is its body, the incoming side is the message it
/// replied to (the prior message in its thread), or a synthetic prompt if it
/// started the thread. Returns None if the sent body is empty.
fn build_example_pair(
    conn: &rusqlite::Connection,
    sent_id: i64,
) -> Result<Option<(String, String)>> {
    let sent = repo::messages::detail(conn, sent_id)?;
    let reply = sent.text_body.clone().unwrap_or_default();
    if reply.trim().is_empty() {
        return Ok(None);
    }
    let msgs = repo::messages::list_for_thread(conn, sent.thread_id)?;
    let mut incoming: Option<&MessageDetail> = None;
    for m in &msgs {
        if m.id == sent_id {
            break;
        }
        incoming = Some(m);
    }
    let incoming_text = match incoming {
        Some(m) => {
            let body = m.text_body.clone().unwrap_or_else(|| m.snippet.clone());
            format!("Subject: {}\nFrom: {}\n{}", m.subject, m.from.email, body)
        }
        None => format!("(Compose a new email. Subject: {})", sent.subject),
    };
    Ok(Some((incoming_text, reply)))
}

/// Locate installer-bundled model files. The host (Tauri app) sets
/// `COMAIL_RESOURCE_DIR` to its resource dir so comail-core stays Tauri-free.
fn bundled_model_dir(key: &str) -> Option<std::path::PathBuf> {
    let base = std::env::var_os("COMAIL_RESOURCE_DIR")?;
    let dir = std::path::PathBuf::from(base).join("models").join(key);
    dir.join("model.safetensors").exists().then_some(dir)
}

async fn copy_model_files(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    for f in embed::MODEL_FILES {
        tokio::fs::copy(src.join(f), dst.join(f)).await?;
    }
    Ok(())
}

/// Reduce an untrusted filename to a single, benign path component: strip
/// separators/NUL/control chars, leading dots and spaces, and cap the length.
fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', ' ']);
    let base = if trimmed.is_empty() { "attachment" } else { trimmed };
    base.chars().take(200).collect()
}

/// Copy a composer-picked file into the app-managed draft-attachment staging
/// area and return the staged absolute path. A path already inside the staging
/// root (a reloaded draft round-tripping its own staged path) is returned
/// unchanged. This guarantees dispatch only ever reads files the app itself
/// wrote, closing an arbitrary local-file read/exfiltration path through the
/// `save_draft` IPC command.
async fn stage_draft_attachment(
    root: &std::path::Path,
    src: &str,
    filename: &str,
) -> Result<String> {
    tokio::fs::create_dir_all(root).await?;
    let root = tokio::fs::canonicalize(root).await?;
    let canon_src = tokio::fs::canonicalize(src)
        .await
        .map_err(|e| CoreError::Other(format!("attachment {filename}: {e}")))?;
    if canon_src.starts_with(&root) {
        // Already staged (e.g. re-saving a draft reloaded from the DB).
        return Ok(canon_src.to_string_lossy().into_owned());
    }
    let sub = root.join(crate::mime::rand_token());
    tokio::fs::create_dir_all(&sub).await?;
    let dst = sub.join(safe_filename(filename));
    tokio::fs::copy(&canon_src, &dst).await?;
    Ok(dst.to_string_lossy().into_owned())
}

/// Plain-text body for an outgoing invite email (the ICS carries the real
/// event; this is what non-calendar clients show).
fn invite_body_text(args: &CreateEventArgs) -> String {
    use chrono::TimeZone;
    let fmt = |ms: i64| {
        chrono::Local
            .timestamp_millis_opt(ms)
            .earliest()
            .map(|dt| {
                if args.all_day {
                    dt.format("%a, %b %e, %Y").to_string()
                } else {
                    dt.format("%a, %b %e, %Y at %H:%M").to_string()
                }
            })
            .unwrap_or_default()
    };
    let mut out = format!(
        "You are invited: {}\n\nWhen: {} - {}\n",
        args.summary.trim(),
        fmt(args.starts_at),
        fmt(args.ends_at)
    );
    if let Some(loc) = args.location.as_deref().filter(|l| !l.is_empty()) {
        out.push_str(&format!("Where: {loc}\n"));
    }
    if let Some(url) = args.join_url.as_deref().filter(|u| !u.is_empty()) {
        out.push_str(&format!("Join: {url}\n"));
    }
    if let Some(desc) = args.description.as_deref().filter(|d| !d.is_empty()) {
        out.push_str(&format!("\n{desc}\n"));
    }
    out
}

/// Push user-entered OAuth app registrations into the resolver.
fn apply_oauth_settings(settings: &Settings) {
    oauth::providers::set_configured(
        Provider::Gmail,
        &settings.google_client_id,
        &settings.google_client_secret,
    );
    oauth::providers::set_configured(
        Provider::Microsoft,
        &settings.ms_client_id,
        &settings.ms_client_secret,
    );
}

/// Optimistic local mutation + enqueue, in one transaction.
/// Returns (action_id, account_id) pairs.
fn apply_thread_action(
    conn: &mut rusqlite::Connection,
    thread_id: i64,
    kind: ActionKind,
    params: Option<&ActionParams>,
) -> Result<Vec<(i64, i64)>> {
    let tx = conn.transaction()?;
    let mut out: Vec<(i64, i64)> = Vec::new();

    let account_id: i64 = tx.query_row(
        "SELECT account_id FROM threads WHERE id = ?1",
        rusqlite::params![thread_id],
        |r| r.get(0),
    )?;

    // Messages in this thread with their current folder role.
    let mut stmt = tx.prepare(
        "SELECT m.id, m.folder_id, m.uid, m.is_read, m.is_starred, COALESCE(f.role,'')
         FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
         WHERE m.thread_id = ?1 AND m.is_draft = 0",
    )?;
    #[allow(clippy::type_complexity)]
    let msgs: Vec<(i64, Option<i64>, Option<i64>, bool, bool, String)> = stmt
        .query_map(rusqlite::params![thread_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, i64>(3)? != 0,
                r.get::<_, i64>(4)? != 0,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    fn folder_of(tx: &rusqlite::Transaction, account_id: i64, role: &str) -> Result<Option<i64>> {
        Ok(repo::folders::by_role(tx, account_id, role)?.map(|f| f.id))
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue_move(
        tx: &rusqlite::Transaction,
        account_id: i64,
        thread_id: i64,
        msg_id: i64,
        src_folder: Option<i64>,
        src_uid: Option<i64>,
        target: i64,
        kind_str: &str,
    ) -> Result<i64> {
        let payload = serde_json::json!({
            "srcFolderId": src_folder,
            "srcUid": src_uid,
            "targetFolderId": target,
        });
        repo::messages::set_uid_and_folder(tx, msg_id, target, None)?;
        let aid = repo::actions::enqueue(
            tx,
            account_id,
            kind_str,
            Some(msg_id),
            Some(thread_id),
            &payload,
            None,
        )?;
        Ok(aid)
    }

    match kind {
        ActionKind::MarkRead | ActionKind::MarkUnread => {
            let target_read = kind == ActionKind::MarkRead;
            for (id, _f, _u, is_read, _s, _role) in &msgs {
                if *is_read != target_read {
                    repo::messages::set_read(&tx, *id, target_read)?;
                    let payload = serde_json::json!({});
                    let aid = repo::actions::enqueue(
                        &tx,
                        account_id,
                        kind.as_str(),
                        Some(*id),
                        Some(thread_id),
                        &payload,
                        None,
                    )?;
                    out.push((aid, account_id));
                }
            }
        }
        ActionKind::Star => {
            // Star the latest message only (thread-level star).
            if let Some((id, ..)) = msgs.iter().max_by_key(|m| m.0) {
                repo::messages::set_starred(&tx, *id, true)?;
                let aid = repo::actions::enqueue(
                    &tx,
                    account_id,
                    "star",
                    Some(*id),
                    Some(thread_id),
                    &serde_json::json!({}),
                    None,
                )?;
                out.push((aid, account_id));
            }
        }
        ActionKind::Unstar => {
            for (id, _f, _u, _r, is_starred, _role) in &msgs {
                if *is_starred {
                    repo::messages::set_starred(&tx, *id, false)?;
                    let aid = repo::actions::enqueue(
                        &tx,
                        account_id,
                        "unstar",
                        Some(*id),
                        Some(thread_id),
                        &serde_json::json!({}),
                        None,
                    )?;
                    out.push((aid, account_id));
                }
            }
        }
        ActionKind::Archive | ActionKind::Trash | ActionKind::Spam => {
            let (target_role, kind_str) = match kind {
                ActionKind::Archive => (roles::ARCHIVE, "archive"),
                ActionKind::Trash => (roles::TRASH, "trash"),
                _ => (roles::SPAM, "spam"),
            };
            // Gmail-style fallback: archiving with no Archive folder moves to All Mail.
            let target = folder_of(&tx, account_id, target_role)?
                .or(if kind == ActionKind::Archive {
                    folder_of(&tx, account_id, roles::ALL)?
                } else {
                    None
                })
                .ok_or_else(|| CoreError::NotFound(format!("no {target_role} folder")))?;
            let src_role = roles::INBOX;
            for (id, f, u, _r, _s, role) in &msgs {
                let movable = match kind {
                    ActionKind::Archive => role == src_role,
                    _ => role != target_role && !role.is_empty(),
                };
                if movable && f.is_some() {
                    let aid =
                        enqueue_move(&tx, account_id, thread_id, *id, *f, *u, target, kind_str)?;
                    out.push((aid, account_id));
                }
            }
            // Archiving also clears snooze.
            repo::snoozes::clear(&tx, thread_id)?;
        }
        ActionKind::Unarchive | ActionKind::NotSpam => {
            let target = folder_of(&tx, account_id, roles::INBOX)?
                .ok_or_else(|| CoreError::NotFound("no inbox folder".into()))?;
            let from_role = if kind == ActionKind::Unarchive {
                roles::ARCHIVE
            } else {
                roles::SPAM
            };
            for (id, f, u, _r, _s, role) in &msgs {
                if (role == from_role || (kind == ActionKind::Unarchive && role == roles::ALL))
                    && f.is_some()
                {
                    let aid = enqueue_move(
                        &tx,
                        account_id,
                        thread_id,
                        *id,
                        *f,
                        *u,
                        target,
                        kind.as_str(),
                    )?;
                    out.push((aid, account_id));
                }
            }
        }
        ActionKind::Move => {
            let target = params
                .and_then(|p| p.target_folder_id)
                .ok_or_else(|| CoreError::Other("move requires targetFolderId".into()))?;
            for (id, f, u, _r, _s, _role) in &msgs {
                if f.is_some() && *f != Some(target) {
                    let aid =
                        enqueue_move(&tx, account_id, thread_id, *id, *f, *u, target, "move")?;
                    out.push((aid, account_id));
                }
            }
        }
        ActionKind::Snooze => {
            let wake_at = params
                .and_then(|p| p.wake_at)
                .ok_or_else(|| CoreError::Other("snooze requires wakeAt".into()))?;
            let orig = msgs.iter().find_map(|(_, f, ..)| *f);
            repo::snoozes::set(&tx, thread_id, account_id, wake_at, orig)?;
            let aid = repo::actions::enqueue(
                &tx,
                account_id,
                "snooze",
                None,
                Some(thread_id),
                &serde_json::json!({ "wakeAt": wake_at }),
                None,
            )?;
            out.push((aid, account_id));
        }
        ActionKind::Unsnooze => {
            repo::snoozes::clear(&tx, thread_id)?;
            let aid = repo::actions::enqueue(
                &tx,
                account_id,
                "unsnooze",
                None,
                Some(thread_id),
                &serde_json::json!({}),
                None,
            )?;
            out.push((aid, account_id));
        }
        ActionKind::AddLabel | ActionKind::RemoveLabel => {
            let label_id = params
                .and_then(|p| p.label_id)
                .ok_or_else(|| CoreError::Other("label action requires labelId".into()))?;
            let label = repo::labels::get(&tx, label_id)?
                .ok_or_else(|| CoreError::NotFound(format!("label {label_id}")))?;
            let add = kind == ActionKind::AddLabel;
            let payload = serde_json::json!({ "labelId": label_id, "keyword": label.keyword });
            for (id, ..) in &msgs {
                if add {
                    repo::labels::add_to_message(&tx, *id, label_id)?;
                } else {
                    repo::labels::remove_from_message(&tx, *id, label_id)?;
                }
                // Auto labels are local-only: mutate membership but never push
                // their keyword to IMAP (server reconcile also skips them).
                if label.is_auto {
                    continue;
                }
                let aid = repo::actions::enqueue(
                    &tx,
                    account_id,
                    kind.as_str(),
                    Some(*id),
                    Some(thread_id),
                    &payload,
                    None,
                )?;
                out.push((aid, account_id));
            }
        }
        ActionKind::Send => {
            return Err(CoreError::Other("use queue_send for sending".into()));
        }
    }

    repo::threads::recompute(&tx, thread_id)?;
    tx.commit()?;
    Ok(out)
}

/// Inverse of an action: cancel if pending, revert the local mutation, and
/// enqueue a compensating remote action when the original already ran.
/// Returns the affected thread id.
fn revert_action(
    conn: &mut rusqlite::Connection,
    action: &repo::actions::PendingAction,
) -> Result<Option<i64>> {
    let was_pending = repo::actions::try_cancel(conn, action.id)?;
    let tx = conn.transaction()?;
    let thread_id = action.thread_id;

    match action.kind.as_str() {
        "mark_read" | "mark_unread" => {
            if let Some(mid) = action.message_id {
                repo::messages::set_read(&tx, mid, action.kind == "mark_unread")?;
                if !was_pending {
                    let inverse = if action.kind == "mark_read" {
                        "mark_unread"
                    } else {
                        "mark_read"
                    };
                    repo::actions::enqueue(
                        &tx,
                        action.account_id,
                        inverse,
                        Some(mid),
                        thread_id,
                        &serde_json::json!({}),
                        None,
                    )?;
                }
            }
        }
        "star" | "unstar" => {
            if let Some(mid) = action.message_id {
                repo::messages::set_starred(&tx, mid, action.kind == "unstar")?;
                if !was_pending {
                    let inverse = if action.kind == "star" {
                        "unstar"
                    } else {
                        "star"
                    };
                    repo::actions::enqueue(
                        &tx,
                        action.account_id,
                        inverse,
                        Some(mid),
                        thread_id,
                        &serde_json::json!({}),
                        None,
                    )?;
                }
            }
        }
        "archive" | "trash" | "spam" | "move" | "unarchive" | "not_spam" => {
            if let Some(mid) = action.message_id {
                let src_folder = action.payload["srcFolderId"].as_i64();
                let src_uid = action.payload["srcUid"].as_i64();
                let cur_folder = action.payload["targetFolderId"].as_i64();
                if let Some(src) = src_folder {
                    if was_pending {
                        // Remote never changed; restore the original mapping.
                        repo::messages::set_uid_and_folder(&tx, mid, src, src_uid)?;
                    } else {
                        // Remote moved; move it back.
                        repo::messages::set_uid_and_folder(&tx, mid, src, None)?;
                        let payload = serde_json::json!({
                            "srcFolderId": cur_folder,
                            "srcUid": serde_json::Value::Null,
                            "targetFolderId": src,
                        });
                        repo::actions::enqueue(
                            &tx,
                            action.account_id,
                            "move",
                            Some(mid),
                            thread_id,
                            &payload,
                            None,
                        )?;
                    }
                }
            }
        }
        "add_label" | "remove_label" => {
            if let (Some(mid), Some(label_id)) =
                (action.message_id, action.payload["labelId"].as_i64())
            {
                let was_add = action.kind == "add_label";
                // Restore the local membership to its pre-action state.
                if was_add {
                    repo::labels::remove_from_message(&tx, mid, label_id)?;
                } else {
                    repo::labels::add_to_message(&tx, mid, label_id)?;
                }
                if !was_pending {
                    // Remote already got the keyword; enqueue the inverse push.
                    let inverse = if was_add { "remove_label" } else { "add_label" };
                    repo::actions::enqueue(
                        &tx,
                        action.account_id,
                        inverse,
                        Some(mid),
                        thread_id,
                        &action.payload,
                        None,
                    )?;
                }
            }
        }
        "snooze" => {
            if let Some(tid) = thread_id {
                repo::snoozes::clear(&tx, tid)?;
            }
        }
        "unsnooze" => { /* nothing sensible to restore */ }
        "send" => { /* cancel already handled if pending; sent mail can't be unsent */ }
        _ => {}
    }

    if let Some(tid) = thread_id {
        repo::threads::recompute(&tx, tid)?;
    }
    tx.commit()?;
    Ok(thread_id)
}

#[cfg(test)]
mod ai_model_routing_tests {
    use super::*;

    #[test]
    fn blank_tier_falls_back_to_legacy_model() {
        let mut s = Settings::default();
        s.ai_model = "legacy".into();
        // Tiers default (ask/draft=intelligent, summarize=instant, voice=cheap)
        // but no tier model is set, so every scenario uses the legacy model.
        for sc in [Scenario::Ask, Scenario::Draft, Scenario::Summarize, Scenario::Voice] {
            assert_eq!(resolve_ai_model(&s, sc), "legacy");
        }
    }

    #[test]
    fn each_scenario_uses_its_tier_model() {
        let mut s = Settings::default();
        s.ai_model = "legacy".into();
        s.ai_model_instant = "fast".into();
        s.ai_model_cheap = "mid".into();
        s.ai_model_intelligent = "smart".into();
        // Defaults: ask/draft -> intelligent, summarize -> instant, voice -> cheap.
        assert_eq!(resolve_ai_model(&s, Scenario::Ask), "smart");
        assert_eq!(resolve_ai_model(&s, Scenario::Draft), "smart");
        assert_eq!(resolve_ai_model(&s, Scenario::Summarize), "fast");
        assert_eq!(resolve_ai_model(&s, Scenario::Voice), "mid");
    }

    #[test]
    fn scenario_can_be_repointed_to_another_tier() {
        let mut s = Settings::default();
        s.ai_model = "legacy".into();
        s.ai_model_instant = "fast".into();
        s.ai_tier_ask = "instant".into(); // route Ask to the instant tier
        assert_eq!(resolve_ai_model(&s, Scenario::Ask), "fast");
    }
}
