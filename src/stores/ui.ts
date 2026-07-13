import { create } from "zustand";
import type {
  Address,
  AttachmentMeta,
  CalendarEvent,
  ComposeMode,
  DraftAttachment,
  MessageDetail,
  Settings,
  View,
} from "../ipc/types";

export type Screen = "onboarding" | "inbox" | "conversation" | "search" | "compose" | "calendar";

/** Management panels opened from the command palette. */
export type PanelKind = "settings" | "snippets" | "splits" | "labels";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
  /** label for the inline action button, e.g. "Undo" */
  actionLabel?: string;
  onAction?: () => void;
  /** optional second inline action, e.g. "Send now" */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** ms epoch when the toast auto-dismisses */
  expiresAt: number;
  /** total lifetime in ms (drives the countdown progress bar) */
  durationMs?: number;
  /** show a live countdown of remaining seconds (undo send) */
  countdown?: boolean;
}

export interface ComposerState {
  mode: ComposeMode;
  draftId?: number;
  accountId?: number;
  /** message being replied to / forwarded */
  replyTo?: MessageDetail;
  initial?: {
    to?: Address[];
    cc?: Address[];
    bcc?: Address[];
    subject?: string;
    /** plain-text body (legacy drafts, mailto prefills) */
    body?: string;
    /** rich body; wins over `body` when present */
    bodyHtml?: string;
    attachments?: DraftAttachment[];
  };
}

/** What Z undoes next. */
export type Undoable =
  | { type: "action"; label: string }
  | { type: "send"; actionId: number; toastId: number; reopen: ComposerState };

/**
 * splitId convention: -1 implicit "Important", -2 implicit "Other",
 * >0 custom SplitRule id, null = unsplit view.
 */
export const SPLIT_IMPORTANT = -1;
export const SPLIT_OTHER = -2;

interface UiState {
  view: View;
  splitId: number | null;
  accountFilter: number | null;
  /** when set, the thread list is filtered to this label (across all folders) */
  labelFilter: number | null;
  /** when set, the thread list shows one IMAP user folder's contents */
  folderFilter: number | null;

  /** Thread ids in current list order (synced by ThreadOrderSync). */
  visibleThreadIds: number[];

  selectedIndex: number;
  selectedThreadId: number | null;
  openThreadId: number | null;
  /** message focused inside the conversation — the reply target (hover, click,
   *  or N/P keyboard). */
  focusedMessageId: number | null;
  /** how focusedMessageId was last set; keyboard nav scrolls it into view,
   *  pointer selection (hover/click) must not, or the view would jump. */
  messageCursorSource: "keyboard" | "pointer";

  selection: number[]; // multi-select (X)
  /** anchor row for Shift+click / drag range selection (thread id) */
  selectAnchorId: number | null;

  paletteOpen: boolean;
  helpOpen: boolean;
  /** left mailbox drawer (hamburger) */
  sidebarOpen: boolean;
  /** which management panel is open (settings / snippets / splits) */
  panel: PanelKind | null;
  /** which Settings tab to open with (consumed once by SettingsPanel) */
  settingsTab: "general" | "splits" | "snippets" | "labels" | "ai" | "accounts" | null;
  /** thread id the quick-split popover targets; null = closed */
  splitTarget: number | null;
  /** show the add-account (onboarding) form as a modal on demand */
  addAccountOpen: boolean;
  composer: ComposerState | null;
  composerDirty: boolean;
  composerConfirmOpen: boolean;
  /** id of the draft the open composer is editing (set on first save; hides its card in the thread) */
  editingDraftId: number | null;
  /** thread ids the snooze popover targets; null = closed */
  snoozeTarget: number[] | null;
  /** thread ids the move-to-folder popover targets; null = closed */
  moveTarget: number[] | null;
  /** thread ids the label popover targets; null = closed */
  labelTarget: number[] | null;
  /** calendar peek drawer: today / next 7 days */
  calendarDrawer: "day" | "week" | null;
  /** full-screen week calendar (the `2` view) */
  calendarScreen: boolean;
  /** layout of the full-screen calendar (`m` toggles month) */
  calendarView: "week" | "month";
  /** day the drawer anchors on (ms day-start); null = today */
  calendarFocusDay: number | null;
  /** event-create modal; `prefill` seeds the form (create-from-email);
   *  `eventId` switches it into edit mode for that event */
  eventCreate: {
    eventId?: number;
    prefill?: {
      summary?: string;
      attendees?: Address[];
      startsAt?: number;
      endsAt?: number;
      description?: string;
      location?: string;
      joinUrl?: string;
      allDay?: boolean;
      accountId?: number;
    };
  } | null;
  /** event-detail popover, anchored near the clicked rect when given */
  eventDetail: {
    event: CalendarEvent;
    anchor?: { x: number; y: number; w: number; h: number };
  } | null;
  /** share-availability picker (inserts free times into the open composer) */
  availabilityOpen: boolean;
  /** attachment being previewed in the safe in-app viewer; null = closed */
  attachmentPreview: AttachmentMeta | null;
  /** AI thread summaries cached per thread id (kept until dismissed) */
  aiSummaries: Record<number, { pending: boolean; text?: string }>;

  searchOpen: boolean;
  /** open the search screen in this mode once (consumed by SearchScreen) */
  searchModeRequest: "search" | "ask" | null;
  searchQuery: string;

  theme: Settings["theme"];
  keySequence: string;
  toasts: ToastItem[];
  offline: boolean;
  syncing: boolean;
  /** live body-backfill progress for the "Sync x/total" indicator */
  syncDone: number;
  syncTotal: number;
  lastUndo: Undoable | null;

  // actions
  set: (partial: Partial<UiState>) => void;
  setView: (view: View, splitId?: number | null) => void;
  /** Filter the list by a label (null clears back to the current view). */
  selectLabel: (labelId: number | null) => void;
  /** Show one IMAP user folder's contents (null clears back to the current view). */
  selectFolder: (folderId: number | null) => void;
  selectThread: (index: number, id: number | null) => void;
  openThread: (id: number | null) => void;
  toggleSelect: (id: number) => void;
  /** Replace the whole selection with the given ids (deduped). */
  setSelection: (ids: number[]) => void;
  /** Select the contiguous range from the anchor to targetId (over visibleThreadIds). */
  selectRange: (targetId: number, additive: boolean) => void;
  /** Shift+Arrow: move the cursor by delta and select the range from the anchor. */
  extendSelection: (delta: 1 | -1) => void;
  clearSelection: () => void;
  openComposer: (c: ComposerState) => void;
  closeComposer: () => void;
  pushToast: (t: Omit<ToastItem, "id" | "expiresAt"> & { durationMs?: number }) => number;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useUi = create<UiState>((set, get) => ({
  view: "inbox",
  splitId: SPLIT_IMPORTANT,
  accountFilter: null,
  labelFilter: null,
  folderFilter: null,
  visibleThreadIds: [],
  selectedIndex: 0,
  selectedThreadId: null,
  openThreadId: null,
  focusedMessageId: null,
  messageCursorSource: "keyboard",
  selection: [],
  selectAnchorId: null,
  paletteOpen: false,
  helpOpen: false,
  sidebarOpen: false,
  panel: null,
  settingsTab: null,
  splitTarget: null,
  addAccountOpen: false,
  composer: null,
  composerDirty: false,
  composerConfirmOpen: false,
  editingDraftId: null,
  snoozeTarget: null,
  moveTarget: null,
  labelTarget: null,
  calendarDrawer: null,
  calendarScreen: false,
  calendarView: "week",
  calendarFocusDay: null,
  eventCreate: null,
  eventDetail: null,
  availabilityOpen: false,
  attachmentPreview: null,
  aiSummaries: {},
  searchOpen: false,
  searchModeRequest: null,
  searchQuery: "",
  theme: "system",
  keySequence: "",
  toasts: [],
  offline: false,
  syncing: false,
  syncDone: 0,
  syncTotal: 0,
  lastUndo: null,

  set: (partial) => set(partial),

  setView: (view, splitId) =>
    set({
      view,
      splitId: splitId !== undefined ? splitId : view === "inbox" ? SPLIT_IMPORTANT : null,
      labelFilter: null,
      folderFilter: null,
      openThreadId: null,
      focusedMessageId: null,
      searchOpen: false,
      selection: [],
      selectAnchorId: null,
      selectedIndex: 0,
      selectedThreadId: null,
    }),

  selectLabel: (labelId) =>
    set({
      labelFilter: labelId,
      folderFilter: null,
      // Label filter spans folders, so show it against the "all" view.
      view: "all",
      splitId: null,
      openThreadId: null,
      focusedMessageId: null,
      searchOpen: false,
      selection: [],
      selectAnchorId: null,
      selectedIndex: 0,
      selectedThreadId: null,
    }),

  selectFolder: (folderId) =>
    set({
      folderFilter: folderId,
      labelFilter: null,
      // A folder is a concrete mailbox; show it against the unfiltered "all" list.
      view: "all",
      splitId: null,
      openThreadId: null,
      focusedMessageId: null,
      searchOpen: false,
      selection: [],
      selectAnchorId: null,
      selectedIndex: 0,
      selectedThreadId: null,
    }),

  selectThread: (index, id) => set({ selectedIndex: index, selectedThreadId: id }),

  openThread: (id) =>
    set({
      openThreadId: id,
      focusedMessageId: null,
      ...(id != null ? { selectedThreadId: id } : {}),
    }),

  toggleSelect: (id) => {
    const cur = get().selection;
    set({
      selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
      selectAnchorId: id,
    });
  },

  setSelection: (ids) => set({ selection: [...new Set(ids)] }),

  selectRange: (targetId, additive) => {
    const s = get();
    const order = s.visibleThreadIds;
    const anchor = s.selectAnchorId ?? s.selectedThreadId ?? targetId;
    const ai = order.indexOf(anchor);
    const ti = order.indexOf(targetId);
    if (ai < 0 || ti < 0) {
      // Anchor or target not in the current list - fall back to a single toggle.
      get().toggleSelect(targetId);
      return;
    }
    const range = order.slice(Math.min(ai, ti), Math.max(ai, ti) + 1);
    const base = additive ? s.selection : [];
    // Persist the anchor so repeated Shift+clicks re-extend the range from the
    // same origin instead of re-anchoring to each freshly hovered row.
    set({ selection: [...new Set([...base, ...range])], selectAnchorId: anchor });
  },

  extendSelection: (delta) => {
    const s = get();
    const order = s.visibleThreadIds;
    if (order.length === 0) return;
    const curIdx = s.selectedThreadId != null ? order.indexOf(s.selectedThreadId) : s.selectedIndex;
    const base = curIdx < 0 ? 0 : curIdx;
    // With an active selection, keep extending from its anchor; otherwise start
    // fresh at the cursor (so a stale anchor can't select a surprise range).
    const anchorId =
      s.selection.length > 0 && s.selectAnchorId != null
        ? s.selectAnchorId
        : s.selectedThreadId ?? order[base];
    const ai = order.indexOf(anchorId);
    const anchorIdx = ai < 0 ? base : ai;
    const nextIdx = Math.min(order.length - 1, Math.max(0, base + delta));
    const range = order.slice(Math.min(anchorIdx, nextIdx), Math.max(anchorIdx, nextIdx) + 1);
    set({
      selection: [...new Set(range)],
      selectAnchorId: order[anchorIdx],
      selectedThreadId: order[nextIdx],
      selectedIndex: nextIdx,
    });
  },

  clearSelection: () => set({ selection: [], selectAnchorId: null }),

  openComposer: (c) =>
    set({
      composer: c,
      composerDirty: false,
      composerConfirmOpen: false,
      editingDraftId: c.draftId ?? null,
    }),
  closeComposer: () =>
    set({ composer: null, composerDirty: false, composerConfirmOpen: false, editingDraftId: null }),

  pushToast: ({ durationMs = 5000, ...t }) => {
    const id = toastSeq++;
    const toast: ToastItem = { ...t, id, durationMs, expiresAt: Date.now() + durationMs };
    set({ toasts: [...get().toasts.slice(-3), toast] });
    const timer = setTimeout(() => get().dismissToast(id), durationMs);
    toastTimers.set(id, timer);
    return id;
  },

  dismissToast: (id) => {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
