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

function dispatch(e: KeyboardEvent) {
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
  const handler = (e: KeyboardEvent) => dispatch(e);
  window.addEventListener("keydown", handler);
  return () => {
    installed = false;
    window.removeEventListener("keydown", handler);
  };
}
