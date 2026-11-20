// Shortcut registry: one global keydown handler, chord support ("g then i"),
// and a single command list shared by the palette, keymap, and help panel.

import { useCallback, useSyncExternalStore } from "react";
import i18n from "../i18n";
import { IS_MAC } from "../lib/format";
import { useUi } from "../stores/ui";
import { buildCommandContext, type CommandCtx } from "./context";

export interface Command {
  id: string;
  /** i18n key for the display title, e.g. "commands:title.markDone" */
  titleKey: string;
  /** interpolation values for titleKey (e.g. the account number) */
  titleParams?: Record<string, unknown>;
  /** dynamic display title (wins over titleKey); re-evaluated per render,
   *  for commands whose target only exists at runtime (e.g. "Go to <label>") */
  title?: () => string;
  aliases: string[];
  /** display string, e.g. "E", "⌘K", "G then I" (auto-derived if omitted;
   *  ignored once the user rebinds the command) */
  shortcut?: string;
  /** key matchers: "e", "shift+e", "mod+enter", "g i" (chord). Defaults: the
   *  user's rebinding (Settings > Shortcuts) replaces the whole list. */
  keys: string[];
  /** Show the keys of this other command instead of our own: a palette entry
   *  whose key lives on a hidden twin with a broader `when`. Settings lists
   *  only the twin. */
  keysFrom?: string;
  /** Keys can't be changed in Settings > Shortcuts. */
  fixedKeys?: boolean;
  /** grouping for the help panel */
  section: string;
  /** context filter (palette + dispatch) */
  when?: (ctx: CommandCtx) => boolean;
  run: (ctx: CommandCtx) => void;
  /** exclude from the command palette */
  hiddenInPalette?: boolean;
}

let commands: Command[] = [];

export function registerCommands(cmds: Command[]) {
  commands = cmds;
}

export function getCommands(): Command[] {
  return commands;
}

// ---------------------------------------------------------------------------
// User rebindings (Settings > Shortcuts)
// ---------------------------------------------------------------------------

/** Command id -> the full key list the user chose ([] = unbound). Commands
 *  without an entry keep their default `keys`. */
export type KeyOverrides = Record<string, string[]>;

let overrides: KeyOverrides = {};
const overrideListeners = new Set<() => void>();

/** Adopt the persisted rebindings (App keeps this in step with Settings). */
export function setKeyOverrides(next: KeyOverrides | null | undefined) {
  const clean: KeyOverrides = {};
  for (const [id, keys] of Object.entries(next ?? {})) {
    if (Array.isArray(keys)) clean[id] = keys.filter((k) => typeof k === "string" && k !== "");
  }
  overrides = clean;
  for (const fn of overrideListeners) fn();
}

export function getKeyOverrides(): KeyOverrides {
  return overrides;
}

function subscribeKeyOverrides(fn: () => void) {
  overrideListeners.add(fn);
  return () => {
    overrideListeners.delete(fn);
  };
}

/** The keys a command answers to: the user's rebinding, else its defaults. */
export function commandKeys(cmd: Command, map: KeyOverrides = overrides): string[] {
  return map[cmd.id] ?? cmd.keys;
}

/** "mod+shift+k" -> mods ["mod", "shift"], key "k". The key may itself be
 *  "+" ("mod++"). */
export function splitKeyToken(token: string): { mods: string[]; key: string } {
  const mods: string[] = [];
  let rest = token;
  let m: RegExpExecArray | null;
  while ((m = /^(mod|ctrl|alt|shift)\+(?=.)/.exec(rest))) {
    mods.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { mods, key: rest };
}

/** `ctrl+` is its own modifier only on macOS; elsewhere Ctrl is `mod`, so a
 *  default like the palette's "ctrl+k" can never fire there. */
export function isReachableKey(keys: string): boolean {
  return IS_MAC || !keys.split(" ").some((t) => splitKeyToken(t).mods.includes("ctrl"));
}

const MOD_NAMES: Record<string, [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  ctrl: ["⌃", "Ctrl"],
  alt: ["⌥", "Alt"],
  shift: ["⇧", "Shift"],
};

const KEY_NAMES: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function displayToken(token: string): string {
  const { mods, key } = splitKeyToken(token);
  const out = mods.map((m) => MOD_NAMES[m][IS_MAC ? 0 : 1]);
  out.push(KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)));
  return out.join(IS_MAC ? "" : "+");
}

/** "mod+shift+enter" -> "⌘⇧↵" / "Ctrl+Shift+↵"; "g i" -> "G then I" */
export function displayShortcut(keys: string | undefined): string {
  if (!keys) return "";
  return keys.split(" ").map(displayToken).join(" then ");
}

export function shortcutFor(cmd: Command, map: KeyOverrides = overrides): string {
  const owner = (cmd.keysFrom && commands.find((c) => c.id === cmd.keysFrom)) || cmd;
  const custom = map[owner.id];
  if (custom) return displayShortcut(custom.find(isReachableKey));
  return owner.shortcut ?? displayShortcut(owner.keys[0]);
}

/** How a hint names command `id`'s shortcut: `prefer` while the command still
 *  answers to it (the ↓ of next-message rather than its first key, N), else
 *  its first key; "" when it has none (unbound, or unknown id). */
export function shortcutHint(id: string, prefer?: string, map: KeyOverrides = overrides): string {
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return "";
  if (prefer && commandKeys(cmd, map).includes(prefer)) return displayShortcut(prefer);
  return shortcutFor(cmd, map);
}

/** `shortcutHint` for components: re-renders them when the user rebinds keys. */
export function useShortcutHint(): (id: string, prefer?: string) => string {
  const map = useSyncExternalStore(subscribeKeyOverrides, getKeyOverrides);
  return useCallback((id: string, prefer?: string) => shortcutHint(id, prefer, map), [map]);
}

/** "Label (⌘K)", or just "Label" when the command has no key. */
export function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Action toast text: "Marked done · Z to undo" with undo's current key, or
 *  just the label when undo has none (the toast's Undo button still works). */
export function withUndoHint(label: string): string {
  const key = shortcutHint("undo");
  return key ? i18n.t("common:undoSuffix", { label, key }) : label;
}

// ---------------------------------------------------------------------------
// Global keydown dispatch
// ---------------------------------------------------------------------------

/** How long the second key of a sequence ("G then I") may take. */
export const CHORD_TIMEOUT = 1500;
let pendingSeq = "";
let pendingAt = 0;

export function normalizeEvent(e: KeyboardEvent): string | null {
  const raw = e.key;
  if (raw === "Meta" || raw === "Control" || raw === "Shift" || raw === "Alt") return null;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const key = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase();

  let token = "";
  if (mod) token += "mod+";
  // On macOS `mod` is Cmd, so a held Ctrl is a separate modifier we can bind
  // (e.g. Ctrl+1 for account switching, distinct from Cmd+1). On other
  // platforms Ctrl *is* mod, so it's already captured above.
  if (IS_MAC && e.ctrlKey) token += "ctrl+";
  if (e.altKey) token += "alt+";
  // For single printable characters the char itself already encodes shift
  // ("#", "?", "!"), except letters which we lowercase.
  const needsShift = e.shiftKey && (raw.length > 1 || /^[a-zA-Z]$/.test(raw));
  if (needsShift) token += "shift+";
  token += key === " " ? "space" : key;
  return token;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Run a keydown through the command registry. Exported so keystrokes that fire
 *  outside the main document - inside a sandboxed email iframe, which the window
 *  listener never sees - can be routed here with the real event. */
export function dispatchKeyboardEvent(e: KeyboardEvent) {
  const token = normalizeEvent(e);
  if (token === null) return;

  const editable = isEditable(e.target);
  // In inputs, only modifier combos and Escape reach the registry
  // (Cmd+Enter, Esc, Cmd+K still work while typing).
  if (editable && !token.startsWith("mod+") && token !== "escape" && token !== "shift+escape") {
    pendingSeq = "";
    return;
  }

  // Enter must not hijack real buttons/links.
  if (token === "enter" && e.target instanceof HTMLElement && e.target.closest("a, button, [role='button'], summary")) {
    return;
  }

  const now = Date.now();
  if (pendingSeq && now - pendingAt > CHORD_TIMEOUT) pendingSeq = "";

  const seq = pendingSeq ? `${pendingSeq} ${token}` : token;
  const ctx = buildCommandContext();

  const exact = commands.find(
    (c) => commandKeys(c).includes(seq) && (!c.when || c.when(ctx)),
  );
  if (exact) {
    e.preventDefault();
    e.stopPropagation();
    pendingSeq = "";
    useUi.getState().set({ keySequence: "" });
    exact.run(ctx);
    return;
  }

  // Is this the start of a chord?
  const isPrefix = commands.some(
    (c) => commandKeys(c).some((k) => k.startsWith(`${seq} `)) && (!c.when || c.when(ctx)),
  );
  if (isPrefix) {
    e.preventDefault();
    pendingSeq = seq;
    pendingAt = now;
    useUi.getState().set({ keySequence: seq });
    window.setTimeout(() => {
      if (pendingSeq && Date.now() - pendingAt >= CHORD_TIMEOUT) {
        pendingSeq = "";
        useUi.getState().set({ keySequence: "" });
      }
    }, CHORD_TIMEOUT + 30);
    return;
  }

  if (pendingSeq) {
    pendingSeq = "";
    useUi.getState().set({ keySequence: "" });
  }
}

let installed = false;

/** Install the single global keyboard handler (idempotent). */
export function installKeyboard() {
  if (installed) return () => {};
  installed = true;
  const handler = (e: KeyboardEvent) => dispatchKeyboardEvent(e);
  window.addEventListener("keydown", handler);
  return () => {
    installed = false;
    window.removeEventListener("keydown", handler);
  };
}

// ---------------------------------------------------------------------------
// Iframe focus guard
// ---------------------------------------------------------------------------
//
// Email bodies (and attachment previews) render in sandboxed iframes marked
// `data-app-iframe`. Clicking one moves keyboard focus into it. In WebKit,
// which is what the app actually ships on (Tauri = WKWebView, also Safari),
// keydowns fired inside a scriptless sandboxed iframe reach *no* listener at
// all: not the iframe's own document, not the parent window. So every app
// shortcut (Esc to go back, ⌘K palette, J/K, R…) silently dies the moment you
// click inside a message. (Chrome/Blink does deliver them to a listener on the
// iframe document, which is why it only reproduces in WebKit.)
//
// Fix: never let focus rest in one of these iframes. Two triggers feed the
// same reclaim:
//   1. The parent window's `blur` (fires in Blink when a subframe grabs focus).
//   2. `mouseup` inside the iframe's own document (wired up by whoever renders
//      the iframe, via `reclaimIframeFocus`). WKWebView doesn't reliably fire
//      the parent blur for same-page focus moves, but it DOES deliver mouse
//      events inside the sandboxed frame - the click is the only way focus
//      gets in there, so it's also the reclaim point.
// On the next tick we yank focus back to an offscreen sink so keydowns land on
// the parent document where the handler above lives. Verified in WebKit: it
// does not disturb an in-progress text selection (mouse selection completes
// and survives) and `preventScroll` keeps the viewport put.

let focusSink: HTMLDivElement | null = null;

function ensureFocusSink(): HTMLDivElement {
  if (focusSink && focusSink.isConnected) return focusSink;
  const sink = document.createElement("div");
  sink.tabIndex = -1;
  sink.setAttribute("aria-hidden", "true");
  sink.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;opacity:0;outline:none;pointer-events:none";
  document.body.appendChild(sink);
  focusSink = sink;
  return sink;
}

/** If keyboard focus is resting inside one of the app's sandboxed iframes,
 *  yank it back to the offscreen sink (deferred a tick so the focus move /
 *  text selection that triggered this settles first). Exported so the iframe
 *  owners can call it from events that fire inside the frame's document -
 *  the only signals WKWebView reliably delivers there. */
export function reclaimIframeFocus() {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && active.matches("iframe[data-app-iframe]")) {
      ensureFocusSink().focus({ preventScroll: true });
    }
  }, 0);
}

let focusGuardInstalled = false;

export function installIframeFocusGuard() {
  if (focusGuardInstalled || typeof document === "undefined") return () => {};
  focusGuardInstalled = true;

  const sink = ensureFocusSink();
  window.addEventListener("blur", reclaimIframeFocus);

  // With focus reclaimed to the parent, a native Cmd/Ctrl+C copies the parent
  // document's (empty) selection - not the text the user just selected inside
  // an email iframe. Rescue it: when the parent selection is empty but a
  // sandboxed iframe holds one, write that text to the clipboard ourselves.
  // The parent document is focused here, so the async clipboard write is
  // allowed (it's rejected only while the subframe holds focus).
  const copyRescue = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c") return;
    if (window.getSelection()?.isCollapsed === false) return;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[data-app-iframe]")) {
      const text = frame.contentDocument?.getSelection()?.toString();
      if (text) {
        e.preventDefault();
        void navigator.clipboard.writeText(text).catch(() => {});
        return;
      }
    }
  };
  window.addEventListener("keydown", copyRescue);

  return () => {
    focusGuardInstalled = false;
    window.removeEventListener("blur", reclaimIframeFocus);
    window.removeEventListener("keydown", copyRescue);
    sink.remove();
    focusSink = null;
  };
}

// ---------------------------------------------------------------------------
// Mouse back/forward (buttons 3 and 4)
// ---------------------------------------------------------------------------

let mouseInstalled = false;

/** Route the extra mouse buttons to app navigation, and swallow the webview's
 *  own (empty) history back/forward so the SPA doesn't blank out.
 *  Back (3): step out of the current view (same stack as Esc).
 *  Forward (4): re-open the thread the cursor is on. */
function handleMouseNav(e: MouseEvent) {
  // 3 = browser-back button, 4 = browser-forward button.
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  // Act once, on release; mousedown/auxclick only suppress the default.
  if (e.type !== "mouseup") return;

  const ctx = buildCommandContext();
  if (e.button === 3) {
    ctx.escape();
  } else if (!ctx.composerOpen && !ctx.inConversation) {
    // Forward only makes sense from the list; inside a thread there's
    // nothing "forward" to go to.
    ctx.openSelected();
  }
}

/** Mouse events over an iframe fire on the iframe's own document and never
 *  reach the parent window, so the listeners below go deaf whenever the
 *  pointer rests on an email body or attachment preview - which it does right
 *  after clicking a thread open (#107). Those frames are same-origin
 *  (`allow-same-origin`), so their owners call this from `onLoad` to route the
 *  extra buttons through the same handler. That also cancels the webview's own
 *  back/forward inside the frame, which would otherwise step the iframe's
 *  history (e.g. back to an earlier srcdoc). Other buttons are left alone, so
 *  selection, links and the context menu are unaffected. */
export function installFrameMouseNav(doc: Document) {
  doc.addEventListener("mousedown", handleMouseNav);
  doc.addEventListener("mouseup", handleMouseNav);
  doc.addEventListener("auxclick", handleMouseNav);
}

/** Install the global mouse back/forward handler (idempotent). */
export function installMouseNav() {
  if (mouseInstalled) return () => {};
  mouseInstalled = true;
  // Suppress the default on down/up/auxclick; the action fires on mouseup.
  window.addEventListener("mousedown", handleMouseNav);
  window.addEventListener("mouseup", handleMouseNav);
  window.addEventListener("auxclick", handleMouseNav);
  return () => {
    mouseInstalled = false;
    window.removeEventListener("mousedown", handleMouseNav);
    window.removeEventListener("mouseup", handleMouseNav);
    window.removeEventListener("auxclick", handleMouseNav);
  };
}
