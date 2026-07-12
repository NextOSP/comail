//! comail-core: all email logic, no Tauri dependency. The host embeds `Core`,
//! calls its async methods, and forwards `CoreEvent`s to the UI.

pub mod accounts;
pub mod ai;
pub mod autolabel;
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

#[derive(Clone)]
pub struct Core {
    pub db: Db,
    pub bus: EventBus,
    paths: Arc<Paths>,
    tokens: TokenProvider,
    handles: Arc<RwLock<HashMap<i64, AccountHandle>>>,
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

        scheduler::spawn(core.db.clone(), core.bus.clone(), core.handles.clone());

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
        let core_paths = self.paths.clone();
        let _ = core_paths;
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
                    "INSERT INTO message_bodies (message_id, text_body) VALUES (?1, ?2)
                     ON CONFLICT(message_id) DO UPDATE SET text_body = excluded.text_body",
                    rusqlite::params![draft_id, args.body_text],
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
                for att in &args.attachments {
                    tx.execute(
                        "INSERT INTO draft_attachments (draft_id, file_path, filename) VALUES (?1,?2,?3)",
                        rusqlite::params![draft_id, att.file_path, att.filename],
                    )?;
                }
                tx.execute(
                    "UPDATE messages SET has_attachments = ?2 WHERE id = ?1",
                    rusqlite::params![draft_id, (!args.attachments.is_empty()) as i64],
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

        let safe_name: String = filename
            .or(parsed_name)
            .unwrap_or_else(|| format!("attachment-{attachment_id}"))
            .chars()
            .map(|c| {
                if c == '/' || c == '\\' || c == '\0' {
                    '_'
                } else {
                    c
                }
            })
            .collect();
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
        self.db
            .read(move |conn| repo::calendar::list_range(conn, start_ms, end_ms))
            .await
    }

    // ---------- AI ----------

    async fn ai_config(&self) -> Result<ai::AiConfig> {
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
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
            base_url: settings.ai_base_url,
            model: settings.ai_model,
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

    pub async fn ai_summarize(&self, thread_id: i64) -> Result<String> {
        let cfg = self.ai_config().await?;
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
        instruction: String,
        sender_name: String,
        voice: Option<bool>,
    ) -> Result<String> {
        let cfg = self.ai_config().await?;
        let settings = self.db.read(|conn| repo::settings::get(conn)).await?;
        let use_voice = voice.unwrap_or(settings.voice_drafting);

        let (subject, context) = match thread_id {
            Some(tid) => {
                let detail = self.get_thread(tid).await?;
                (
                    detail.thread.subject.clone(),
                    ai::thread_context(&detail.messages, 24_000),
                )
            }
            None => (String::new(), String::new()),
        };

        if use_voice {
            let query = format!("{subject}\n{instruction}");
            let examples = self.voice_examples(&query, 3).await.unwrap_or_default();
            return ai::chat(
                &cfg,
                ai::draft_prompt_voiced(
                    &subject,
                    &context,
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
            ai::draft_prompt(&subject, &context, &instruction, &sender_name),
        )
        .await
    }

    /// Distill the user's writing voice from their sent mail and persist it as
    /// a style profile. Returns the profile text.
    pub async fn ai_learn_voice(&self) -> Result<String> {
        let cfg = self.ai_config().await?;
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
    pub async fn ai_ask(&self, question: String, request_id: String) -> Result<AskResult> {
        let cfg = self.ai_config().await?;
        let hits = self.vector_hits(&question, 8).await?;
        if hits.is_empty() {
            return Ok(AskResult {
                answer: "I couldn't find anything relevant in your mailbox. \
                         Make sure semantic search is enabled and indexing has finished."
                    .into(),
                citations: Vec::new(),
            });
        }

        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        let details = self
            .db
            .read(move |conn| {
                let mut out = Vec::new();
                for id in ids {
                    if let Ok(d) = repo::messages::detail(conn, id) {
                        out.push(d);
                    }
                }
                Ok::<_, CoreError>(out)
            })
            .await?;

        let citations: Vec<AskCitation> = details
            .iter()
            .map(|d| AskCitation {
                message_id: d.id,
                thread_id: d.thread_id,
                subject: d.subject.clone(),
                from: d
                    .from
                    .name
                    .clone()
                    .unwrap_or_else(|| d.from.email.clone()),
                date: d.date,
                snippet: d.snippet.clone(),
            })
            .collect();

        // Surface the sources immediately, before the (slow) answer streams.
        self.bus.emit(CoreEvent::AskCitations {
            request_id: request_id.clone(),
            citations: citations.clone(),
        });

        let context = ai::rag_context(&details, 20_000);
        let bus = self.bus.clone();
        let rid = request_id.clone();
        let answer = ai::chat_stream(&cfg, ai::ask_prompt(&question, &context), |delta| {
            bus.emit(CoreEvent::AskDelta {
                request_id: rid.clone(),
                delta: delta.to_string(),
            });
        })
        .await?;
        self.bus.emit(CoreEvent::AskDone { request_id });

        Ok(AskResult { answer, citations })
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
