// Shortcut registry: one global keydown handler, chord support ("g then i"),
// and a single command list shared by the palette, keymap, and help panel.

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
  /** display string, e.g. "E", "⌘K", "G then I" (auto-derived if omitted) */
  shortcut?: string;
  /** key matchers: "e", "shift+e", "mod+enter", "g i" (chord) */
  keys: string[];
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

/** "mod+shift+enter" -> "⌘⇧↵" / "Ctrl+Shift+Enter"; "g i" -> "G then I" */
export function displayShortcut(keys: string | undefined): string {
  if (!keys) return "";
  if (keys.includes(" ") && !keys.includes("+")) {
    return keys
      .split(" ")
      .map((k) => k.toUpperCase())
      .join(" then ");
  }
  const parts = keys.split("+");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "mod") out.push(IS_MAC ? "⌘" : "Ctrl");
    else if (p === "ctrl") out.push(IS_MAC ? "⌃" : "Ctrl");
    else if (p === "shift") out.push(IS_MAC ? "⇧" : "Shift");
    else if (p === "alt") out.push(IS_MAC ? "⌥" : "Alt");
    else if (p === "enter") out.push("↵");
    else if (p === "escape") out.push("Esc");
    else if (p === "tab") out.push("Tab");
    else out.push(p.length === 1 ? p.toUpperCase() : p);
  }
  return out.join(IS_MAC ? "" : "+");
}

export function shortcutFor(cmd: Command): string {
  return cmd.shortcut ?? displayShortcut(cmd.keys[0]);
}

// ---------------------------------------------------------------------------
// Global keydown dispatch
// ---------------------------------------------------------------------------

const CHORD_TIMEOUT = 1500;
let pendingSeq = "";
let pendingAt = 0;

function normalizeEvent(e: KeyboardEvent): string | null {
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
 *  outside the main document — inside a sandboxed email iframe, which the window
 *  listener never sees — can be routed here with the real event. */
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
    (c) => c.keys.includes(seq) && (!c.when || c.when(ctx)),
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
    (c) => c.keys.some((k) => k.startsWith(`${seq} `)) && (!c.when || c.when(ctx)),
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
