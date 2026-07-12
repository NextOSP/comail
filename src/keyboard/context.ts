// Command context: the single bag of state + verbs that keyboard commands
// (and the palette) execute against. Built fresh at dispatch time.

import i18n from "../i18n";
import { call } from "../ipc/commands";
import type { ActionKind, ComposeMode, MessageDetail, Settings, View } from "../ipc/types";
import { findCachedSummary, performThreadAction, undoLastAction } from "../queries/actions";
import { queryClient } from "../queries/client";
import type { ThreadDetail } from "../ipc/types";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../stores/ui";

/** Maps an action kind to its i18n key for the undo-toast label. */
const ACTION_LABEL_KEY: Partial<Record<ActionKind, string>> = {
  archive: "commands:actionLabel.markedDone",
  unarchive: "commands:actionLabel.movedToInbox",
  trash: "commands:actionLabel.movedToTrash",
  spam: "commands:actionLabel.markedAsSpam",
  not_spam: "commands:actionLabel.notSpam",
  snooze: "commands:actionLabel.snoozed",
  unsnooze: "commands:actionLabel.unsnoozed",
  move: "commands:actionLabel.moved",
};

/** Kinds that remove the thread from the current view (drive auto-advance). */
const ADVANCING: ActionKind[] = ["archive", "trash", "spam", "snooze", "move"];

export interface CommandCtx {
  ui: ReturnType<typeof useUi.getState>;
  inConversation: boolean;
  inSearch: boolean;
  composerOpen: boolean;
  paletteOpen: boolean;
  /** a management panel (settings / snippets / splits) or the add-account modal is open */
  panelOpen: boolean;
  hasTargets: boolean;
  /** threads an action applies to: multi-select > open thread > cursor */
  targets: number[];
  act: (kind: ActionKind, params?: { wakeAt?: number; targetFolderId?: number }, label?: string) => void;
  toggleStar: () => void;
  toggleRead: () => void;
  undo: () => void;
  goto: (view: View) => void;
  moveCursor: (delta: number) => void;
  openSelected: () => void;
  nextMessage: (delta: number) => void;
  cycleSplit: (delta: number) => void;
  compose: (mode: ComposeMode) => void;
  openSnooze: () => void;
  openMove: () => void;
  openLabel: () => void;
  escape: () => void;
  setTheme: (theme: "snow" | "carbon" | "system") => void;
}

function currentTargets(ui: ReturnType<typeof useUi.getState>): number[] {
  if (ui.selection.length > 0 && ui.openThreadId == null) return ui.selection;
  if (ui.openThreadId != null) return [ui.openThreadId];
  if (ui.selectedThreadId != null) return [ui.selectedThreadId];
  return [];
}

/** After removing `removed` from view, advance the conversation / cursor. */
export function advanceAfter(removed: number[]) {
  const ui = useUi.getState();
  const removedSet = new Set(removed);
  const order = ui.visibleThreadIds;
  const anchor = ui.openThreadId ?? ui.selectedThreadId;
  const anchorIdx = anchor != null ? order.indexOf(anchor) : ui.selectedIndex;

  let next: number | null = null;
  for (let i = Math.max(anchorIdx, 0) + 1; i < order.length; i++) {
    if (!removedSet.has(order[i])) {
      next = order[i];
      break;
    }
  }
  if (next == null) {
    for (let i = Math.max(anchorIdx, 0) - 1; i >= 0; i--) {
      if (!removedSet.has(order[i])) {
        next = order[i];
        break;
      }
    }
  }

  const remaining = order.filter((id) => !removedSet.has(id));
  const nextIdx = next != null ? Math.max(0, remaining.indexOf(next)) : 0;

  if (ui.openThreadId != null) {
    // auto-advance: show the next conversation, or fall back to the list
    ui.set({
      openThreadId: next,
      focusedMessageId: null,
      selectedThreadId: next,
      selectedIndex: nextIdx,
    });
  } else {
    ui.set({ selectedThreadId: next, selectedIndex: nextIdx });
  }
}

export function buildCommandContext(): CommandCtx {
  const ui = useUi.getState();
  const targets = currentTargets(ui);

  const act: CommandCtx["act"] = (kind, params, labelOverride) => {
    if (targets.length === 0) return;
    const advancing = ADVANCING.includes(kind);
    if (advancing) {
      const autoAdvance =
        queryClient.getQueryData<Settings>(["settings"])?.autoAdvance !== false;
      if (!autoAdvance && ui.openThreadId != null) {
        // setting off: return to the list instead of opening the next thread
        useUi.getState().openThread(null);
      }
      advanceAfter(targets);
    }
    void performThreadAction(kind, targets, params);
    if (ui.selection.length > 0) ui.clearSelection();

    const labelKey = ACTION_LABEL_KEY[kind];
    const label = labelOverride ?? (labelKey ? i18n.t(labelKey) : undefined);
    if (label) {
      const n = targets.length;
      const labelWithCount = n > 1 ? `${label} (${n})` : label;
      useUi.getState().set({ lastUndo: { type: "action", label } });
      useUi.getState().pushToast({
        kind: "info",
        message: i18n.t("common:undoSuffix", { label: labelWithCount }),
        actionLabel: i18n.t("common:action.undo"),
        onAction: () => void doUndo(),
      });
    }
  };

  const doUndo = async () => {
    const state = useUi.getState();
    const last = state.lastUndo;
    if (!last) {
      void undoLastAction();
      return;
    }
    state.set({ lastUndo: null });
    if (last.type === "send") {
      state.dismissToast(last.toastId);
      try {
        const { cancelled } = await call("cancel_send", { actionId: last.actionId });
        if (cancelled) {
          state.openComposer(last.reopen);
        } else {
          state.pushToast({ kind: "error", message: i18n.t("commands:undo.tooLate") });
        }
      } catch {
        state.pushToast({ kind: "error", message: i18n.t("commands:undo.cancelFailed") });
      }
      return;
    }
    const undone = await undoLastAction();
    state.pushToast({
      kind: undone ? "info" : "error",
      message: undone ? i18n.t("commands:undo.undone") : i18n.t("commands:undo.nothingToUndo"),
      durationMs: 2500,
    });
  };

  const toggleStar = () => {
    if (targets.length === 0) return;
    const first = findCachedSummary(targets[0]);
    act(
      first?.isStarred ? "unstar" : "star",
      undefined,
      i18n.t(first?.isStarred ? "commands:actionLabel.unstarred" : "commands:actionLabel.starred"),
    );
  };

  const toggleRead = () => {
    if (targets.length === 0) return;
    const first = findCachedSummary(targets[0]);
    const unread = (first?.unreadCount ?? 0) > 0;
    act(
      unread ? "mark_read" : "mark_unread",
      undefined,
      i18n.t(unread ? "commands:actionLabel.markedRead" : "commands:actionLabel.markedUnread"),
    );
  };

  const goto = (view: View) => {
    useUi.getState().setView(view);
  };

  const moveCursor = (delta: number) => {
    const state = useUi.getState();
    const order = state.visibleThreadIds;
    if (order.length === 0) return;

    if (state.openThreadId != null) {
      // J/K inside a conversation move across threads
      const idx = order.indexOf(state.openThreadId);
      const nextIdx = Math.min(order.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
      if (order[nextIdx] !== state.openThreadId) {
        state.set({
          openThreadId: order[nextIdx],
          focusedMessageId: null,
          selectedThreadId: order[nextIdx],
          selectedIndex: nextIdx,
        });
      }
      return;
    }

    const cur = state.selectedThreadId != null ? order.indexOf(state.selectedThreadId) : -1;
    const base = cur >= 0 ? cur : Math.min(state.selectedIndex, order.length - 1);
    const nextIdx = Math.min(order.length - 1, Math.max(0, base + delta));
    state.selectThread(nextIdx, order[nextIdx] ?? null);
  };

  const openSelected = () => {
    const state = useUi.getState();
    const id = state.selectedThreadId ?? state.visibleThreadIds[state.selectedIndex] ?? null;
    if (id != null) state.openThread(id);
  };

  const nextMessage = (delta: number) => {
    const state = useUi.getState();
    if (state.openThreadId == null) return;
    const detail = queryClient.getQueryData<ThreadDetail>(["thread", state.openThreadId]);
    if (!detail || detail.messages.length === 0) return;
    const ids = detail.messages.map((m) => m.id);
    const cur = state.focusedMessageId != null ? ids.indexOf(state.focusedMessageId) : ids.length - 1;
    const next = Math.min(ids.length - 1, Math.max(0, cur + delta));
    state.set({ focusedMessageId: ids[next] });
  };

  const cycleSplit = (delta: number) => {
    const state = useUi.getState();
    if (state.view !== "inbox") return;
    const splits = queryClient.getQueryData<Array<{ id: number; position: number }>>(["splits"]) ?? [];
    const labels =
      queryClient.getQueryData<Array<{ id: number; position: number; isAuto?: boolean }>>([
        "labels",
      ]) ?? [];
    const autoOn = queryClient.getQueryData<Settings>(["settings"])?.autoLabelsEnabled !== false;
    // Combined tab list: Important, Other, custom splits, auto-label tabs.
    const tabs: { splitId: number | null; labelId: number | null }[] = [
      { splitId: SPLIT_IMPORTANT, labelId: null },
      { splitId: SPLIT_OTHER, labelId: null },
      ...[...splits]
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ splitId: s.id, labelId: null })),
      ...(autoOn
        ? labels
            .filter((l) => l.isAuto)
            .sort((a, b) => a.position - b.position)
            .map((l) => ({ splitId: null, labelId: l.id }))
        : []),
    ];
    const cur = tabs.findIndex((tab) =>
      state.labelFilter != null
        ? tab.labelId === state.labelFilter
        : tab.labelId == null && tab.splitId === (state.splitId ?? SPLIT_IMPORTANT),
    );
    const next = tabs[((cur < 0 ? 0 : cur) + delta + tabs.length) % tabs.length];
    state.set({
      splitId: next.splitId,
      labelFilter: next.labelId,
      selectedIndex: 0,
      selectedThreadId: null,
      selection: [],
    });
  };

  const compose = (mode: ComposeMode) => {
    const state = useUi.getState();
    if (mode === "new") {
      state.openComposer({ mode: "new" });
      return;
    }
    const threadId = state.openThreadId ?? state.selectedThreadId;
    if (threadId == null) return;
    const detail = queryClient.getQueryData<ThreadDetail>(["thread", threadId]);
    const msgs = detail?.messages.filter((m) => !m.isDraft) ?? [];
    const replyTo: MessageDetail | undefined =
      [...msgs].reverse().find((m) => !m.isOutgoing) ?? msgs[msgs.length - 1];
    if (!replyTo) return;
    state.openComposer({ mode, replyTo, accountId: replyTo.accountId });
  };

  const escape = () => {
    const state = useUi.getState();
    // esc-stack: palette > snooze/move/help > calendar > add-account > panel > composer > conversation > search > selection
    if (state.paletteOpen) return state.set({ paletteOpen: false });
    if (state.snoozeTarget) return state.set({ snoozeTarget: null });
    if (state.moveTarget) return state.set({ moveTarget: null });
    if (state.labelTarget) return state.set({ labelTarget: null });
    if (state.helpOpen) return state.set({ helpOpen: false });
    if (state.calendarDrawer) return state.set({ calendarDrawer: null });
    if (state.addAccountOpen) return state.set({ addAccountOpen: false });
    if (state.panel) return state.set({ panel: null });
    if (state.composer) {
      if (state.composerConfirmOpen) return state.set({ composerConfirmOpen: false });
      if (state.composerDirty) return state.set({ composerConfirmOpen: true });
      return state.closeComposer();
    }
    if (state.openThreadId != null) return state.openThread(null);
    if (state.searchOpen) return state.set({ searchOpen: false, searchQuery: "" });
    if (state.selection.length > 0) return state.clearSelection();
  };

  const setTheme = (theme: "snow" | "carbon" | "system") => {
    useUi.getState().set({ theme });
    const settings = queryClient.getQueryData<Settings>(["settings"]);
    void call("set_settings", {
      settings: {
        language: "system",
        undoSendSeconds: 10,
        loadRemoteImages: false,
        aiBaseUrl: "",
        aiModel: "",
        googleClientId: "",
        googleClientSecret: "",
        msClientId: "",
        msClientSecret: "",
        embeddingBackend: "local",
        embeddingModel: "bge-small-en-v1.5",
        voiceDrafting: false,
        voiceProfile: "",
        voiceLearnedAt: 0,
        notificationsEnabled: true,
        autoAdvance: true,
        autoLabelsEnabled: true,
        signatures: {},
        ...settings,
        theme,
      },
    });
    queryClient.setQueryData(["settings"], (s: unknown) =>
      s ? { ...(s as Record<string, unknown>), theme } : s,
    );
  };

  return {
    ui,
    inConversation: ui.openThreadId != null,
    inSearch: ui.searchOpen,
    composerOpen: ui.composer != null,
    paletteOpen: ui.paletteOpen,
    panelOpen: ui.panel != null || ui.addAccountOpen,
    hasTargets: targets.length > 0,
    targets,
    act,
    toggleStar,
    toggleRead,
    undo: () => void doUndo(),
    goto,
    moveCursor,
    openSelected,
    nextMessage,
    cycleSplit,
    compose,
    openSnooze: () => {
      if (targets.length > 0) useUi.getState().set({ snoozeTarget: targets });
    },
    openMove: () => {
      if (targets.length > 0) useUi.getState().set({ moveTarget: targets });
    },
    openLabel: () => {
      if (targets.length > 0) useUi.getState().set({ labelTarget: targets });
    },
    escape,
    setTheme,
  };
}
