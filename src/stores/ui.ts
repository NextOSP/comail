import { create } from "zustand";
import type {
  Address,
  ComposeMode,
  DraftAttachment,
  MessageDetail,
  Settings,
  View,
} from "../ipc/types";

export type Screen = "onboarding" | "inbox" | "conversation" | "search";

/** Management panels opened from the command palette. */
export type PanelKind = "settings" | "snippets" | "splits" | "labels";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
  /** label for the inline action button, e.g. "Undo" */
  actionLabel?: string;
  onAction?: () => void;
  /** ms epoch when the toast auto-dismisses */
  expiresAt: number;
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
    body?: string;
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

  /** Thread ids in current list order (synced by ThreadOrderSync). */
  visibleThreadIds: number[];

  selectedIndex: number;
  selectedThreadId: number | null;
  openThreadId: number | null;
  /** message index focused inside the conversation (N/P) */
  focusedMessageId: number | null;

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
  /** thread ids the snooze popover targets; null = closed */
  snoozeTarget: number[] | null;
  /** thread ids the move-to-folder popover targets; null = closed */
  moveTarget: number[] | null;
  /** thread ids the label popover targets; null = closed */
  labelTarget: number[] | null;
  /** calendar peek drawer: today / next 7 days */
  calendarDrawer: "day" | "week" | null;
  /** AI thread summaries cached per thread id (kept until dismissed) */
  aiSummaries: Record<number, { pending: boolean; text?: string }>;

  searchOpen: boolean;
  searchQuery: string;

  theme: Settings["theme"];
  keySequence: string;
  toasts: ToastItem[];
  offline: boolean;
  syncing: boolean;
  lastUndo: Undoable | null;

  // actions
  set: (partial: Partial<UiState>) => void;
  setView: (view: View, splitId?: number | null) => void;
  /** Filter the list by a label (null clears back to the current view). */
  selectLabel: (labelId: number | null) => void;
  selectThread: (index: number, id: number | null) => void;
  openThread: (id: number | null) => void;
  toggleSelect: (id: number) => void;
  /** Replace the whole selection with the given ids (deduped). */
  setSelection: (ids: number[]) => void;
  /** Select the contiguous range from the anchor to targetId (over visibleThreadIds). */
  selectRange: (targetId: number, additive: boolean) => void;
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
  visibleThreadIds: [],
  selectedIndex: 0,
  selectedThreadId: null,
  openThreadId: null,
  focusedMessageId: null,
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
  snoozeTarget: null,
  moveTarget: null,
  labelTarget: null,
  calendarDrawer: null,
  aiSummaries: {},
  searchOpen: false,
  searchQuery: "",
  theme: "system",
  keySequence: "",
  toasts: [],
  offline: false,
  syncing: false,
  lastUndo: null,

  set: (partial) => set(partial),

  setView: (view, splitId) =>
    set({
      view,
      splitId: splitId !== undefined ? splitId : view === "inbox" ? SPLIT_IMPORTANT : null,
      labelFilter: null,
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
    // Keep selectAnchorId so repeated Shift+clicks re-extend from the same anchor.
    set({ selection: [...new Set([...base, ...range])] });
  },

  clearSelection: () => set({ selection: [], selectAnchorId: null }),

  openComposer: (c) => set({ composer: c, composerDirty: false, composerConfirmOpen: false }),
  closeComposer: () => set({ composer: null, composerDirty: false, composerConfirmOpen: false }),

  pushToast: ({ durationMs = 5000, ...t }) => {
    const id = toastSeq++;
    const toast: ToastItem = { ...t, id, expiresAt: Date.now() + durationMs };
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
