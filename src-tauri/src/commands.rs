//! Thin Tauri command handlers: deserialize, call Core, serialize.

use crate::AppState;
use comail_core::models::*;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

type CmdResult<T> = Result<T, String>;

fn err(e: comail_core::error::CoreError) -> String {
    // JSON `{"code","message"}` so the frontend can localize by stable code
    // (see src/ipc/errors.ts). Falls back to the raw message when unmapped.
    e.to_ipc_json()
}

// ---------- accounts ----------

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> CmdResult<Vec<Account>> {
    state.core.list_accounts().await.map_err(err)
}

#[tauri::command]
pub async fn add_account_password(
    state: State<'_, AppState>,
    args: AddPasswordAccountArgs,
) -> CmdResult<Account> {
    state.core.add_account_password(args).await.map_err(err)
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    args: AddPasswordAccountArgs,
) -> CmdResult<ConnectionTestResult> {
    Ok(state.core.test_connection(&args).await)
}

#[tauri::command]
pub async fn remove_account(state: State<'_, AppState>, account_id: i64) -> CmdResult<()> {
    state.core.remove_account(account_id).await.map_err(err)
}

#[tauri::command]
pub async fn start_oauth(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    provider: Provider,
) -> CmdResult<Account> {
    state
        .core
        .start_oauth(provider, move |url| {
            let _ = app.opener().open_url(url, None::<String>);
        })
        .await
        .map_err(err)
}

// ---------- reading ----------

#[tauri::command]
pub async fn list_threads(
    state: State<'_, AppState>,
    view: View,
    split_id: Option<i64>,
    account_id: Option<i64>,
    label_id: Option<i64>,
    cursor: Option<i64>,
    limit: Option<i64>,
) -> CmdResult<ThreadPage> {
    state
        .core
        .list_threads(
            view,
            split_id,
            account_id,
            label_id,
            cursor,
            limit.unwrap_or(50),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_thread(state: State<'_, AppState>, thread_id: i64) -> CmdResult<ThreadDetail> {
    state.core.get_thread(thread_id).await.map_err(err)
}

#[tauri::command]
pub async fn get_body(state: State<'_, AppState>, message_id: i64) -> CmdResult<MessageDetail> {
    state.core.get_body(message_id).await.map_err(err)
}

#[tauri::command]
pub async fn list_folders(
    state: State<'_, AppState>,
    account_id: Option<i64>,
) -> CmdResult<Vec<FolderInfo>> {
    state.core.list_folders(account_id).await.map_err(err)
}

// ---------- actions ----------

#[tauri::command]
pub async fn perform_action(
    state: State<'_, AppState>,
    args: PerformActionArgs,
) -> CmdResult<ActionResult> {
    state.core.perform_action(args).await.map_err(err)
}

#[tauri::command]
pub async fn undo_last(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let undone = state.core.undo_last().await.map_err(err)?;
    Ok(serde_json::json!({ "undone": undone }))
}

#[tauri::command]
pub async fn cancel_send(
    state: State<'_, AppState>,
    action_id: i64,
) -> CmdResult<serde_json::Value> {
    let cancelled = state.core.cancel_send(action_id).await.map_err(err)?;
    Ok(serde_json::json!({ "cancelled": cancelled }))
}

// ---------- compose ----------

#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    args: SaveDraftArgs,
) -> CmdResult<serde_json::Value> {
    let draft_id = state.core.save_draft(args).await.map_err(err)?;
    Ok(serde_json::json!({ "draftId": draft_id }))
}

#[tauri::command]
pub async fn delete_draft(state: State<'_, AppState>, draft_id: i64) -> CmdResult<()> {
    state.core.delete_draft(draft_id).await.map_err(err)
}

#[tauri::command]
pub async fn queue_send(
    state: State<'_, AppState>,
    args: QueueSendArgs,
) -> CmdResult<QueueSendResult> {
    state.core.queue_send(args).await.map_err(err)
}

/// Extracts the attachment to disk and returns its path (frontend opens it
/// with the opener plugin).
#[tauri::command]
pub async fn get_attachment(state: State<'_, AppState>, attachment_id: i64) -> CmdResult<String> {
    state.core.get_attachment(attachment_id).await.map_err(err)
}

/// Converts the attachment to a safe in-app preview payload (sanitized
/// HTML / text / cell grid / base64 media) without touching the disk.
#[tauri::command]
pub async fn preview_attachment(
    state: State<'_, AppState>,
    attachment_id: i64,
) -> CmdResult<comail_core::preview::AttachmentPreview> {
    state
        .core
        .preview_attachment(attachment_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn list_contacts(
    state: State<'_, AppState>,
    prefix: String,
    limit: Option<i64>,
) -> CmdResult<Vec<Address>> {
    state
        .core
        .list_contacts(prefix, limit.unwrap_or(8))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn suggest_contacts(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> CmdResult<Vec<ContactSuggestion>> {
    state
        .core
        .suggest_contacts(query, limit.unwrap_or(4))
        .await
        .map_err(err)
}

// ---------- calendar ----------

#[tauri::command]
pub async fn list_events(
    state: State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> CmdResult<Vec<CalendarEvent>> {
    state.core.list_events(start_ms, end_ms).await.map_err(err)
}

#[tauri::command]
pub async fn events_for_message(
    state: State<'_, AppState>,
    message_id: i64,
) -> CmdResult<Vec<CalendarEvent>> {
    state.core.events_for_message(message_id).await.map_err(err)
}

#[tauri::command]
pub async fn create_event(
    state: State<'_, AppState>,
    args: CreateEventArgs,
) -> CmdResult<CalendarEvent> {
    state.core.create_event(args).await.map_err(err)
}

#[tauri::command]
pub async fn rsvp_event(
    state: State<'_, AppState>,
    args: RsvpEventArgs,
) -> CmdResult<CalendarEvent> {
    state.core.rsvp_event(args).await.map_err(err)
}

#[tauri::command]
pub async fn update_event(
    state: State<'_, AppState>,
    args: UpdateEventArgs,
) -> CmdResult<CalendarEvent> {
    state.core.update_event(args).await.map_err(err)
}

#[tauri::command]
pub async fn delete_event(
    state: State<'_, AppState>,
    event_id: i64,
    notify: Option<bool>,
) -> CmdResult<()> {
    state
        .core
        .delete_event(event_id, notify.unwrap_or(true))
        .await
        .map_err(err)
}

// ---------- caldav ----------

#[tauri::command]
pub async fn connect_calendar(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    args: ConnectCalendarArgs,
) -> CmdResult<Vec<Calendar>> {
    if args.kind == "google" {
        let account_id = args.account_id;
        state
            .core
            .connect_google_calendar(account_id, move |url| {
                let _ = app.opener().open_url(url, None::<String>);
            })
            .await
            .map_err(err)
    } else {
        state.core.connect_calendar(args).await.map_err(err)
    }
}

#[tauri::command]
pub async fn disconnect_calendar(state: State<'_, AppState>, account_id: i64) -> CmdResult<()> {
    state
        .core
        .disconnect_calendar(account_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn list_calendars(
    state: State<'_, AppState>,
    account_id: Option<i64>,
) -> CmdResult<Vec<Calendar>> {
    state.core.list_calendars(account_id).await.map_err(err)
}

#[tauri::command]
pub async fn set_calendar_enabled(
    state: State<'_, AppState>,
    calendar_id: i64,
    enabled: bool,
) -> CmdResult<()> {
    state
        .core
        .set_calendar_enabled(calendar_id, enabled)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn calendar_sync_now(
    state: State<'_, AppState>,
    account_id: Option<i64>,
) -> CmdResult<()> {
    state.core.calendar_sync_now(account_id).await;
    Ok(())
}

// ---------- AI ----------

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> CmdResult<AiStatus> {
    state.core.ai_status().await.map_err(err)
}

#[tauri::command]
pub async fn set_ai_key(state: State<'_, AppState>, api_key: String) -> CmdResult<()> {
    state.core.set_ai_key(api_key).await.map_err(err)
}

#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.core.ai_list_models().await.map_err(err)
}

#[tauri::command]
pub async fn ai_command(state: State<'_, AppState>, query: String) -> CmdResult<AiIntent> {
    state.core.ai_command(query).await.map_err(err)
}

#[tauri::command]
pub async fn ai_summarize(state: State<'_, AppState>, thread_id: i64) -> CmdResult<String> {
    state.core.ai_summarize(thread_id).await.map_err(err)
}

#[tauri::command]
pub async fn ai_draft(
    state: State<'_, AppState>,
    thread_id: Option<i64>,
    reply_to_message_id: Option<i64>,
    instruction: String,
    sender_name: Option<String>,
    voice: Option<bool>,
) -> CmdResult<String> {
    state
        .core
        .ai_draft(
            thread_id,
            reply_to_message_id,
            instruction,
            sender_name.unwrap_or_default(),
            voice,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ai_proofread(state: State<'_, AppState>, body: String) -> CmdResult<String> {
    state.core.ai_proofread(body).await.map_err(err)
}

#[tauri::command]
pub async fn ai_learn_voice(state: State<'_, AppState>) -> CmdResult<String> {
    state.core.ai_learn_voice().await.map_err(err)
}

#[tauri::command]
pub async fn ai_ask(
    state: State<'_, AppState>,
    question: String,
    request_id: String,
) -> CmdResult<AskResult> {
    state.core.ai_ask(question, request_id).await.map_err(err)
}

// ---------- semantic search / RAG index ----------

#[tauri::command]
pub async fn embedding_status(state: State<'_, AppState>) -> CmdResult<EmbeddingStatus> {
    state.core.embedding_status().await.map_err(err)
}

#[tauri::command]
pub async fn semantic_reindex(state: State<'_, AppState>) -> CmdResult<i64> {
    state.core.semantic_reindex().await.map_err(err)
}

// ---------- search ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    pub limit: Option<i64>,
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, args: SearchArgs) -> CmdResult<Vec<ThreadSummary>> {
    state
        .core
        .search(args.query, args.limit.unwrap_or(50))
        .await
        .map_err(err)
}

// ---------- snippets ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub id: Option<i64>,
    pub name: String,
    pub shortcut: Option<String>,
    pub subject: Option<String>,
    pub body_text: String,
}

#[tauri::command]
pub async fn list_snippets(state: State<'_, AppState>) -> CmdResult<Vec<Snippet>> {
    state.core.list_snippets().await.map_err(err)
}

#[tauri::command]
pub async fn save_snippet(state: State<'_, AppState>, snippet: SnippetInput) -> CmdResult<Snippet> {
    state
        .core
        .save_snippet(
            snippet.id,
            snippet.name,
            snippet.shortcut,
            snippet.subject,
            snippet.body_text,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, snippet_id: i64) -> CmdResult<()> {
    state.core.delete_snippet(snippet_id).await.map_err(err)
}

#[tauri::command]
pub async fn use_snippet(state: State<'_, AppState>, snippet_id: i64) -> CmdResult<()> {
    state.core.use_snippet(snippet_id).await.map_err(err)
}

// ---------- splits ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    pub id: Option<i64>,
    pub name: String,
    pub position: i64,
    pub query: SplitRuleQuery,
}

#[tauri::command]
pub async fn list_splits(state: State<'_, AppState>) -> CmdResult<Vec<SplitRule>> {
    state.core.list_splits().await.map_err(err)
}

#[tauri::command]
pub async fn save_split(state: State<'_, AppState>, split: SplitInput) -> CmdResult<SplitRule> {
    state
        .core
        .save_split(split.id, split.name, split.position, split.query)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn delete_split(state: State<'_, AppState>, split_id: i64) -> CmdResult<()> {
    state.core.delete_split(split_id).await.map_err(err)
}

// ---------- labels ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelInput {
    pub id: Option<i64>,
    pub name: String,
    pub color: String,
    pub position: i64,
}

#[tauri::command]
pub async fn list_labels(state: State<'_, AppState>) -> CmdResult<Vec<Label>> {
    state.core.list_labels().await.map_err(err)
}

#[tauri::command]
pub async fn save_label(state: State<'_, AppState>, label: LabelInput) -> CmdResult<Label> {
    state
        .core
        .save_label(label.id, label.name, label.color, label.position)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn delete_label(state: State<'_, AppState>, label_id: i64) -> CmdResult<()> {
    state.core.delete_label(label_id).await.map_err(err)
}

// ---------- sync / settings ----------

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>, account_id: Option<i64>) -> CmdResult<()> {
    state.core.sync_now(account_id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_sync_status(state: State<'_, AppState>) -> CmdResult<Vec<SyncStatus>> {
    state.core.get_sync_status().await.map_err(err)
}

#[tauri::command]
pub async fn relabel_auto(state: State<'_, AppState>) -> CmdResult<i64> {
    state.core.relabel_auto().await.map_err(err)
}

#[tauri::command]
pub async fn unread_counts(
    state: State<'_, AppState>,
    account_id: Option<i64>,
) -> CmdResult<UnreadCounts> {
    state.core.unread_counts(account_id).await.map_err(err)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    state.core.get_settings().await.map_err(err)
}

#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    state.core.set_settings(settings).await.map_err(err)
}
