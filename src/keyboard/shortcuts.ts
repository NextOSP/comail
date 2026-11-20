// Settings > Shortcuts: which commands can be rebound, recording a new key or
// sequence, and spotting clashes with commands that can be live at the same
// time. Pure logic; the panel lives in components/settings/ShortcutsSettings.

import { IS_MAC } from "../lib/format";
import type { CommandCtx } from "./context";
import { commandKeys, splitKeyToken, type Command, type KeyOverrides } from "./registry";

/** Order of the groups in Settings and the shortcut help. */
export const SHORTCUT_SECTIONS = ["Triage", "Navigation", "Go to", "Compose", "AI", "Calendar", "Inbox", "Meta"];

/** Keys no command may take: Esc closes things (and cancels recording), Tab
 *  moves focus, copy/cut/paste must keep working in text, and the system's
 *  window keys (⌘Q/W/H/M, Alt+F4) belong to the system. */
const RESERVED = new Set([
  "escape",
  "shift+escape",
  "tab",
  "shift+tab",
  "mod+c",
  "mod+v",
  "mod+x",
  ...(IS_MAC ? ["mod+q", "mod+w", "mod+h", "mod+m"] : ["alt+f4"]),
]);

/** Keys the recorder waits through: lone modifiers, dead keys, IME, locks. */
const NOT_A_KEY = new Set([
  "dead",
  "unidentified",
  "process",
  "compose",
  "capslock",
  "numlock",
  "scrolllock",
  "fnlock",
  "fn",
  "altgraph",
  "hyper",
  "super",
  "os",
  "meta",
  "symbol",
  "symbollock",
]);

export function isReservedKey(token: string): boolean {
  return RESERVED.has(token);
}

export type RecordStep =
  /** not a key (lone modifier, dead key): keep listening */
  | { kind: "ignore" }
  /** Esc: stop recording, change nothing */
  | { kind: "cancel" }
  /** a reserved key: say so and keep listening */
  | { kind: "reserved"; key: string }
  /** a lone printable key that may start a sequence ("G" of "G then I") */
  | { kind: "pending"; first: string }
  | { kind: "done"; keys: string };

/**
 * One keystroke of the recorder. `pending` is the first key of a possible
 * sequence; `token` is `normalizeEvent(e)`. A lone printable key waits for a
 * second one (the caller commits it alone after CHORD_TIMEOUT); a combo or a
 * named key (Enter, F5, arrows) binds at once.
 */
export function recordStep(pending: string | null, token: string | null): RecordStep {
  if (token == null) return { kind: "ignore" };
  const { key } = splitKeyToken(token);
  if (key === "escape") return { kind: "cancel" };
  if (NOT_A_KEY.has(key)) return { kind: "ignore" };
  if (isReservedKey(token)) return { kind: "reserved", key: token };
  if (pending) return { kind: "done", keys: `${pending} ${token}` };
  if (token.length === 1) return { kind: "pending", first: token };
  return { kind: "done", keys: token };
}

/** The commands Settings lists, grouped like the help panel: commands that
 *  share a title in a section (J, ↓ and → are all "Next thread") make one row. */
export function shortcutRows(
  commands: Command[],
  titleOf: (cmd: Command) => string,
): { section: string; title: string; ids: string[] }[] {
  const rows: { section: string; title: string; ids: string[] }[] = [];
  for (const cmd of commands) {
    if (cmd.fixedKeys || cmd.keysFrom) continue;
    const title = titleOf(cmd);
    const row = rows.find((r) => r.section === cmd.section && r.title === title);
    if (row) row.ids.push(cmd.id);
    else rows.push({ section: cmd.section, title, ids: [cmd.id] });
  }
  const rank = (s: string) => {
    const i = SHORTCUT_SECTIONS.indexOf(s);
    return i < 0 ? SHORTCUT_SECTIONS.length : i;
  };
  // stable: keeps command order within a section
  return rows.sort((a, b) => rank(a.section) - rank(b.section));
}

// ------------------------------------------------------------------ Clashes

export interface Conflict {
  /** the other command */
  id: string;
  /** its key that clashes */
  key: string;
  /** the key being bound that it clashes with */
  clashesWith: string;
}

/** Equal, or one is a sequence the other starts: binding G alone would
 *  swallow every "G then …". */
export function keysClash(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

/**
 * Every combination of the state commands' `when` looks at, built on `base`
 * (a real context, for the verbs and anything not varied). Two commands can be
 * live together when some sample enables both.
 */
export function sampleContexts(base: CommandCtx): CommandCtx[] {
  const out: CommandCtx[] = [];
  for (let bits = 0; bits < 1 << 10; bits++) {
    const on = (i: number) => (bits & (1 << i)) !== 0;
    out.push({
      ...base,
      composerOpen: on(0),
      paletteOpen: on(1),
      panelOpen: on(2),
      inConversation: on(3),
      inSearch: on(4),
      hasTargets: on(5),
      // An id with nothing cached: per-thread checks (unsubscribe) can't rule
      // the command out, as for a thread that hasn't been opened yet.
      targets: on(5) ? [-1] : [],
      ui: {
        ...base.ui,
        calendarScreen: on(6),
        calendarDrawer: on(7) ? "day" : null,
        view: on(8) ? "trash" : "inbox",
        visibleThreadIds: on(9) ? [-1] : [],
      },
    });
  }
  return out;
}

function live(cmd: Command, ctx: CommandCtx): boolean {
  if (!cmd.when) return true;
  try {
    return cmd.when(ctx);
  } catch {
    return true;
  }
}

/** Other commands whose keys clash with binding `key` to command `id` while
 *  both can be live. `contexts` is called only when some key clashes. */
export function findConflicts(
  id: string,
  key: string,
  commands: Command[],
  map: KeyOverrides,
  contexts: () => CommandCtx[],
): Conflict[] {
  const self = commands.find((c) => c.id === id);
  if (!self) return [];
  let samples: CommandCtx[] | null = null;
  const out: Conflict[] = [];
  for (const other of commands) {
    if (other.id === id) continue;
    const clashing = commandKeys(other, map).filter((k) => keysClash(k, key));
    if (clashing.length === 0) continue;
    samples ??= contexts();
    if (!samples.some((ctx) => live(self, ctx) && live(other, ctx))) continue;
    for (const k of clashing) out.push({ id: other.id, key: k, clashesWith: key });
  }
  return out;
}

// -------------------------------------------------------------------- Edits

/** `map` with `cmd` bound to `keys`, dropping the entry when that's just the
 *  defaults again. */
export function withKeys(map: KeyOverrides, cmd: Command, keys: string[]): KeyOverrides {
  const next = { ...map };
  const unique = [...new Set(keys)];
  if (unique.length === cmd.keys.length && unique.every((k, i) => k === cmd.keys[i])) delete next[cmd.id];
  else next[cmd.id] = unique;
  return next;
}

/** Bind `key` to command `id`, replacing its key at `slot` (or adding one when
 *  `slot` is null), after taking each `unbind` key off the command holding it. */
export function bindKey(
  map: KeyOverrides,
  commands: Command[],
  id: string,
  slot: number | null,
  key: string,
  unbind: Conflict[] = [],
): KeyOverrides {
  let next = map;
  for (const c of unbind) {
    const other = commands.find((x) => x.id === c.id);
    if (other) next = withKeys(next, other, commandKeys(other, next).filter((k) => k !== c.key));
  }
  const cmd = commands.find((x) => x.id === id);
  if (!cmd) return next;
  const keys = [...commandKeys(cmd, next)];
  if (slot == null || slot >= keys.length) keys.push(key);
  else keys[slot] = key;
  return withKeys(next, cmd, keys);
}

/** Take the key at `slot` off a command (none left = unbound). */
export function unbindSlot(map: KeyOverrides, cmd: Command, slot: number): KeyOverrides {
  return withKeys(
    map,
    cmd,
    commandKeys(cmd, map).filter((_, i) => i !== slot),
  );
}

/** Back to the default keys for `ids`, after taking off other commands any
 *  key that clashes with them (`unbind`, from `resetConflicts`). */
export function resetKeys(
  map: KeyOverrides,
  commands: Command[],
  ids: string[],
  unbind: Conflict[] = [],
): KeyOverrides {
  let next = { ...map };
  for (const id of ids) delete next[id];
  for (const c of unbind) {
    const other = commands.find((x) => x.id === c.id);
    if (other) next = withKeys(next, other, commandKeys(other, next).filter((k) => k !== c.key));
  }
  return next;
}

/** What resetting `ids` would clash with: their default keys now held by other
 *  commands (e.g. E, after "Replace" moved it to Reply). */
export function resetConflicts(
  map: KeyOverrides,
  commands: Command[],
  ids: string[],
  contexts: () => CommandCtx[],
): Conflict[] {
  const after = resetKeys(map, commands, ids);
  const out: Conflict[] = [];
  for (const id of ids) {
    const cmd = commands.find((c) => c.id === id);
    if (!cmd || !map[id]) continue;
    for (const key of cmd.keys) {
      for (const c of findConflicts(id, key, commands, after, contexts)) {
        if (ids.includes(c.id) || out.some((o) => o.id === c.id && o.key === c.key)) continue;
        out.push(c);
      }
    }
  }
  return out;
}
