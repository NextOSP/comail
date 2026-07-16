// IPC contract between the React frontend and the Rust backend.
// Rust DTOs serialize with serde(rename_all = "camelCase") to match these shapes.

export type Provider = "imap" | "gmail" | "microsoft";
export type AuthKind = "password" | "oauth2";
export type SyncState =
  "idle" | "syncing" | "error" | "needs_reauth" | "offline";

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
  /** System auto-category (Marketing/News/Social/Pitch); local-only and restorable. */
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

export interface SheetPreview {
  name: string;
  rows: string[][];
  truncated: boolean;
}

/** Safe preview payload built in Rust (see comail-core/src/preview.rs).
 *  `html` variants are ammonia-sanitized; render them in a sandboxed iframe. */
export type AttachmentPreview =
  | { kind: "image"; dataUri: string }
  | { kind: "pdf"; base64: string }
  | { kind: "html"; html: string }
  | { kind: "sheet"; sheets: SheetPreview[] }
  | { kind: "slides"; slides: { lines: string[] }[] }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "unsupported"; reason: string };

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
  /** Local-only note appended by an AI automation. */
  automationNote: string | null;
  attachments: AttachmentMeta[];
  /** raw List-Unsubscribe header value, e.g. `"<https://x/unsub>, <mailto:u@x>"` */
  listUnsubscribe: string | null;
  /** Email from the Sender: header; shown as "via <domain>" when it differs from `from`. */
  via: string | null;
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
  /** rich body; sent as text/html alongside the bodyText fallback */
  bodyHtml?: string | null;
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
  /** match a recipient (To or Cc) address or domain */
  recipients?: string[];
  /** substring match on subject */
  subjectContains?: string[];
  /** match threads carrying any of these user label ids (e.g. an AI-applied "INVOICE") */
  labels?: number[];
  /** automated mail: has List-Id / List-Unsubscribe / Precedence: bulk */
  isAutomated?: boolean;
  /** match threads that have (true) or lack (false) an attachment */
  hasAttachment?: boolean;
}

export interface SplitRule {
  id: number;
  name: string;
  position: number;
  query: SplitRuleQuery;
  /** Where matching mail is routed: undefined/null = the rule is its own tab;
   *  otherwise a route key "important" | "other" | "label:<id>". */
  target?: string | null;
}

export interface FolderInfo {
  id: number;
  accountId: number;
  imapName: string;
  /** IMAP hierarchy delimiter (e.g. "/" or "."), for nesting user folders. */
  delimiter: string | null;
  role: string | null;
}

export interface SyncStatus {
  accountId: number;
  state: SyncState;
  /** Foreground Inbox readiness. This alone controls the top-bar spinner. */
  foregroundPhase: "idle" | "inbox";
  /** Lower-priority historical work that continues after the Inbox is usable. */
  background: SyncBackgroundProgress | null;
}

export type SyncBackgroundPhase =
  "headers" | "content" | "indexing" | "retrying";

export interface SyncBackgroundProgress {
  phase: SyncBackgroundPhase;
  done: number;
  total: number;
  failed: number;
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

/** A named, rich-HTML signature belonging to one account. */
export interface Signature {
  id: string;
  accountId: number;
  name: string;
  /** Rich body (same HTML the composer emits). */
  html: string;
}

/** Per-account default signature choice: one for new mail, one for reply/forward.
 *  null/undefined means "no signature". */
export interface SignatureDefaults {
  newId?: string | null;
  replyId?: string | null;
}

/** AI model tier a scenario routes to. */
export type AiTier = "instant" | "cheap" | "intelligent";

export type AiAutomationActionKind =
  | "route_to"
  | "add_label"
  | "remove_label"
  | "mark_read"
  | "star"
  | "archive"
  | "trash"
  | "subject_prefix"
  | "body_note";

/** A deterministic action executed only after the AI matches its parent rule.
 * `value` is a route key, label id, or annotation text depending on `kind`. */
export interface AiAutomationAction {
  kind: AiAutomationActionKind;
  value: string;
}

export interface AiAutomationRule {
  id: string;
  name: string;
  /** Original natural-language request entered by the user. */
  sourcePrompt: string;
  instruction: string;
  enabled: boolean;
  actions: AiAutomationAction[];
}

export interface AiAutomationPlan {
  supported: boolean;
  name: string;
  instruction: string;
  actions: AiAutomationAction[];
  summary: string;
  issues: string[];
}

export interface Settings {
  theme: "snow" | "carbon" | "holiday" | "system";
  /** UI language: "system" follows the OS locale, otherwise a code like "en". */
  language: string;
  undoSendSeconds: number;
  loadRemoteImages: boolean;
  aiBaseUrl: string;
  aiModel: string;
  /** Per-tier model ids (shared base URL + key). Empty falls back to `aiModel`. */
  aiModelInstant: string;
  aiModelCheap: string;
  aiModelIntelligent: string;
  /** Which tier each AI scenario uses. */
  aiTierAsk: AiTier;
  aiTierDraft: AiTier;
  aiTierSummarize: AiTier;
  aiTierVoice: AiTier;
  /** OAuth app registrations; env vars (COMAIL_GOOGLE_CLIENT_ID…) override. */
  googleClientId: string;
  googleClientSecret: string;
  msClientId: string;
  /** Only for Web-type Entra registrations; leave empty for desktop apps. */
  msClientSecret: string;
  /** Desktop notification on new mail. */
  notificationsEnabled: boolean;
  /** Which incoming mail raises a desktop notification: "important" (mail that
   * lands in the Important tab, the default), "all" (every incoming message), or
   * "tabs" (only the tabs listed in `notificationTabs`). */
  notificationScope: "important" | "all" | "tabs";
  /** Route keys whose mail notifies when `notificationScope` is "tabs":
   * "important", "other", "split:<id>", or "label:<id>". */
  notificationTabs: string[];
  soundEnabled: boolean;
  /** After archiving from a conversation, open the next thread (vs. back to list). */
  autoAdvance: boolean;
  /** Automatic Marketing/News/Social/Pitch categorization at sync time. */
  autoLabelsEnabled: boolean;
  /** Sort mail that no rule catches into a category with the AI classifier. */
  aiCategorize: boolean;
  /** Natural-language description of the categories for the AI classifier. */
  aiCategoryPrompt: string;
  /** Compound AI-triggered workflows. The AI matches rules; configured actions
   * are executed deterministically by the app. */
  aiAutomationRules: AiAutomationRule[];
  /** Model tier the AI classifier uses. */
  aiTierCategorize: AiTier;
  /** Group the thread list under date headers (Today / Yesterday / …). */
  groupByDate: boolean;
  /** When true, compose "To" autocomplete suggests contacts from every account;
   * off (default) scopes suggestions to the account you're sending from. */
  contactSuggestAllAccounts: boolean;
  /** Show the unread count on the app icon (macOS Dock badge). */
  dockBadgeEnabled: boolean;
  /** Which count the badge shows: "inbox" (all unread) | "important". */
  dockBadgeSource: "inbox" | "important";
  /** Legacy plain-text signature map; superseded by signatureList/Defaults and
   *  folded in by the backend on read. Kept for type/serde compatibility. */
  signatures: Record<string, string>;
  /** Rich signatures across all accounts (an account may own several). */
  signatureList: Signature[];
  /** Which signature each account defaults to, keyed by stringified account id. */
  signatureDefaults: Record<string, SignatureDefaults>;
  /** Per-account theme override, keyed by stringified account id. Missing = global theme. */
  accountThemes: Record<string, "snow" | "carbon" | "holiday" | "system">;
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
  /** Minutes before a meeting to fire a desktop reminder; 0 disables. */
  meetingNotifyLeadMinutes: number;
}

export interface AiUsageDay {
  date: string;
  totalTokens: number;
  requests: number;
}

export interface AiUsageStats {
  totalTokens: number;
  totalRequests: number;
  todayTokens: number;
  yesterdayTokens: number;
  last7DaysTokens: number;
  last30DaysTokens: number;
  days: AiUsageDay[];
}

export interface EmailActivityDay {
  date: string;
  sent: number;
  received: number;
}

export interface EmailStats {
  totalSent: number;
  totalReceived: number;
  todaySent: number;
  todayReceived: number;
  last7DaysSent: number;
  last7DaysReceived: number;
  last30DaysSent: number;
  last30DaysReceived: number;
  days: EmailActivityDay[];
}

export interface CalendarEvent {
  id: number;
  accountId: number;
  messageId: number | null;
  summary: string | null;
  location: string | null;
  organizer: string | null;
  description: string | null;
  attendees: EventAttendee[];
  joinUrl: string | null;
  /** Our response to the invite: ACCEPTED | TENTATIVE | DECLINED. */
  rsvpStatus: string | null;
  /** Created in Comail (vs. parsed from an incoming invite). */
  isLocal: boolean;
  /** CalDAV collection this event syncs with; null = local-only. */
  calendarId: number | null;
  /** Raw RRULE when the event repeats. */
  rrule: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  status: string | null;
  method: string | null;
}

/** A discovered CalDAV calendar collection. */
export interface Calendar {
  id: number;
  accountId: number;
  url: string;
  displayName: string | null;
  color: string | null;
  readOnly: boolean;
  enabled: boolean;
  isDefault: boolean;
  lastSyncedAt: number | null;
}

export interface EventAttendee {
  email: string;
  name: string | null;
  /** NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED */
  partstat: string | null;
}

export interface CreateEventArgs {
  accountId: number;
  summary: string;
  description?: string | null;
  location?: string | null;
  joinUrl?: string | null;
  startsAt: number;
  endsAt: number;
  allDay?: boolean;
  /** Invites are emailed (ICS METHOD:REQUEST) to every attendee. */
  attendees?: Address[];
}

export type RsvpResponse = "accepted" | "tentative" | "declined";

export interface UpdateEventArgs extends CreateEventArgs {
  eventId: number;
  /** Email an updated REQUEST ICS to attendees (default true). */
  notify?: boolean;
}

export interface AiStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
}

/** Structured action parsed by AI from a natural-language palette query. */
export interface AiIntent {
  /** "create_event" | "compose" | "search" | "go_to" | "none" */
  kind: string;
  summary: string | null;
  location: string | null;
  startsAt: number | null;
  endsAt: number | null;
  allDay: boolean | null;
  to: string[] | null;
  subject: string | null;
  body: string | null;
  query: string | null;
  view: string | null;
}

/** One chronological beat of a thread, for the AI summary timeline. */
export interface TimelineEntry {
  /** Who acted - a person's name, or "You" for the account owner. */
  actor: string;
  /** A terse, past-tense description of what they did. */
  event: string;
}

/** A concrete dated item found in a thread that the user may want to review
 * and add to their calendar. Dates are ISO-8601 strings from the model. */
export interface AiCalendarSuggestion {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
}

/** Structured, sidebar-ready AI read of a whole thread (from `ai_summarize`). */
export interface AiThreadSummary {
  timeline: TimelineEntry[];
  keyPoints: string[];
  /** The single next thing to do, or null if nothing is owed. */
  nextAction: string | null;
  /** A ready-to-send draft reply, or null if no reply is warranted. */
  proposedReply: string | null;
  /** Optional event/deadline suggestion; the user must review it before saving. */
  calendarSuggestion: AiCalendarSuggestion | null;
}

export interface SearchArgs {
  query: string;
  /** Scope results to one account; null/omitted searches all accounts. */
  accountId?: number | null;
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

/** Authoritative per-account foreground and background synchronization state. */
export type SyncStatusEvent = SyncStatus;

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

export interface AskReasoningEvent {
  requestId: string;
  delta: string;
}

export interface AskDoneEvent {
  requestId: string;
}

export interface CalendarUpdatedEvent {
  accountId: number;
}

/** Desktop reminder for an upcoming meeting (per occurrence for recurrences). */
export interface CalendarReminderEvent {
  event: CalendarEvent;
  occurrenceStart: number;
}

/** Minimal shape of an event the incremental CalDAV pull just discovered. */
export interface NewEventInfo {
  summary: string | null;
  startsAt: number;
  allDay: boolean;
}

/** New calendar events arrived via an incremental sync (not initial backfill). */
export interface CalendarNewEvent {
  accountId: number;
  events: NewEventInfo[];
}

/** A local edit lost a CalDAV conflict (server won; edit kept as a copy). */
export interface CalendarConflictEvent {
  eventId: number;
  summary: string | null;
}

/** One raw response chunk for an in-progress structured thread summary. */
export interface AiSummaryTokenEvent {
  threadId: number;
  delta: string;
}

export interface EventMap {
  "sync:status": SyncStatusEvent;
  "sync:progress": SyncProgressEvent;
  "mail:new": MailNewEvent;
  "mail:updated": MailUpdatedEvent;
  "action:state": ActionStateEvent;
  "thread:woke": ThreadWokeEvent;
  "network:state": NetworkStateEvent;
  "account:state": AccountStateEvent;
  "ai:ask:citations": AskCitationsEvent;
  "ai:ask:token": AskTokenEvent;
  "ai:ask:reasoning": AskReasoningEvent;
  "ai:ask:done": AskDoneEvent;
  "ai:summary:token": AiSummaryTokenEvent;
  "calendar:updated": CalendarUpdatedEvent;
  "calendar:new": CalendarNewEvent;
  "calendar:reminder": CalendarReminderEvent;
  "calendar:conflict": CalendarConflictEvent;
  /** OS mailto: deep link; payload is the raw mailto URL. */
  "deeplink:mailto": string;
}

// ---------- Command signatures ----------

export interface Commands {
  list_accounts(args: Record<string, never>): Promise<Account[]>;
  add_account_password(args: {
    args: AddPasswordAccountArgs;
  }): Promise<Account>;
  test_connection(args: {
    args: AddPasswordAccountArgs;
  }): Promise<ConnectionTestResult>;
  remove_account(args: { accountId: number }): Promise<void>;
  start_oauth(args: { provider: Provider }): Promise<Account>;
  reauth_account(args: { accountId: number }): Promise<Account>;
  cancel_oauth(args: Record<string, never>): Promise<void>;

  list_threads(args: {
    view: View;
    splitId?: number | null;
    accountId?: number | null;
    labelId?: number | null;
    folderId?: number | null;
    cursor?: number | null;
    limit?: number;
  }): Promise<ThreadPage>;
  get_thread(args: { threadId: number }): Promise<ThreadDetail>;
  get_body(args: { messageId: number }): Promise<MessageDetail>;
  /** Extracts the attachment to disk and returns the file path. */
  get_attachment(args: { attachmentId: number }): Promise<string>;
  /** Saves (downloads) the attachment to a chosen destination path. */
  save_attachment(args: { attachmentId: number; dest: string }): Promise<void>;
  /** Reveals the app's logs folder in the OS file manager. */
  open_logs_dir(args: Record<string, never>): Promise<void>;
  /** Brings the (possibly tray-hidden) main window forward and focuses it. */
  focus_main_window(args: Record<string, never>): Promise<void>;
  /** Converts the attachment to a safe in-app preview payload. */
  preview_attachment(args: {
    attachmentId: number;
  }): Promise<AttachmentPreview>;
  list_folders(args: { accountId?: number | null }): Promise<FolderInfo[]>;

  perform_action(args: { args: PerformActionArgs }): Promise<ActionResult>;
  undo_last(args: Record<string, never>): Promise<{ undone: boolean }>;
  cancel_send(args: { actionId: number }): Promise<{ cancelled: boolean }>;
  send_now(args: { actionId: number }): Promise<{ sent: boolean }>;

  save_draft(args: { args: SaveDraftArgs }): Promise<{ draftId: number }>;
  delete_draft(args: { draftId: number }): Promise<void>;
  queue_send(args: { args: QueueSendArgs }): Promise<QueueSendResult>;
  list_contacts(args: { prefix: string; accountId?: number; limit?: number }): Promise<Address[]>;
  suggest_contacts(args: {
    query: string;
    limit?: number;
  }): Promise<ContactSuggestion[]>;

  search(args: { args: SearchArgs }): Promise<ThreadSummary[]>;
  /** Fire-and-forget: pre-computes the semantic query embedding while typing. */
  warm_search_embedding(args: { query: string }): Promise<void>;

  list_snippets(args: Record<string, never>): Promise<Snippet[]>;
  save_snippet(args: {
    snippet: Omit<Snippet, "id" | "usageCount"> & { id: number | null };
  }): Promise<Snippet>;
  delete_snippet(args: { snippetId: number }): Promise<void>;
  use_snippet(args: { snippetId: number }): Promise<void>;

  list_splits(args: Record<string, never>): Promise<SplitRule[]>;
  save_split(args: {
    split: Omit<SplitRule, "id"> & { id: number | null };
  }): Promise<SplitRule>;
  delete_split(args: { splitId: number }): Promise<void>;
  /** Persist the shared top-to-bottom order of custom splits and auto-label tabs. */
  reorder_tabs(args: {
    order: { kind: "split" | "label"; id: number }[];
  }): Promise<void>;

  list_labels(args: Record<string, never>): Promise<Label[]>;
  save_label(args: {
    label: Omit<Label, "id" | "keyword"> & { id: number | null };
  }): Promise<Label>;
  delete_label(args: { labelId: number }): Promise<void>;
  /** Recreate missing Marketing, News, Social, and Pitch categories. */
  restore_auto_labels(args: Record<string, never>): Promise<number>;

  sync_now(args: { accountId?: number | null }): Promise<void>;
  get_sync_status(args: Record<string, never>): Promise<SyncStatus[]>;
  /** Exact unread counts for split tabs and sidebar rows. */
  unread_counts(args: { accountId?: number | null }): Promise<UnreadCounts>;
  /** Re-run auto-label classification over stored mail; returns labeled count. */
  relabel_auto(args: Record<string, never>): Promise<number>;
  /** Re-resolve every thread's tab (rules + AI + heuristic); returns thread count. */
  reroute_all(args: Record<string, never>): Promise<number>;

  get_settings(args: Record<string, never>): Promise<Settings>;
  set_settings(args: { settings: Settings }): Promise<void>;

  list_events(args: {
    startMs: number;
    endMs: number;
  }): Promise<CalendarEvent[]>;
  /** Invite events carried by one message (the thread invite card). */
  events_for_message(args: { messageId: number }): Promise<CalendarEvent[]>;
  /** Create a meeting; attendees get an emailed ICS invite. */
  create_event(args: { args: CreateEventArgs }): Promise<CalendarEvent>;
  /** Answer an invite; the organizer gets an emailed ICS reply. */
  rsvp_event(args: {
    args: { eventId: number; response: RsvpResponse };
  }): Promise<CalendarEvent>;
  /** Edit an event we organize; attendees get an updated ICS when notify. */
  update_event(args: { args: UpdateEventArgs }): Promise<CalendarEvent>;
  /** Delete an event; organized events email METHOD:CANCEL when notify. */
  delete_event(args: { eventId: number; notify?: boolean }): Promise<void>;
  /**
   * Connect a calendar: "google" runs OAuth re-consent then CalDAV,
   * "microsoft" runs Graph consent (Outlook has no CalDAV), "generic" is a
   * plain CalDAV server with an app password.
   */
  connect_calendar(args: {
    args: {
      accountId: number;
      kind: "google" | "microsoft" | "generic";
      url?: string;
      username?: string;
      password?: string;
    };
  }): Promise<Calendar[]>;
  disconnect_calendar(args: { accountId: number }): Promise<void>;
  /**
   * Create a Teams online meeting (Microsoft accounts only) and return its
   * join URL. May open the browser for one-time Graph consent on first use.
   */
  create_teams_meeting(args: {
    accountId: number;
    subject: string;
    startMs: number;
    endMs: number;
  }): Promise<{ joinUrl: string }>;
  list_calendars(args: { accountId?: number | null }): Promise<Calendar[]>;
  set_calendar_enabled(args: {
    calendarId: number;
    enabled: boolean;
  }): Promise<void>;
  calendar_sync_now(args: { accountId?: number | null }): Promise<void>;

  /** Startup show (first-run intro) is done, or absent: release the deferred
   *  account sync (and with it the first OS keyring access). */
  ui_ready(args: Record<string, never>): Promise<void>;
  /** Fade (fadeMs, eval'd into the backdrop by Rust) and close (after
   *  delayMs) the intro's cinema backdrop window. Rust-side teardown: no
   *  webview capability or global-API wiring can break it. */
  cinema_close(args: {
    delayMs: number | null;
    fadeMs: number | null;
  }): Promise<void>;

  ai_status(args: Record<string, never>): Promise<AiStatus>;
  /** Model ids from the endpoint's GET /models (OpenAI-compatible). */
  ai_list_models(args: Record<string, never>): Promise<string[]>;
  ai_usage_stats(args: Record<string, never>): Promise<AiUsageStats>;
  email_stats(args: Record<string, never>): Promise<EmailStats>;
  ai_plan_automation(args: { prompt: string }): Promise<AiAutomationPlan>;
  set_ai_key(args: { apiKey: string }): Promise<void>;
  /** Parse a natural-language palette query into an executable intent. */
  ai_command(args: { query: string }): Promise<AiIntent>;
  ai_summarize(args: { threadId: number }): Promise<AiThreadSummary>;
  /** Up to 3 short thread-grounded one-tap reply suggestions (instant tier). */
  ai_quick_replies(args: { threadId: number }): Promise<string[]>;
  ai_draft(args: {
    threadId: number | null;
    /** The message the user hit reply on, so the draft targets the right one. */
    replyToMessageId: number | null;
    instruction: string;
    senderName: string | null;
    /** Write in the user's learned voice; falls back to the saved setting when omitted. */
    voice?: boolean;
    /** A signature will be appended to the draft, so the model skips its own sign-off. */
    hasSignature?: boolean;
  }): Promise<string>;
  /** Copy-edit a draft (plain text or simple HTML); returns the corrected draft. */
  ai_proofread(args: { body: string }): Promise<string>;
  /** Generate a clean email signature from an account's name/email (plain text). */
  ai_signature(args: { name: string; email: string }): Promise<string>;
  /** Learn the user's writing voice from their sent mail; returns the profile text. */
  ai_learn_voice(args: Record<string, never>): Promise<string>;
  /** RAG: answer a question grounded in the most relevant messages, with citations. */
  ai_ask(args: { question: string; requestId: string }): Promise<AskResult>;
  /** Progress of the semantic (vector) index. */
  embedding_status(args: Record<string, never>): Promise<EmbeddingStatus>;
  /** Requeue the whole mailbox for (re-)embedding; returns the number queued. */
  semantic_reindex(args: Record<string, never>): Promise<number>;
}
