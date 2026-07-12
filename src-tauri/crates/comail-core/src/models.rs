//! DTOs shared with the frontend. Field names serialize to camelCase to match
//! src/ipc/types.ts - keep the two files in sync.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Imap,
    Gmail,
    Microsoft,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Imap => "imap",
            Provider::Gmail => "gmail",
            Provider::Microsoft => "microsoft",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "gmail" => Provider::Gmail,
            "microsoft" => Provider::Microsoft,
            _ => Provider::Imap,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Password,
    Oauth2,
}

impl AuthKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthKind::Password => "password",
            AuthKind::Oauth2 => "oauth2",
        }
    }
    pub fn from_str(s: &str) -> Self {
        if s == "oauth2" {
            AuthKind::Oauth2
        } else {
            AuthKind::Password
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: Option<String>,
    pub provider: Provider,
    pub auth_kind: AuthKind,
    pub sync_state: String,
}

/// Full account row including server config - internal, never sent to frontend.
#[derive(Debug, Clone)]
pub struct AccountConfig {
    pub id: i64,
    pub email: String,
    pub display_name: Option<String>,
    pub provider: Provider,
    pub auth_kind: AuthKind,
    pub username: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

/// A contact matched by search suggestions, with its interaction affinity
/// (send_count*3 + recv_count) so the UI can show how well-known it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactSuggestion {
    pub name: Option<String>,
    pub email: String,
    pub interactions: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Inbox,
    Starred,
    Snoozed,
    Sent,
    Drafts,
    Done,
    Trash,
    Spam,
    All,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: i64,
    pub account_id: i64,
    pub account_email: String,
    pub subject: String,
    pub snippet: String,
    pub participants: Vec<Address>,
    pub last_message_at: i64,
    pub message_count: i64,
    pub unread_count: i64,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub snoozed_until: Option<i64>,
    /// Ids of labels present on any message in the thread.
    pub labels: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: i64,
    pub name: String,
    /// Hex swatch shown on chips, e.g. "#6b7280".
    pub color: String,
    /// IMAP keyword atom this label maps to on the server.
    pub keyword: String,
    pub position: i64,
    /// System auto-category (Marketing/News/Social/Pitch): classified locally
    /// at sync time, never pushed to IMAP, not deletable.
    #[serde(default)]
    pub is_auto: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: i64,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub is_inline: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub id: i64,
    pub thread_id: i64,
    pub account_id: i64,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub subject: String,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_draft: bool,
    pub is_outgoing: bool,
    pub snippet: String,
    pub body_state: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
    pub list_unsubscribe: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub thread: ThreadSummary,
    pub messages: Vec<MessageDetail>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub threads: Vec<ThreadSummary>,
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPasswordAccountArgs {
    pub email: String,
    pub display_name: Option<String>,
    pub username: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
    Archive,
    Unarchive,
    Trash,
    Spam,
    NotSpam,
    Move,
    Snooze,
    Unsnooze,
    AddLabel,
    RemoveLabel,
    Send,
}

impl ActionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionKind::MarkRead => "mark_read",
            ActionKind::MarkUnread => "mark_unread",
            ActionKind::Star => "star",
            ActionKind::Unstar => "unstar",
            ActionKind::Archive => "archive",
            ActionKind::Unarchive => "unarchive",
            ActionKind::Trash => "trash",
            ActionKind::Spam => "spam",
            ActionKind::NotSpam => "not_spam",
            ActionKind::Move => "move",
            ActionKind::Snooze => "snooze",
            ActionKind::Unsnooze => "unsnooze",
            ActionKind::AddLabel => "add_label",
            ActionKind::RemoveLabel => "remove_label",
            ActionKind::Send => "send",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "mark_read" => ActionKind::MarkRead,
            "mark_unread" => ActionKind::MarkUnread,
            "star" => ActionKind::Star,
            "unstar" => ActionKind::Unstar,
            "archive" => ActionKind::Archive,
            "unarchive" => ActionKind::Unarchive,
            "trash" => ActionKind::Trash,
            "spam" => ActionKind::Spam,
            "not_spam" => ActionKind::NotSpam,
            "move" => ActionKind::Move,
            "snooze" => ActionKind::Snooze,
            "unsnooze" => ActionKind::Unsnooze,
            "add_label" => ActionKind::AddLabel,
            "remove_label" => ActionKind::RemoveLabel,
            "send" => ActionKind::Send,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParams {
    pub wake_at: Option<i64>,
    pub target_folder_id: Option<i64>,
    pub label_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformActionArgs {
    pub kind: ActionKind,
    pub thread_ids: Vec<i64>,
    #[serde(default)]
    pub params: Option<ActionParams>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub action_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachmentIn {
    pub file_path: String,
    pub filename: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftArgs {
    pub draft_id: Option<i64>,
    pub account_id: i64,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub body_text: String,
    pub mode: String,
    pub in_reply_to_message_id: Option<i64>,
    #[serde(default)]
    pub attachments: Vec<DraftAttachmentIn>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSendArgs {
    pub draft_id: i64,
    pub send_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSendResult {
    pub action_id: i64,
    pub dispatch_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: i64,
    pub name: String,
    pub shortcut: Option<String>,
    pub subject: Option<String>,
    pub body_text: String,
    pub usage_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitRuleQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub senders: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_contains: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_automated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitRule {
    pub id: i64,
    pub name: String,
    pub position: i64,
    pub query: SplitRuleQuery,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub id: i64,
    pub account_id: i64,
    pub imap_name: String,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub account_id: i64,
    pub state: String,
    pub progress: Option<f64>,
}

/// Exact unread badge counts for split tabs and sidebar rows.
/// Map keys are stringified ids (JSON object keys must be strings).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCounts {
    pub inbox: i64,
    pub important: i64,
    pub other: i64,
    pub splits: std::collections::HashMap<String, i64>,
    pub labels: std::collections::HashMap<String, i64>,
    /// "starred" | "snoozed" | "drafts" (drafts counts all drafts, not unread)
    pub views: std::collections::HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    /// UI language: "system" follows the OS locale, otherwise a code like "en".
    #[serde(default = "default_language")]
    pub language: String,
    pub undo_send_seconds: i64,
    pub load_remote_images: bool,
    #[serde(default = "default_ai_base_url")]
    pub ai_base_url: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    /// OAuth app registrations supplied by the user. Env vars
    /// (COMAIL_GOOGLE_CLIENT_ID etc.) override these when set.
    #[serde(default)]
    pub google_client_id: String,
    #[serde(default)]
    pub google_client_secret: String,
    #[serde(default)]
    pub ms_client_id: String,
    /// Only for Web-type Entra registrations; public (desktop) clients must
    /// leave this empty or Microsoft rejects the token request.
    #[serde(default)]
    pub ms_client_secret: String,
    /// Semantic-search embedding backend: "local" | "off". Local runs a small
    /// model on-device; off disables vector indexing (keyword search only).
    #[serde(default = "default_embedding_backend")]
    pub embedding_backend: String,
    /// Registry key of the local embedding model (see `embed::registry`).
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
    /// When true, AI drafts are written in the user's learned voice.
    #[serde(default)]
    pub voice_drafting: bool,
    /// Distilled style profile learned from the user's sent mail (plain text).
    #[serde(default)]
    pub voice_profile: String,
    /// When the voice profile was last learned (ms epoch; 0 = never).
    #[serde(default)]
    pub voice_learned_at: i64,
    /// Desktop notification on new mail.
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    /// After archiving from a conversation, open the next thread (vs. back to list).
    #[serde(default = "default_true")]
    pub auto_advance: bool,
    /// Automatic Marketing/News/Social/Pitch categorization at sync time.
    #[serde(default = "default_true")]
    pub auto_labels_enabled: bool,
    /// Per-account signature appended to new mail, keyed by account id
    /// (stringified: JSON object keys must be strings).
    #[serde(default)]
    pub signatures: std::collections::HashMap<String, String>,
}

fn default_true() -> bool {
    true
}

fn default_embedding_backend() -> String {
    "local".into()
}
fn default_embedding_model() -> String {
    crate::embed::DEFAULT_MODEL.into()
}
fn default_language() -> String {
    "system".into()
}
fn default_ai_base_url() -> String {
    crate::ai::DEFAULT_BASE_URL.into()
}
fn default_ai_model() -> String {
    crate::ai::DEFAULT_MODEL.into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            language: "system".into(),
            undo_send_seconds: 10,
            load_remote_images: false,
            ai_base_url: default_ai_base_url(),
            ai_model: default_ai_model(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            ms_client_id: String::new(),
            ms_client_secret: String::new(),
            embedding_backend: default_embedding_backend(),
            embedding_model: default_embedding_model(),
            voice_drafting: false,
            voice_profile: String::new(),
            voice_learned_at: 0,
            notifications_enabled: true,
            auto_advance: true,
            auto_labels_enabled: true,
            signatures: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    /// Whether the local embedding backend is enabled.
    pub enabled: bool,
    /// Active model registry key.
    pub model: String,
    /// Messages with a cached body (embedding candidates).
    pub total: i64,
    /// Messages embedded for the active model.
    pub embedded: i64,
    /// Messages queued for embedding.
    pub pending: i64,
    /// Whether the model is loaded and the index is serving.
    pub ready: bool,
}

/// One retrieved source behind a RAG answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskCitation {
    pub message_id: i64,
    pub thread_id: i64,
    pub subject: String,
    pub from: String,
    pub date: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskResult {
    pub answer: String,
    pub citations: Vec<AskCitation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
    pub model: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: i64,
    pub account_id: i64,
    pub message_id: Option<i64>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub organizer: Option<String>,
    pub starts_at: i64,
    pub ends_at: Option<i64>,
    pub all_day: bool,
    pub status: Option<String>,
    pub method: Option<String>,
}

/// Standard IMAP folder roles.
pub mod roles {
    pub const INBOX: &str = "inbox";
    pub const ARCHIVE: &str = "archive";
    pub const SENT: &str = "sent";
    pub const DRAFTS: &str = "drafts";
    pub const TRASH: &str = "trash";
    pub const SPAM: &str = "spam";
    pub const ALL: &str = "all";
    pub const SNOOZED: &str = "snoozed";
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_kind_string_roundtrip() {
        let kinds = [
            ActionKind::MarkRead,
            ActionKind::MarkUnread,
            ActionKind::Star,
            ActionKind::Unstar,
            ActionKind::Archive,
            ActionKind::Unarchive,
            ActionKind::Trash,
            ActionKind::Spam,
            ActionKind::NotSpam,
            ActionKind::Move,
            ActionKind::Snooze,
            ActionKind::Unsnooze,
            ActionKind::AddLabel,
            ActionKind::RemoveLabel,
        ];
        for k in kinds {
            assert_eq!(ActionKind::from_str(k.as_str()), Some(k), "roundtrip {k:?}");
        }
        assert_eq!(ActionKind::from_str("bogus"), None);
    }

    #[test]
    fn provider_string_roundtrip() {
        for p in [Provider::Imap, Provider::Gmail, Provider::Microsoft] {
            assert_eq!(Provider::from_str(p.as_str()), p);
        }
    }

    #[test]
    fn settings_serde_defaults_for_new_fields() {
        let s: Settings = serde_json::from_str(r#"{"theme":"snow","undoSendSeconds":5,"loadRemoteImages":false}"#).unwrap();
        assert!(s.notifications_enabled);
        assert!(s.auto_advance);
        assert!(s.auto_labels_enabled);
        assert!(s.signatures.is_empty());
        assert_eq!(s.ai_base_url, crate::ai::DEFAULT_BASE_URL);
    }
}
