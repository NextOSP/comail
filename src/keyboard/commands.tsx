// Every command in the app, in one place. The keyboard registry, the command
// palette, and the shortcut help panel all read from this list.

import { openUrl } from "@tauri-apps/plugin-opener";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import { MOCK_MODE } from "../ipc/mock";
import type { Account, MessageDetail, ThreadDetail } from "../ipc/types";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";
import type { CommandCtx } from "./context";
import { displayShortcut, type Command } from "./registry";

/** Bridge for composer-scoped commands (composer owns the form state). */
export type ComposerAction =
  | "send"
  | "send_done"
  | "send_later"
  | "snippet"
  | "instant_send"
  | "attach"
  | "ai";

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

// --------------------------------------------------------- Account filter

/** Ctrl+1 = all accounts, Ctrl+2 = first account, Ctrl+3 = second, … */
function switchAccountCommand(n: number): Command {
  const isAll = n === 1;
  return {
    id: `account-filter-${n}`,
    titleKey: isAll ? "commands:title.switchAccountAll" : "commands:title.switchAccount",
    titleParams: isAll ? undefined : { n: n - 1 },
    aliases: isAll ? ["all accounts", "account filter"] : [`account ${n - 1}`, "account filter"],
    keys: [`mod+${n}`],
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
    id: "select-all-below",
    titleKey: "commands:title.selectAllFromHere",
    aliases: ["select all", "select down", "select everything"],
    keys: ["mod+a"],
    section: "Triage",
    when: (ctx) =>
      noOverlay(ctx) &&
      !ctx.inConversation &&
      ctx.ui.visibleThreadIds.length > 0 &&
      !editableFocused(),
    run: () => {
      const s = useUi.getState();
      const order = s.visibleThreadIds;
      const anchor = s.selectedThreadId != null ? order.indexOf(s.selectedThreadId) : s.selectedIndex;
      const below = order.slice(Math.max(0, anchor));
      s.set({ selection: [...new Set([...s.selection, ...below])] });
    },
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
    keys: ["j", "arrowdown"],
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
    keys: ["k", "arrowup"],
    shortcut: "K",
    section: "Navigation",
    when: noOverlay,
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
    keys: ["n"],
    section: "Navigation",
    when: (ctx) => noOverlay(ctx) && ctx.inConversation,
    run: (ctx) => ctx.nextMessage(1),
    hiddenInPalette: true,
  },
  {
    id: "prev-message",
    titleKey: "commands:title.prevMessage",
    aliases: ["expand previous"],
    keys: ["p"],
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

  // ------------------------------------------------------------- Calendar
  {
    id: "calendar-today",
    titleKey: "commands:title.calendarToday",
    aliases: ["today", "events", "agenda", "peek"],
    keys: ["0"],
    section: "Calendar",
    when: noPanel,
    run: () => useUi.getState().set({ calendarDrawer: "day" }),
  },
  {
    id: "calendar-week",
    titleKey: "commands:title.calendarWeek",
    aliases: ["week", "next 7 days", "upcoming"],
    keys: ["2"],
    section: "Calendar",
    when: noPanel,
    run: () => useUi.getState().set({ calendarDrawer: "week" }),
  },

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
    run: () => useUi.getState().set({ searchOpen: true, openThreadId: null }),
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
