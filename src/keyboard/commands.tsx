// Every command in the app, in one place. The keyboard registry, the command
// palette, and the shortcut help panel all read from this list.

import { openUrl } from "@tauri-apps/plugin-opener";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import { MOCK_MODE } from "../ipc/mock";
import type { Account, Address, MessageDetail, ThreadDetail } from "../ipc/types";
import { addMonths, startOfMonth } from "../lib/calendarGrid";
import { addressName, IS_MAC, primaryCorrespondent } from "../lib/format";
import { findCachedSummary } from "../queries/actions";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";
import { inboxTabs, type CommandCtx } from "./context";
import { displayShortcut, type Command } from "./registry";

/** Bridge for composer-scoped commands (composer owns the form state). */
export type ComposerAction =
  | "send"
  | "send_done"
  | "send_later"
  | "snippet"
  | "instant_send"
  | "attach"
  | "share_availability"
  | "ai"
  | "proofread";

export function fireComposerAction(action: ComposerAction) {
  window.dispatchEvent(new CustomEvent<ComposerAction>("comail:composer-action", { detail: action }));
}

export function onComposerAction(handler: (a: ComposerAction) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent<ComposerAction>).detail);
  window.addEventListener("comail:composer-action", fn);
  return () => window.removeEventListener("comail:composer-action", fn);
}

const noOverlay = (ctx: CommandCtx) => !ctx.composerOpen && !ctx.paletteOpen && !ctx.panelOpen;
const listOrConvo = (ctx: CommandCtx) => noOverlay(ctx) && ctx.hasTargets;
/**
 * Like noOverlay but treats the open palette as transparent, so the command
 * still lists in the palette (it runs against a fresh context after closing).
 */
const noPanel = (ctx: CommandCtx) => !ctx.composerOpen && !ctx.panelOpen;

/** True while an input/textarea has focus (native shortcuts should win there). */
function editableFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

// ------------------------------------------------------------- Unsubscribe

/** Latest message carrying a List-Unsubscribe header for the focused/open thread. */
function unsubscribeMessage(ctx: CommandCtx): MessageDetail | null {
  const threadId = ctx.targets[0];
  if (threadId == null) return null;
  const detail = queryClient.getQueryData<ThreadDetail>(["thread", threadId]);
  if (!detail) return null;
  const withHeader = detail.messages.filter((m) => m.listUnsubscribe);
  if (withHeader.length === 0) return null;
  return withHeader.reduce((a, b) => (b.date >= a.date ? b : a));
}

function runUnsubscribe(ctx: CommandCtx) {
  const push = useUi.getState().pushToast;
  const msg = unsubscribeMessage(ctx);
  const raw = msg?.listUnsubscribe;
  if (!msg || !raw) {
    push({ kind: "info", message: i18n.t("commands:toast.noUnsubscribeLink") });
    return;
  }
  // Header form: "<https://x/unsub>, <mailto:u@x?subject=s>" (angle brackets optional)
  const entries = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  if (entries.length === 0) entries.push(...raw.split(",").map((s) => s.trim()).filter(Boolean));

  const https = entries.find((e) => /^https?:\/\//i.test(e));
  if (https) {
    if (MOCK_MODE) {
      push({ kind: "info", message: i18n.t("commands:toast.unsubscribeWouldOpen", { url: https }) });
    } else {
      void openUrl(https).catch((err: unknown) => {
        push({ kind: "error", message: i18n.t("commands:toast.couldNotOpenLink", { detail: errorMessage(err) }) });
      });
    }
    return;
  }

  const mailto = entries.find((e) => /^mailto:/i.test(e));
  if (mailto) {
    const addr = mailto.replace(/^mailto:/i, "").split("?")[0].trim();
    if (addr) {
      useUi.getState().openComposer({
        mode: "new",
        accountId: msg.accountId,
        initial: { to: [{ name: null, email: addr }], subject: "unsubscribe" },
      });
      return;
    }
  }
  push({ kind: "info", message: i18n.t("commands:toast.noUnsubscribeLink") });
}

// ----------------------------------------------------------- Sender search

/** Main correspondent of the open/selected thread (never one of our own
 *  accounts) — target of "View all from this sender". */
function currentSender(): Address | null {
  const ui = useUi.getState();
  const threadId = ui.openThreadId ?? ui.selectedThreadId ?? ui.selection[0] ?? null;
  if (threadId == null) return null;
  const summary = findCachedSummary(threadId);
  if (!summary) return null;
  const accounts = queryClient.getQueryData<Account[]>(["accounts"]) ?? [];
  const self = new Set(accounts.map((a) => a.email.toLowerCase()));
  return primaryCorrespondent(summary.participants, self);
}

// --------------------------------------------------------------- Calendar

/** Seed the event-create modal from the focused/open thread: subject becomes
 *  the title, everyone on the thread except our own accounts becomes an
 *  attendee (Superhuman's create-event-from-email). */
function eventPrefillFromThread(ctx: CommandCtx) {
  const threadId = ctx.ui.openThreadId ?? ctx.targets[0];
  if (threadId == null) return undefined;
  const detail = queryClient.getQueryData<ThreadDetail>(["thread", threadId]);
  if (!detail) return undefined;
  const accounts = queryClient.getQueryData<Account[]>(["accounts"]) ?? [];
  const own = new Set(accounts.map((a) => a.email.toLowerCase()));
  const seen = new Set<string>();
  const attendees = [];
  for (const m of detail.messages) {
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const e = a.email.toLowerCase();
      if (own.has(e) || seen.has(e)) continue;
      seen.add(e);
      attendees.push(a);
    }
  }
  const subject = detail.messages[0]?.subject ?? "";
  return {
    summary: subject.replace(/^((re|fwd?|aw|wg):\s*)+/i, "").trim(),
    attendees,
  };
}

function shiftCalendar(dir: 1 | -1) {
  const s = useUi.getState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const anchor = s.calendarFocusDay ?? today.getTime();
  if (s.calendarScreen && s.calendarView === "month") {
    s.set({ calendarFocusDay: addMonths(startOfMonth(anchor), dir) });
    return;
  }
  const span = s.calendarScreen || s.calendarDrawer === "week" ? 7 : 1;
  s.set({ calendarFocusDay: anchor + dir * span * 86_400_000 });
}

/** Any calendar surface (peek drawer or full-screen week) showing. */
const calendarVisible = (ctx: CommandCtx) =>
  ctx.ui.calendarDrawer != null || ctx.ui.calendarScreen;

/** Open the join link of the next (or currently running) meeting. */
async function joinNextMeeting() {
  const push = useUi.getState().pushToast;
  const now = Date.now();
  try {
    const events = await call("list_events", { startMs: now - 3_600_000, endMs: now + 86_400_000 });
    const next = events
      .filter((ev) => ev.joinUrl && ev.status?.toUpperCase() !== "CANCELLED")
      .filter((ev) => (ev.endsAt ?? ev.startsAt + 1) > now)
      .sort((a, b) => a.startsAt - b.startsAt)[0];
    if (!next) {
      push({ kind: "info", message: i18n.t("commands:toast.noMeetingToJoin") });
      return;
    }
    if (MOCK_MODE) {
      push({ kind: "info", message: i18n.t("commands:toast.unsubscribeWouldOpen", { url: next.joinUrl! }) });
      return;
    }
    await openUrl(next.joinUrl!);
  } catch (err) {
    push({ kind: "error", message: errorMessage(err) });
  }
}

// -------------------------------------------------------- Inbox split tabs

/** Cmd+1 = Important, Cmd+2 = Other, Cmd+3 = next tab (Marketing/…), … */
function splitTabCommand(n: number): Command {
  const index = n - 1;
  return {
    id: `split-tab-${n}`,
    titleKey: "commands:title.goSplitTab",
    title: () => {
      const tab = inboxTabs()[index];
      return i18n.t("commands:title.goSplitTab", { name: tab ? tab.name : `#${n}` });
    },
    aliases: ["split tab", "inbox tab", "go to tab"],
    keys: [`mod+${n}`],
    section: "Go to",
    // Not while search is open — there ⌘/Ctrl+N jumps to the Nth result.
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen && !ctx.inSearch && inboxTabs().length > index,
    run: (ctx) => ctx.gotoSplitTab(index),
  };
}

// --------------------------------------------------------- Account filter

/** Ctrl+1 = all accounts, Ctrl+2 = first account, Ctrl+3 = second, …
 *  (macOS uses Ctrl so Cmd+N stays free for split tabs; other platforms Alt). */
function switchAccountCommand(n: number): Command {
  const isAll = n === 1;
  return {
    id: `account-filter-${n}`,
    titleKey: isAll ? "commands:title.switchAccountAll" : "commands:title.switchAccount",
    titleParams: isAll ? undefined : { n: n - 1 },
    aliases: isAll ? ["all accounts", "account filter"] : [`account ${n - 1}`, "account filter"],
    keys: [IS_MAC ? `ctrl+${n}` : `alt+${n}`],
    section: "Go to",
    when: (ctx) => {
      if (ctx.composerOpen || ctx.panelOpen) return false;
      if (isAll) return true;
      const accounts = queryClient.getQueryData<Account[]>(["accounts"]) ?? [];
      return accounts.length >= n - 1;
    },
    run: () => {
      const accounts = queryClient.getQueryData<Account[]>(["accounts"]) ?? [];
      const target = isAll ? null : accounts[n - 2]?.id;
      if (!isAll && target == null) return;
      useUi.getState().set({
        accountFilter: target ?? null,
        selectedIndex: 0,
        selectedThreadId: null,
        selection: [],
      });
    },
  };
}

// ------------------------------------------------------------ AI summarize

async function summarizeThread(threadId: number) {
  const ui = useUi.getState();
  if (ui.aiSummaries[threadId]?.pending) return;
  ui.set({ aiSummaries: { ...ui.aiSummaries, [threadId]: { pending: true } } });
  try {
    const text = await call("ai_summarize", { threadId });
    const cur = useUi.getState().aiSummaries;
    useUi.getState().set({ aiSummaries: { ...cur, [threadId]: { pending: false, text } } });
  } catch (err) {
    const cur = { ...useUi.getState().aiSummaries };
    delete cur[threadId];
    useUi.getState().set({ aiSummaries: cur });
    useUi.getState().pushToast({
      kind: "error",
      message: errorMessage(err),
    });
  }
}


// ------------------------------------------------------------- Label go-to

type CachedLabel = { id: number; name: string; position: number; isAuto?: boolean };

function cachedLabels(): CachedLabel[] {
  return (
    (queryClient.getQueryData<CachedLabel[]>(["labels"]) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
  );
}

function gotoLabel(l: CachedLabel) {
  const ui = useUi.getState();
  if (l.isAuto) {
    // auto categories are inbox tabs
    ui.set({
      view: "inbox",
      splitId: null,
      labelFilter: l.id,
      folderFilter: null,
      searchOpen: false,
      searchQuery: "",
      openThreadId: null,
      focusedMessageId: null,
      selection: [],
      selectedIndex: 0,
      selectedThreadId: null,
    });
  } else {
    ui.selectLabel(l.id);
  }
}

/** "Go to <label name>" — one palette slot per cached label. */
function labelSlotCommand(i: number): Command {
  return {
    id: `go-label-${i}`,
    titleKey: "commands:title.goLabel",
    title: () => {
      const l = cachedLabels()[i];
      return i18n.t("commands:title.goLabel", { name: l ? l.name : "" });
    },
    aliases: ["label", "go to label", "filter by label"],
    keys: [],
    section: "Go to",
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen && cachedLabels().length > i,
    run: () => {
      const l = cachedLabels()[i];
      if (l) gotoLabel(l);
    },
  };
}

export const ALL_COMMANDS: Command[] = [
  // ------------------------------------------------------------- Triage
  {
    id: "mark-done",
    titleKey: "commands:title.markDone",
    aliases: ["archive", "done", "e"],
    keys: ["e"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.act("archive"),
  },
  {
    id: "unarchive",
    titleKey: "commands:title.moveToInbox",
    aliases: ["unarchive", "not done", "move to inbox"],
    keys: ["shift+e"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.act("unarchive"),
  },
  {
    id: "snooze",
    titleKey: "commands:title.snooze",
    aliases: ["remind me", "later", "h"],
    keys: ["h"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.openSnooze(),
  },
  {
    id: "star",
    titleKey: "commands:title.starUnstar",
    aliases: ["favorite", "flag"],
    keys: ["s"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.toggleStar(),
  },
  {
    id: "read",
    titleKey: "commands:title.markReadUnread",
    aliases: ["unread", "read", "seen"],
    keys: ["u"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.toggleRead(),
  },
  {
    id: "trash",
    titleKey: "commands:title.moveToTrash",
    aliases: ["delete", "remove"],
    keys: ["#"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.act("trash"),
  },
  {
    id: "spam",
    titleKey: "commands:title.markAsSpam",
    aliases: ["junk", "report spam"],
    keys: ["!"],
    section: "Triage",
    when: listOrConvo,
    run: (ctx) => ctx.act(ctx.ui.view === "spam" ? "not_spam" : "spam"),
  },
  {
    id: "select",
    titleKey: "commands:title.selectThread",
    aliases: ["multi-select", "check"],
    keys: ["x"],
    section: "Triage",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation,
    run: (ctx) => {
      const id = ctx.ui.selectedThreadId ?? ctx.ui.visibleThreadIds[ctx.ui.selectedIndex];
      if (id != null) {
        useUi.getState().toggleSelect(id);
        ctx.moveCursor(1);
      }
    },
  },
  {
    id: "select-all",
    titleKey: "commands:title.selectAll",
    aliases: ["select all", "select everything"],
    keys: ["mod+a"],
    section: "Triage",
    when: (ctx) =>
      noOverlay(ctx) &&
      !ctx.inConversation &&
      ctx.ui.visibleThreadIds.length > 0 &&
      !editableFocused(),
    run: () => {
      const s = useUi.getState();
      // Every visible thread. If they're already all selected, toggle off.
      const order = s.visibleThreadIds;
      const allSelected = order.length > 0 && order.every((id) => s.selection.includes(id));
      s.setSelection(allSelected ? [] : order);
    },
  },
  {
    id: "extend-selection-down",
    titleKey: "commands:title.extendSelectionDown",
    aliases: ["select down", "extend selection down"],
    keys: ["shift+arrowdown"],
    section: "Triage",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation && ctx.ui.visibleThreadIds.length > 0,
    run: () => useUi.getState().extendSelection(1),
  },
  {
    id: "extend-selection-up",
    titleKey: "commands:title.extendSelectionUp",
    aliases: ["select up", "extend selection up"],
    keys: ["shift+arrowup"],
    section: "Triage",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation && ctx.ui.visibleThreadIds.length > 0,
    run: () => useUi.getState().extendSelection(-1),
  },
  {
    id: "move-to-folder",
    titleKey: "commands:title.moveToFolder",
    aliases: ["move", "folder", "v"],
    keys: ["v"],
    section: "Triage",
    when: (ctx) => noPanel(ctx) && ctx.hasTargets,
    run: (ctx) => ctx.openMove(),
  },
  {
    id: "label",
    titleKey: "commands:title.label",
    aliases: ["label", "tag", "l"],
    keys: ["l"],
    section: "Triage",
    when: (ctx) => noPanel(ctx) && ctx.hasTargets,
    run: (ctx) => ctx.openLabel(),
  },
  {
    id: "unsubscribe",
    titleKey: "commands:title.unsubscribe",
    aliases: ["stop emails", "list unsubscribe", "opt out"],
    keys: [],
    shortcut: displayShortcut("mod+u"),
    section: "Triage",
    when: (ctx) => noPanel(ctx) && ctx.hasTargets && unsubscribeMessage(ctx) != null,
    run: runUnsubscribe,
  },
  {
    id: "unsubscribe-key",
    titleKey: "commands:title.unsubscribe",
    aliases: [],
    keys: ["mod+u"],
    section: "Triage",
    when: listOrConvo,
    run: runUnsubscribe,
    hiddenInPalette: true,
  },
  {
    id: "undo",
    titleKey: "commands:title.undo",
    aliases: ["revert", "oops"],
    keys: ["z", "mod+z"],
    shortcut: "Z",
    section: "Triage",
    run: (ctx) => ctx.undo(),
  },

  // ---------------------------------------------------------- Navigation
  {
    id: "next-thread",
    titleKey: "commands:title.nextThread",
    aliases: ["down"],
    // Arrows navigate messages inside an open thread (see next-message); J/K
    // stay on thread nav everywhere, so they still switch threads while reading.
    keys: ["j"],
    shortcut: "J",
    section: "Navigation",
    when: noOverlay,
    run: (ctx) => ctx.moveCursor(1),
    hiddenInPalette: true,
  },
  {
    id: "prev-thread",
    titleKey: "commands:title.prevThread",
    aliases: ["up"],
    keys: ["k"],
    shortcut: "K",
    section: "Navigation",
    when: noOverlay,
    run: (ctx) => ctx.moveCursor(-1),
    hiddenInPalette: true,
  },
  {
    // Arrow keys move the thread cursor only in the list / search — inside a
    // conversation they move between messages instead (next-message below).
    id: "list-down",
    titleKey: "commands:title.nextThread",
    aliases: [],
    keys: ["arrowdown"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation,
    run: (ctx) => ctx.moveCursor(1),
    hiddenInPalette: true,
  },
  {
    id: "list-up",
    titleKey: "commands:title.prevThread",
    aliases: [],
    keys: ["arrowup"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation,
    run: (ctx) => ctx.moveCursor(-1),
    hiddenInPalette: true,
  },
  {
    id: "open-thread",
    titleKey: "commands:title.openThread",
    aliases: ["enter"],
    keys: ["enter"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation,
    run: (ctx) => ctx.openSelected(),
    hiddenInPalette: true,
  },
  {
    id: "back",
    titleKey: "commands:title.backClose",
    aliases: ["escape", "close"],
    keys: ["escape"],
    shortcut: "Esc",
    section: "Navigation",
    run: (ctx) => ctx.escape(),
    hiddenInPalette: true,
  },
  {
    id: "next-split",
    titleKey: "commands:title.nextSplit",
    aliases: ["cycle splits", "next tab"],
    keys: ["tab"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation && !ctx.inSearch && ctx.ui.view === "inbox",
    run: (ctx) => ctx.cycleSplit(1),
  },
  {
    id: "prev-split",
    titleKey: "commands:title.prevSplit",
    aliases: ["previous tab"],
    keys: ["shift+tab"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && !ctx.inConversation && !ctx.inSearch && ctx.ui.view === "inbox",
    run: (ctx) => ctx.cycleSplit(-1),
  },
  {
    id: "next-message",
    titleKey: "commands:title.nextMessage",
    aliases: ["expand next"],
    keys: ["n", "arrowdown"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && ctx.inConversation,
    run: (ctx) => ctx.nextMessage(1),
    hiddenInPalette: true,
  },
  {
    id: "prev-message",
    titleKey: "commands:title.prevMessage",
    aliases: ["expand previous"],
    keys: ["p", "arrowup"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && ctx.inConversation,
    run: (ctx) => ctx.nextMessage(-1),
    hiddenInPalette: true,
  },
  {
    id: "go-inbox",
    titleKey: "commands:title.goInbox",
    aliases: ["inbox"],
    keys: ["g i"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("inbox"),
  },
  {
    id: "go-starred",
    titleKey: "commands:title.goStarred",
    aliases: ["starred", "favorites"],
    keys: ["g s"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("starred"),
  },
  {
    id: "go-drafts",
    titleKey: "commands:title.goDrafts",
    aliases: ["drafts"],
    keys: ["g d"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("drafts"),
  },
  {
    id: "go-sent",
    titleKey: "commands:title.goSent",
    aliases: ["sent"],
    keys: ["g t"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("sent"),
  },
  {
    id: "go-done",
    titleKey: "commands:title.goDone",
    aliases: ["archive", "done"],
    keys: ["g e"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("done"),
  },
  {
    id: "go-snoozed",
    titleKey: "commands:title.goSnoozed",
    aliases: ["reminders", "snoozed"],
    keys: ["g h"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("snoozed"),
  },
  {
    id: "go-trash",
    titleKey: "commands:title.goTrash",
    aliases: ["trash", "deleted"],
    keys: ["g #"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("trash"),
  },
  {
    id: "go-spam",
    titleKey: "commands:title.goSpam",
    aliases: ["spam", "junk"],
    keys: ["g !"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("spam"),
  },
  {
    id: "go-all",
    titleKey: "commands:title.goAll",
    aliases: ["all mail", "everything"],
    keys: ["g a"],
    section: "Go to",
    when: noOverlay,
    run: (ctx) => ctx.goto("all"),
  },
  // Go to a label: one slot per cached label so titles stay live.
  ...Array.from({ length: 9 }, (_, i) => labelSlotCommand(i)),

  // -------------------------------------------------------------- Compose
  {
    id: "compose",
    titleKey: "commands:title.compose",
    aliases: ["new email", "write"],
    keys: ["c"],
    section: "Compose",
    when: (ctx) => !ctx.composerOpen && !ctx.paletteOpen && !ctx.panelOpen,
    run: (ctx) => ctx.compose("new"),
  },
  {
    id: "reply",
    titleKey: "commands:title.reply",
    aliases: ["respond"],
    keys: ["r"],
    section: "Compose",
    when: listOrConvo,
    run: (ctx) => ctx.compose("reply"),
  },
  {
    id: "reply-all",
    titleKey: "commands:title.replyAll",
    aliases: ["respond all"],
    keys: ["enter"],
    shortcut: "↵",
    section: "Compose",
    when: (ctx) => noOverlay(ctx) && ctx.inConversation,
    run: (ctx) => ctx.compose("reply_all"),
  },
  {
    id: "forward",
    titleKey: "commands:title.forward",
    aliases: ["fwd"],
    keys: ["f"],
    section: "Compose",
    when: listOrConvo,
    run: (ctx) => ctx.compose("forward"),
  },
  {
    id: "send",
    titleKey: "commands:title.send",
    aliases: ["send now"],
    keys: ["mod+enter"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("send"),
  },
  {
    id: "send-done",
    titleKey: "commands:title.sendDone",
    aliases: ["send and archive"],
    keys: ["mod+shift+enter"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("send_done"),
  },
  {
    id: "send-later",
    titleKey: "commands:title.sendLater",
    aliases: ["schedule send", "delay"],
    keys: ["mod+shift+l"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("send_later"),
  },
  {
    id: "insert-snippet",
    titleKey: "commands:title.insertSnippet",
    aliases: ["snippet", "template"],
    keys: ["mod+;"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("snippet"),
  },
  {
    id: "instant-send",
    titleKey: "commands:title.instantSend",
    aliases: ["send immediately", "send without undo"],
    keys: ["mod+shift+z"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("instant_send"),
  },
  {
    id: "attach-files",
    titleKey: "commands:title.attachFiles",
    aliases: ["attachment", "add file", "upload"],
    keys: ["mod+shift+a"],
    section: "Compose",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("attach"),
  },

  // ------------------------------------------------------------------- AI
  {
    id: "ai-write",
    titleKey: "commands:title.aiWrite",
    aliases: ["ai draft", "compose with ai", "generate reply"],
    keys: ["mod+j"],
    section: "AI",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("ai"),
  },
  {
    id: "ai-proofread",
    titleKey: "commands:title.aiProofread",
    aliases: ["proofread", "fix grammar", "copy edit", "check spelling"],
    keys: ["mod+shift+p"],
    section: "AI",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("proofread"),
  },
  {
    id: "ai-summarize",
    titleKey: "commands:title.aiSummarize",
    aliases: ["summary", "tldr", "summarize"],
    keys: ["shift+j"],
    section: "AI",
    when: (ctx) => noPanel(ctx) && ctx.inConversation,
    run: (ctx) => {
      const threadId = ctx.ui.openThreadId;
      if (threadId != null) void summarizeThread(threadId);
    },
  },


  {
    id: "ask-ai",
    titleKey: "commands:title.askAi",
    aliases: ["ask", "ask inbox", "ask my email", "question", "rag"],
    keys: [],
    section: "AI",
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen,
    run: () => useUi.getState().set({ searchOpen: true, searchModeRequest: "ask", openThreadId: null }),
  },
  {
    id: "relabel-auto",
    titleKey: "commands:title.relabelAuto",
    aliases: ["auto labels", "recategorize", "reclassify mail"],
    keys: [],
    section: "AI",
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen,
    run: () => {
      const push = useUi.getState().pushToast;
      void call("relabel_auto", {})
        .then((n) => {
          push({ kind: "info", message: i18n.t("settings:splits.relabeled", { count: n }) });
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
          void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        })
        .catch((err: unknown) => push({ kind: "error", message: errorMessage(err) }));
    },
  },

  // ------------------------------------------------------------- Calendar
  {
    id: "calendar-today",
    titleKey: "commands:title.calendarToday",
    aliases: ["today", "events", "agenda", "peek"],
    keys: ["0"],
    section: "Calendar",
    when: noPanel,
    run: () => useUi.getState().set({ calendarDrawer: "day", calendarFocusDay: null }),
  },
  {
    id: "calendar-week",
    titleKey: "commands:title.calendarWeek",
    aliases: ["week", "next 7 days", "upcoming", "open calendar"],
    keys: ["2", "m"],
    section: "Calendar",
    // On the calendar screen itself `m` belongs to the month toggle below.
    when: (ctx) => noPanel(ctx) && !ctx.ui.calendarScreen,
    run: () =>
      useUi
        .getState()
        .set({ calendarScreen: true, calendarDrawer: null, calendarFocusDay: null }),
  },
  {
    id: "calendar-month-toggle",
    titleKey: "commands:title.calendarMonth",
    aliases: ["month", "month view", "toggle month", "week view"],
    keys: ["m"],
    section: "Calendar",
    when: (ctx) => noPanel(ctx) && ctx.ui.calendarScreen,
    run: () => {
      const s = useUi.getState();
      s.set({ calendarView: s.calendarView === "month" ? "week" : "month" });
    },
  },
  {
    id: "calendar-back-inbox",
    titleKey: "commands:title.calendarBackInbox",
    aliases: ["back to inbox"],
    keys: ["1"],
    section: "Calendar",
    hiddenInPalette: true,
    when: (ctx) => noPanel(ctx) && ctx.ui.calendarScreen,
    run: () => useUi.getState().set({ calendarScreen: false, calendarFocusDay: null }),
  },
  {
    id: "create-event",
    titleKey: "commands:title.createEvent",
    aliases: ["new event", "meeting", "schedule", "invite"],
    keys: ["b"],
    section: "Calendar",
    when: noPanel,
    run: (ctx) => useUi.getState().set({ eventCreate: { prefill: eventPrefillFromThread(ctx) } }),
  },
  {
    id: "calendar-prev",
    titleKey: "commands:title.calendarPrev",
    aliases: ["previous day", "previous week"],
    keys: ["-"],
    section: "Calendar",
    hiddenInPalette: true,
    when: (ctx) => noPanel(ctx) && calendarVisible(ctx),
    run: () => shiftCalendar(-1),
  },
  {
    id: "calendar-next",
    titleKey: "commands:title.calendarNext",
    aliases: ["next day", "next week"],
    keys: ["="],
    section: "Calendar",
    hiddenInPalette: true,
    when: (ctx) => noPanel(ctx) && calendarVisible(ctx),
    run: () => shiftCalendar(1),
  },
  {
    id: "calendar-jump-today",
    titleKey: "commands:title.calendarJumpToday",
    aliases: ["back to today"],
    keys: ["t"],
    section: "Calendar",
    hiddenInPalette: true,
    when: (ctx) => noPanel(ctx) && calendarVisible(ctx),
    run: () => useUi.getState().set({ calendarFocusDay: null }),
  },
  {
    id: "join-next-meeting",
    titleKey: "commands:title.joinNextMeeting",
    aliases: ["join", "zoom", "meet", "video call"],
    keys: [],
    section: "Calendar",
    when: noPanel,
    run: () => void joinNextMeeting(),
  },
  {
    id: "share-availability",
    titleKey: "commands:title.shareAvailability",
    aliases: ["insert free times", "availability", "find time"],
    keys: ["mod+shift+s"],
    section: "Calendar",
    when: (ctx) => ctx.composerOpen,
    run: () => fireComposerAction("share_availability"),
  },

  // ---------------------------------------------- Inbox split tabs (Cmd+N)
  ...Array.from({ length: 9 }, (_, i) => splitTabCommand(i + 1)),

  // ------------------------------------------------- Account filter (Ctrl+N)
  ...Array.from({ length: 9 }, (_, i) => switchAccountCommand(i + 1)),

  // ----------------------------------------------------------------- Meta
  {
    id: "palette",
    titleKey: "commands:title.palette",
    aliases: ["commands", "command palette"],
    keys: ["mod+k"],
    section: "Meta",
    run: (ctx) => useUi.getState().set({ paletteOpen: !ctx.paletteOpen }),
    hiddenInPalette: true,
  },
  {
    id: "search",
    titleKey: "commands:title.search",
    aliases: ["find", "lookup"],
    keys: ["/"],
    section: "Meta",
    when: (ctx) => !ctx.composerOpen && !ctx.paletteOpen && !ctx.panelOpen,
    run: () =>
      useUi.getState().set({
        calendarScreen: false,
        searchOpen: true,
        openThreadId: null,
      }),
  },
  {
    id: "view-from-sender",
    titleKey: "commands:title.viewFromSender",
    title: () => {
      const s = currentSender();
      return i18n.t("commands:title.viewFromSender", { name: s ? addressName(s) : "" });
    },
    aliases: ["view all from this sender", "all from sender", "from sender", "sender emails", "search sender"],
    keys: [],
    section: "Go to",
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen && currentSender() != null,
    run: () => {
      const s = currentSender();
      if (!s) return;
      useUi.getState().set({
        calendarScreen: false,
        searchOpen: true,
        searchQuery: `from:${s.email}`,
        openThreadId: null,
        focusedMessageId: null,
        selection: [],
      });
    },
  },
  {
    id: "help",
    titleKey: "commands:title.help",
    aliases: ["help", "keymap", "hotkeys"],
    keys: ["?"],
    shortcut: "?",
    section: "Meta",
    when: (ctx) => !ctx.composerOpen && !ctx.paletteOpen && !ctx.panelOpen,
    run: () => useUi.getState().set({ helpOpen: !useUi.getState().helpOpen }),
  },
  {
    id: "sync-now",
    titleKey: "commands:title.syncNow",
    aliases: ["refresh", "check mail"],
    keys: [],
    section: "Meta",
    run: () => {
      void call("sync_now", {}).then(() => {
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
      });
      useUi.getState().pushToast({ kind: "info", message: i18n.t("commands:toast.syncing"), durationMs: 1800 });
    },
  },
  {
    id: "open-settings",
    titleKey: "commands:title.openSettings",
    aliases: ["settings", "preferences", "accounts", "options"],
    keys: ["g ,"],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings" }),
  },
  {
    id: "open-ai-settings",
    titleKey: "commands:title.openAiSettings",
    aliases: ["ai settings", "api key", "model", "openrouter", "provider"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings", settingsTab: "ai" }),
  },
  {
    id: "open-account-settings",
    titleKey: "commands:title.openAccountSettings",
    aliases: ["accounts", "add account", "oauth", "sign in", "signature"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings", settingsTab: "accounts" }),
  },
  {
    id: "toggle-sidebar",
    titleKey: "commands:title.toggleSidebar",
    aliases: ["menu", "mailboxes", "folders", "drawer", "hamburger"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.composerOpen && !ctx.panelOpen,
    run: () => useUi.getState().set({ sidebarOpen: !useUi.getState().sidebarOpen }),
  },
  {
    id: "manage-snippets",
    titleKey: "commands:title.manageSnippets",
    aliases: ["snippets", "templates", "canned responses"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings", settingsTab: "snippets" }),
  },
  {
    id: "manage-labels",
    titleKey: "commands:title.manageLabels",
    aliases: ["labels", "tags", "colors"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings", settingsTab: "labels" }),
  },
  {
    id: "edit-splits",
    titleKey: "commands:title.editSplits",
    aliases: ["splits", "split rules", "inbox tabs"],
    keys: [],
    section: "Meta",
    when: (ctx) => !ctx.panelOpen,
    run: () => useUi.getState().set({ panel: "settings", settingsTab: "splits" }),
  },
  {
    id: "split-by-sender",
    titleKey: "commands:title.splitBySender",
    aliases: ["split by sender", "split by domain", "new split from thread"],
    keys: [],
    section: "Inbox",
    when: (ctx) => ctx.hasTargets && !ctx.panelOpen && !ctx.composerOpen,
    run: (ctx) => useUi.getState().set({ splitTarget: ctx.targets[0] ?? null }),
  },
  {
    id: "theme-snow",
    titleKey: "commands:title.themeSnow",
    aliases: ["light theme", "snow"],
    keys: [],
    section: "Meta",
    run: (ctx) => ctx.setTheme("snow"),
  },
  {
    id: "theme-carbon",
    titleKey: "commands:title.themeCarbon",
    aliases: ["dark theme", "carbon"],
    keys: [],
    section: "Meta",
    run: (ctx) => ctx.setTheme("carbon"),
  },
  {
    id: "theme-system",
    titleKey: "commands:title.themeSystem",
    aliases: ["auto theme", "follow system"],
    keys: [],
    section: "Meta",
    run: (ctx) => ctx.setTheme("system"),
  },
];
