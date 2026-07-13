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
    /// Transmitting party (Sender:, Return-Path or DKIM d=) when its domain
    /// doesn't align with `from` — mailing lists, ESPs, spoofed From:.
    /// Email address or bare domain; the UI shows it as "via <domain>".
    pub via: Option<String>,
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
    /// Rich body; goes out as text/html alongside the body_text fallback.
    #[serde(default)]
    pub body_html: Option<String>,
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
    /// IMAP hierarchy delimiter (e.g. "/" or "."), for nesting user folders.
    pub delimiter: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub account_id: i64,
    pub state: String,
    pub progress: Option<f64>,
}

/// Structured action parsed by AI from a natural-language palette query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiIntent {
    /// "create_event" | "compose" | "search" | "go_to" | "none"
    pub kind: String,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub all_day: Option<bool>,
    pub to: Option<Vec<String>>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub query: Option<String>,
    pub view: Option<String>,
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
    /// Per-tier model ids, all sharing `ai_base_url` + the stored API key. An
    /// empty tier falls back to `ai_model`, so existing single-model setups keep
    /// working until tiers are configured.
    #[serde(default)]
    pub ai_model_instant: String,
    #[serde(default)]
    pub ai_model_cheap: String,
    #[serde(default)]
    pub ai_model_intelligent: String,
    /// Which tier each AI scenario uses: "instant" | "cheap" | "intelligent".
    #[serde(default = "default_tier_intelligent")]
    pub ai_tier_ask: String,
    #[serde(default = "default_tier_intelligent")]
    pub ai_tier_draft: String,
    #[serde(default = "default_tier_instant")]
    pub ai_tier_summarize: String,
    #[serde(default = "default_tier_cheap")]
    pub ai_tier_voice: String,
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
    /// Minutes before a meeting to fire a desktop reminder; 0 disables.
    #[serde(default = "default_notify_lead")]
    pub meeting_notify_lead_minutes: i64,
    /// Desktop notification on new mail.
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    /// Play a sound on new mail and when sending.
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
    /// After archiving from a conversation, open the next thread (vs. back to list).
    #[serde(default = "default_true")]
    pub auto_advance: bool,
    /// Automatic Marketing/News/Social/Pitch categorization at sync time.
    #[serde(default = "default_true")]
    pub auto_labels_enabled: bool,
    /// Group the thread list under date headers (Today / Yesterday / …).
    #[serde(default = "default_true")]
    pub group_by_date: bool,
    /// Show the unread count on the app icon (macOS Dock badge).
    #[serde(default = "default_true")]
    pub dock_badge_enabled: bool,
    /// Which count the badge shows: "inbox" (all unread) | "important".
    #[serde(default = "default_badge_source")]
    pub dock_badge_source: String,
    /// Legacy plain-text signature map, keyed by stringified account id.
    /// Superseded by `signature_list`/`signature_defaults`; retained only so old
    /// blobs deserialize and are folded in by `migrate_signatures`.
    #[serde(default)]
    pub signatures: std::collections::HashMap<String, String>,
    /// Rich signatures. An account may own several; the composer picks one by
    /// mode via `signature_defaults` (or a manual override).
    #[serde(default)]
    pub signature_list: Vec<Signature>,
    /// Which signature each account defaults to, keyed by stringified account id.
    #[serde(default)]
    pub signature_defaults: std::collections::HashMap<String, SignatureDefaults>,
}

/// A named, rich-HTML signature belonging to one account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub id: String,
    pub account_id: i64,
    pub name: String,
    /// Rich body (sanitized HTML; same markup the composer emits).
    pub html: String,
}

/// Per-account default signature choice, Gmail-style: one for new mail, one for
/// replies/forwards. `None` means "no signature".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDefaults {
    #[serde(default)]
    pub new_id: Option<String>,
    #[serde(default)]
    pub reply_id: Option<String>,
}

impl Settings {
    /// Fold a legacy plain-text `signatures` map into the rich `signature_list`
    /// on first read: one named signature per account, set as both the new-mail
    /// and reply default. Idempotent — only runs while `signature_list` is empty
    /// and legacy entries exist; clears `signatures` once folded so it never runs
    /// twice.
    pub fn migrate_signatures(&mut self) {
        if !self.signature_list.is_empty() || self.signatures.is_empty() {
            self.signatures.clear();
            return;
        }
        // Deterministic order so ids/tests are stable across runs.
        let mut entries: Vec<(String, String)> = self.signatures.drain().collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (acc_key, text) in entries {
            if text.trim().is_empty() {
                continue;
            }
            let account_id: i64 = acc_key.parse().unwrap_or(0);
            let id = format!("sig-{acc_key}");
            self.signature_list.push(Signature {
                id: id.clone(),
                account_id,
                name: "Signature".into(),
                html: text_to_html(&text),
            });
            self.signature_defaults.insert(
                acc_key,
                SignatureDefaults {
                    new_id: Some(id.clone()),
                    reply_id: Some(id),
                },
            );
        }
    }
}

/// Plain text -> minimal HTML: escape, newlines to `<br>`. Mirrors the frontend
/// `textToHtml` (src/lib/richtext.ts) so migrated signatures render identically.
fn text_to_html(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\n', "<br>")
}

fn default_true() -> bool {
    true
}

fn default_notify_lead() -> i64 {
    10
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
fn default_tier_intelligent() -> String {
    "intelligent".into()
}
fn default_tier_instant() -> String {
    "instant".into()
}
fn default_tier_cheap() -> String {
    "cheap".into()
}
fn default_badge_source() -> String {
    "inbox".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            language: "system".into(),
            undo_send_seconds: 10,
            load_remote_images: true,
            ai_base_url: default_ai_base_url(),
            ai_model: default_ai_model(),
            ai_model_instant: String::new(),
            ai_model_cheap: String::new(),
            ai_model_intelligent: String::new(),
            ai_tier_ask: default_tier_intelligent(),
            ai_tier_draft: default_tier_intelligent(),
            ai_tier_summarize: default_tier_instant(),
            ai_tier_voice: default_tier_cheap(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            ms_client_id: String::new(),
            ms_client_secret: String::new(),
            embedding_backend: default_embedding_backend(),
            embedding_model: default_embedding_model(),
            voice_drafting: false,
            voice_profile: String::new(),
            voice_learned_at: 0,
            meeting_notify_lead_minutes: 10,
            notifications_enabled: true,
            sound_enabled: true,
            auto_advance: true,
            auto_labels_enabled: true,
            group_by_date: true,
            dock_badge_enabled: true,
            dock_badge_source: default_badge_source(),
            signatures: std::collections::HashMap::new(),
            signature_list: Vec::new(),
            signature_defaults: std::collections::HashMap::new(),
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
    pub description: Option<String>,
    pub attendees: Vec<EventAttendee>,
    pub join_url: Option<String>,
    /// Our response to the invite: ACCEPTED | TENTATIVE | DECLINED.
    pub rsvp_status: Option<String>,
    /// Created in Comail (vs. parsed from an incoming invite).
    pub is_local: bool,
    /// CalDAV collection this event syncs with; None = local-only.
    pub calendar_id: Option<i64>,
    /// Raw RRULE when the event repeats (UI badges "repeats").
    pub rrule: Option<String>,
    pub starts_at: i64,
    pub ends_at: Option<i64>,
    pub all_day: bool,
    pub status: Option<String>,
    pub method: Option<String>,
}

/// A discovered CalDAV calendar collection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: i64,
    pub account_id: i64,
    pub url: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub read_only: bool,
    pub enabled: bool,
    pub is_default: bool,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAttendee {
    pub email: String,
    pub name: Option<String>,
    /// NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED
    pub partstat: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventArgs {
    pub account_id: i64,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub join_url: Option<String>,
    pub starts_at: i64,
    pub ends_at: i64,
    #[serde(default)]
    pub all_day: bool,
    /// Invites are emailed (ICS METHOD:REQUEST) to every attendee.
    #[serde(default)]
    pub attendees: Vec<Address>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RsvpEventArgs {
    pub event_id: i64,
    /// accepted | tentative | declined
    pub response: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEventArgs {
    pub event_id: i64,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub join_url: Option<String>,
    pub starts_at: i64,
    pub ends_at: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub attendees: Vec<Address>,
    /// Email an updated REQUEST ICS to attendees (organizer only).
    #[serde(default = "default_true")]
    pub notify: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectCalendarArgs {
    pub account_id: i64,
    /// "google" | "generic"
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
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
        let s: Settings = serde_json::from_str(
            r#"{"theme":"snow","undoSendSeconds":5,"loadRemoteImages":false}"#,
        )
        .unwrap();
        assert!(s.notifications_enabled);
        assert!(s.auto_advance);
        assert!(s.auto_labels_enabled);
        assert!(s.signatures.is_empty());
        assert_eq!(s.ai_base_url, crate::ai::DEFAULT_BASE_URL);
    }
}
