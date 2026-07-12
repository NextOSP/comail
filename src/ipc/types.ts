// IPC contract between the React frontend and the Rust backend.
// Rust DTOs serialize with serde(rename_all = "camelCase") to match these shapes.

export type Provider = "imap" | "gmail" | "microsoft";
export type AuthKind = "password" | "oauth2";
export type SyncState = "idle" | "syncing" | "error" | "needs_reauth" | "offline";

export interface Account {
  id: number;
  email: string;
  displayName: string | null;
  provider: Provider;
  authKind: AuthKind;
  syncState: SyncState;
}

export interface Address {
  name: string | null;
  email: string;
}

/** A contact matched by search suggestions, ranked by interaction affinity. */
export interface ContactSuggestion {
  name: string | null;
  email: string;
  interactions: number;
}

/** Which mailbox view the thread list shows. */
export type View =
  | "inbox"
  | "starred"
  | "snoozed"
  | "sent"
  | "drafts"
  | "done" // archive
  | "trash"
  | "spam"
  | "all";

export interface ThreadSummary {
  id: number;
  accountId: number;
  accountEmail: string;
  subject: string;
  snippet: string;
  participants: Address[];
  lastMessageAt: number; // ms epoch
  messageCount: number;
  unreadCount: number;
  isStarred: boolean;
  hasAttachments: boolean;
  snoozedUntil: number | null; // ms epoch
  /** ids of labels present on any message in the thread */
  labels: number[];
}

export interface Label {
  id: number;
  name: string;
  /** hex swatch, e.g. "#6b7280" */
  color: string;
  /** IMAP keyword atom this label maps to on the server */
  keyword: string;
  position: number;
  /** system auto-category (Marketing/News/Social/Pitch); local-only, not deletable */
  isAuto?: boolean;
}

export type BodyState = "none" | "fetching" | "cached";

export interface AttachmentMeta {
  id: number;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  isInline: boolean;
}

export interface MessageDetail {
  id: number;
  threadId: number;
  accountId: number;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: number; // ms epoch
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  isOutgoing: boolean;
  snippet: string;
  bodyState: BodyState;
  textBody: string | null;
  htmlBody: string | null; // sanitized in Rust; safe to render in sandboxed iframe
  attachments: AttachmentMeta[];
  /** raw List-Unsubscribe header value, e.g. `"<https://x/unsub>, <mailto:u@x>"` */
  listUnsubscribe: string | null;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageDetail[];
}

export interface ThreadPage {
  threads: ThreadSummary[];
  /** Pass back as `cursor` to fetch the next page; null = end. */
  nextCursor: number | null;
}

export type ActionKind =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "archive"
  | "unarchive"
  | "trash"
  | "spam"
  | "not_spam"
  | "move"
  | "snooze"
  | "unsnooze"
  | "add_label"
  | "remove_label";

export interface PerformActionArgs {
  kind: ActionKind;
  threadIds: number[];
  /** snooze: wakeAt (ms epoch). move: targetFolderId. add/remove_label: labelId. */
  params?: { wakeAt?: number; targetFolderId?: number; labelId?: number };
}

export interface ActionResult {
  actionIds: number[];
}

export interface AddPasswordAccountArgs {
  email: string;
  displayName: string | null;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
}

export type ComposeMode = "new" | "reply" | "reply_all" | "forward";

/** A file staged on a draft; the backend reads it from disk at dispatch. */
export interface DraftAttachment {
  filePath: string;
  filename: string;
}

export interface SaveDraftArgs {
  draftId: number | null;
  accountId: number;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  mode: ComposeMode;
  /** message being replied to / forwarded, for References headers + quoting */
  inReplyToMessageId: number | null;
  attachments: DraftAttachment[];
}

export interface QueueSendArgs {
  draftId: number;
  /** ms epoch; omit for "send now" (goes out after the undo window) */
  sendAt?: number;
}

export interface QueueSendResult {
  actionId: number;
  /** when the message will actually leave, ms epoch */
  dispatchAt: number;
}

export interface Snippet {
  id: number;
  name: string;
  /** typed as `;shortcut` in the composer to expand */
  shortcut: string | null;
  subject: string | null;
  bodyText: string;
  usageCount: number;
}

export interface SplitRuleQuery {
  /** match sender address or domain, e.g. "@github.com" or "boss@co.com" */
  senders?: string[];
  /** substring match on subject */
  subjectContains?: string[];
  /** automated mail: has List-Id / List-Unsubscribe / Precedence: bulk */
  isAutomated?: boolean;
}

export interface SplitRule {
  id: number;
  name: string;
  position: number;
  query: SplitRuleQuery;
}

export interface FolderInfo {
  id: number;
  accountId: number;
  imapName: string;
  role: string | null;
}

export interface SyncStatus {
  accountId: number;
  state: SyncState;
  /** 0..1 backfill progress when syncing, null otherwise */
  progress: number | null;
}

/** Exact unread badge counts; map keys are stringified split/label ids. */
export interface UnreadCounts {
  inbox: number;
  important: number;
  other: number;
  splits: Record<string, number>;
  labels: Record<string, number>;
  /** "starred" | "snoozed" | "drafts" (drafts counts all drafts) */
  views: Record<string, number>;
}

export interface Settings {
  theme: "snow" | "carbon" | "system";
  /** UI language: "system" follows the OS locale, otherwise a code like "en". */
  language: string;
  undoSendSeconds: number;
  loadRemoteImages: boolean;
  aiBaseUrl: string;
  aiModel: string;
  /** OAuth app registrations; env vars (COMAIL_GOOGLE_CLIENT_ID…) override. */
  googleClientId: string;
  googleClientSecret: string;
  msClientId: string;
  /** Only for Web-type Entra registrations; leave empty for desktop apps. */
  msClientSecret: string;
  /** Desktop notification on new mail. */
  notificationsEnabled: boolean;
  /** After archiving from a conversation, open the next thread (vs. back to list). */
  autoAdvance: boolean;
  /** Automatic Marketing/News/Social/Pitch categorization at sync time. */
  autoLabelsEnabled: boolean;
  /** Per-account signature appended to new mail, keyed by stringified account id. */
  signatures: Record<string, string>;
  /** Semantic-search backend: "local" runs a small on-device model, "off" is keyword-only. */
  embeddingBackend: "local" | "off";
  /** Registry key of the local embedding model. */
  embeddingModel: string;
  /** When true, AI drafts are written in the user's learned voice. */
  voiceDrafting: boolean;
  /** Distilled writing-style profile learned from sent mail. */
  voiceProfile: string;
  /** When the voice profile was last learned (ms epoch; 0 = never). */
  voiceLearnedAt: number;
}

export interface CalendarEvent {
  id: number;
  accountId: number;
  messageId: number | null;
  summary: string | null;
  location: string | null;
  organizer: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  status: string | null;
  method: string | null;
}

export interface AiStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
}

export interface SearchArgs {
  query: string;
  limit?: number;
}

export interface EmbeddingStatus {
  /** Whether the local embedding backend is enabled. */
  enabled: boolean;
  /** Active model registry key. */
  model: string;
  /** Messages with a cached body (embedding candidates). */
  total: number;
  /** Messages embedded for the active model. */
  embedded: number;
  /** Messages queued for embedding. */
  pending: number;
  /** Whether the model is loaded and the index is serving. */
  ready: boolean;
}

export interface AskCitation {
  messageId: number;
  threadId: number;
  subject: string;
  from: string;
  date: number;
  snippet: string;
}

export interface AskResult {
  answer: string;
  citations: AskCitation[];
}

// ---------- Events (Rust -> frontend) ----------

export interface SyncProgressEvent {
  accountId: number;
  folder: string;
  phase: "folders" | "headers" | "bodies" | "history" | "idle";
  done: number;
  total: number;
}

export interface MailNewEvent {
  accountId: number;
  threadIds: number[];
}

export interface MailUpdatedEvent {
  threadIds: number[];
}

export interface ActionStateEvent {
  actionId: number;
  state: "pending" | "inflight" | "done" | "failed" | "cancelled";
  error: string | null;
}

export interface ThreadWokeEvent {
  threadId: number;
}

export interface NetworkStateEvent {
  online: boolean;
}

export interface AccountStateEvent {
  accountId: number;
  syncState: SyncState;
}

export interface AskCitationsEvent {
  requestId: string;
  citations: AskCitation[];
}

export interface AskTokenEvent {
  requestId: string;
  delta: string;
}

export interface AskDoneEvent {
  requestId: string;
}

export interface EventMap {
  "sync:progress": SyncProgressEvent;
  "mail:new": MailNewEvent;
  "mail:updated": MailUpdatedEvent;
  "action:state": ActionStateEvent;
  "thread:woke": ThreadWokeEvent;
  "network:state": NetworkStateEvent;
  "account:state": AccountStateEvent;
  "ai:ask:citations": AskCitationsEvent;
  "ai:ask:token": AskTokenEvent;
  "ai:ask:done": AskDoneEvent;
}

// ---------- Command signatures ----------

export interface Commands {
  list_accounts(args: Record<string, never>): Promise<Account[]>;
  add_account_password(args: { args: AddPasswordAccountArgs }): Promise<Account>;
  test_connection(args: { args: AddPasswordAccountArgs }): Promise<ConnectionTestResult>;
  remove_account(args: { accountId: number }): Promise<void>;
  start_oauth(args: { provider: Provider }): Promise<Account>;

  list_threads(args: {
    view: View;
    splitId?: number | null;
    accountId?: number | null;
    labelId?: number | null;
    cursor?: number | null;
    limit?: number;
  }): Promise<ThreadPage>;
  get_thread(args: { threadId: number }): Promise<ThreadDetail>;
  get_body(args: { messageId: number }): Promise<MessageDetail>;
  /** Extracts the attachment to disk and returns the file path. */
  get_attachment(args: { attachmentId: number }): Promise<string>;
  list_folders(args: { accountId?: number | null }): Promise<FolderInfo[]>;

  perform_action(args: { args: PerformActionArgs }): Promise<ActionResult>;
  undo_last(args: Record<string, never>): Promise<{ undone: boolean }>;
  cancel_send(args: { actionId: number }): Promise<{ cancelled: boolean }>;

  save_draft(args: { args: SaveDraftArgs }): Promise<{ draftId: number }>;
  delete_draft(args: { draftId: number }): Promise<void>;
  queue_send(args: { args: QueueSendArgs }): Promise<QueueSendResult>;
  list_contacts(args: { prefix: string; limit?: number }): Promise<Address[]>;
  suggest_contacts(args: { query: string; limit?: number }): Promise<ContactSuggestion[]>;

  search(args: { args: SearchArgs }): Promise<ThreadSummary[]>;

  list_snippets(args: Record<string, never>): Promise<Snippet[]>;
  save_snippet(args: { snippet: Omit<Snippet, "id" | "usageCount"> & { id: number | null } }): Promise<Snippet>;
  delete_snippet(args: { snippetId: number }): Promise<void>;
  use_snippet(args: { snippetId: number }): Promise<void>;

  list_splits(args: Record<string, never>): Promise<SplitRule[]>;
  save_split(args: { split: Omit<SplitRule, "id"> & { id: number | null } }): Promise<SplitRule>;
  delete_split(args: { splitId: number }): Promise<void>;

  list_labels(args: Record<string, never>): Promise<Label[]>;
  save_label(args: {
    label: Omit<Label, "id" | "keyword"> & { id: number | null };
  }): Promise<Label>;
  delete_label(args: { labelId: number }): Promise<void>;

  sync_now(args: { accountId?: number | null }): Promise<void>;
  get_sync_status(args: Record<string, never>): Promise<SyncStatus[]>;
  /** Exact unread counts for split tabs and sidebar rows. */
  unread_counts(args: { accountId?: number | null }): Promise<UnreadCounts>;
  /** Re-run auto-label classification over stored mail; returns labeled count. */
  relabel_auto(args: Record<string, never>): Promise<number>;

  get_settings(args: Record<string, never>): Promise<Settings>;
  set_settings(args: { settings: Settings }): Promise<void>;

  list_events(args: { startMs: number; endMs: number }): Promise<CalendarEvent[]>;

  ai_status(args: Record<string, never>): Promise<AiStatus>;
  /** Model ids from the endpoint's GET /models (OpenAI-compatible). */
  ai_list_models(args: Record<string, never>): Promise<string[]>;
  set_ai_key(args: { apiKey: string }): Promise<void>;
  ai_summarize(args: { threadId: number }): Promise<string>;
  ai_draft(args: {
    threadId: number | null;
    /** The message the user hit reply on, so the draft targets the right one. */
    replyToMessageId: number | null;
    instruction: string;
    senderName: string | null;
    /** Write in the user's learned voice; falls back to the saved setting when omitted. */
    voice?: boolean;
  }): Promise<string>;
  /** Learn the user's writing voice from their sent mail; returns the profile text. */
  ai_learn_voice(args: Record<string, never>): Promise<string>;
  /** RAG: answer a question grounded in the most relevant messages, with citations. */
  ai_ask(args: { question: string; requestId: string }): Promise<AskResult>;
  /** Progress of the semantic (vector) index. */
  embedding_status(args: Record<string, never>): Promise<EmbeddingStatus>;
  /** Requeue the whole mailbox for (re-)embedding; returns the number queued. */
  semantic_reindex(args: Record<string, never>): Promise<number>;
}
