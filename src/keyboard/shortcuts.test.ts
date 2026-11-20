import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IS_MAC } from "../lib/format";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";
import { ALL_COMMANDS } from "./commands";
import { buildCommandContext } from "./context";
import {
  commandKeys,
  dispatchKeyboardEvent,
  displayShortcut,
  getKeyOverrides,
  isReachableKey,
  normalizeEvent,
  registerCommands,
  setKeyOverrides,
  shortcutFor,
  shortcutHint,
  splitKeyToken,
  withUndoHint,
  type Command,
} from "./registry";
import {
  bindKey,
  findConflicts,
  isReservedKey,
  keysClash,
  recordStep,
  resetConflicts,
  resetKeys,
  sampleContexts,
  shortcutRows,
  unbindSlot,
  withKeys,
} from "./shortcuts";

type Catalog = Record<string, any>;
const CATALOGS = import.meta.glob<Catalog>("../i18n/locales/*/*.json", { eager: true, import: "default" });
const catalog = (lng: string, ns: string) => CATALOGS[`../i18n/locales/${lng}/${ns}.json`];
const LOCALES = ["en", "es", "fr", "vi", "zh"];

/** A keydown as the browser would report it; `mod` is ⌘ on macOS, Ctrl elsewhere. */
function keydown(
  key: string,
  mods: { mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    metaKey: IS_MAC && !!mods.mod,
    ctrlKey: IS_MAC ? !!mods.ctrl : !!(mods.mod || mods.ctrl),
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    repeat: false,
    target: null,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;
}

const cmd = (id: string) => ALL_COMMANDS.find((c) => c.id === id)!;
const contexts = () => sampleContexts(buildCommandContext());

beforeEach(() => {
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
  registerCommands(ALL_COMMANDS);
  setKeyOverrides({});
  // Commands' `when` peek at focus and the selection; give them a resting page.
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", {
    activeElement: null,
    body: null,
    getSelection: () => null,
    querySelectorAll: () => [],
  });
});

afterEach(() => {
  setKeyOverrides({});
  registerCommands(ALL_COMMANDS);
  vi.unstubAllGlobals();
});

describe("override resolution", () => {
  it("keeps the default keys without an override and replaces them with one", () => {
    expect(commandKeys(cmd("mark-done"))).toEqual(["e"]);
    setKeyOverrides({ "mark-done": ["y", "g e"] });
    expect(commandKeys(cmd("mark-done"))).toEqual(["y", "g e"]);
    expect(commandKeys(cmd("reply"))).toEqual(["r"]);
  });

  it("treats an empty list as unbound", () => {
    setKeyOverrides({ compose: [] });
    expect(commandKeys(cmd("compose"))).toEqual([]);
    expect(shortcutFor(cmd("compose"))).toBe("");
    expect(shortcutHint("compose")).toBe("");
  });

  it("drops malformed entries from a hand-edited settings file", () => {
    setKeyOverrides({ a: ["x", "", 3 as unknown as string], b: "y" as unknown as string[] });
    expect(getKeyOverrides()).toEqual({ a: ["x"] });
    setKeyOverrides(undefined);
    expect(getKeyOverrides()).toEqual({});
  });

  it("forgets an override that equals the defaults", () => {
    const map = withKeys({}, cmd("mark-done"), ["y"]);
    expect(map).toEqual({ "mark-done": ["y"] });
    expect(withKeys(map, cmd("mark-done"), ["e"])).toEqual({});
    expect(withKeys({}, cmd("mark-done"), ["y", "y"])).toEqual({ "mark-done": ["y"] });
  });

  it("replaces a slot, adds a key, removes a key and resets", () => {
    let map = bindKey({}, ALL_COMMANDS, "next-message", 0, "x");
    expect(map["next-message"]).toEqual(["x", "arrowdown"]);
    map = bindKey(map, ALL_COMMANDS, "next-message", null, "g n");
    expect(map["next-message"]).toEqual(["x", "arrowdown", "g n"]);
    map = unbindSlot(map, cmd("next-message"), 1);
    expect(map["next-message"]).toEqual(["x", "g n"]);
    expect(resetKeys(map, ALL_COMMANDS, ["next-message"])).toEqual({});
  });

  it("takes a replaced key off the command that held it", () => {
    const conflicts = [{ id: "mark-done", key: "e", clashesWith: "e" }];
    const map = bindKey({}, ALL_COMMANDS, "reply", 0, "e", conflicts);
    expect(map).toEqual({ reply: ["e"], "mark-done": [] });
  });
});

describe("display", () => {
  it("names keys, combos and sequences", () => {
    expect(displayShortcut("e")).toBe("E");
    expect(displayShortcut("g i")).toBe("G then I");
    expect(displayShortcut("mod+shift+enter")).toBe(IS_MAC ? "⌘⇧↵" : "Ctrl+Shift+↵");
    expect(displayShortcut("g shift+a")).toBe(IS_MAC ? "G then ⇧A" : "G then Shift+A");
    expect(displayShortcut("shift+arrowdown")).toBe(IS_MAC ? "⇧↓" : "Shift+↓");
    expect(displayShortcut("mod++")).toBe(IS_MAC ? "⌘+" : "Ctrl++");
    expect(displayShortcut("f5")).toBe("F5");
    expect(splitKeyToken("mod+alt++")).toEqual({ mods: ["mod", "alt"], key: "+" });
  });

  it("shows a rebound key instead of the hard-coded display string", () => {
    expect(shortcutFor(cmd("undo"))).toBe("Z");
    expect(shortcutFor(cmd("reply-all"))).toBe("↵");
    setKeyOverrides({ undo: ["mod+z"], "reply-all": ["a"] });
    expect(shortcutFor(cmd("undo"))).toBe(displayShortcut("mod+z"));
    expect(shortcutFor(cmd("reply-all"))).toBe("A");
  });

  it("shows the palette's Unsubscribe with the key of its hidden twin", () => {
    expect(shortcutFor(cmd("unsubscribe"))).toBe(displayShortcut("mod+u"));
    setKeyOverrides({ "unsubscribe-key": ["shift+u"] });
    expect(shortcutFor(cmd("unsubscribe"))).toBe(displayShortcut("shift+u"));
  });

  it("hints the preferred key while the command still has it", () => {
    expect(shortcutHint("next-message", "arrowdown")).toBe("↓");
    setKeyOverrides({ "next-message": ["n"] });
    expect(shortcutHint("next-message", "arrowdown")).toBe("N");
    expect(shortcutHint("no-such-command")).toBe("");
  });

  it("names the undo key in action toasts", () => {
    expect(withUndoHint("Marked done")).toBe("Marked done · Z to undo");
    setKeyOverrides({ undo: ["mod+z"] });
    expect(withUndoHint("Marked done")).toBe(`Marked done · ${displayShortcut("mod+z")} to undo`);
    setKeyOverrides({ undo: [] });
    expect(withUndoHint("Marked done")).toBe("Marked done");
  });
});

describe("recording", () => {
  const record = (...events: KeyboardEvent[]) => {
    let pending: string | null = null;
    const steps = [];
    for (const e of events) {
      const step = recordStep(pending, normalizeEvent(e));
      steps.push(step);
      if (step.kind === "pending") pending = step.first;
      if (step.kind === "done" || step.kind === "cancel") pending = null;
    }
    return steps;
  };

  it("binds a combo or a named key at once", () => {
    expect(record(keydown("k", { mod: true }))).toEqual([{ kind: "done", keys: "mod+k" }]);
    expect(record(keydown("E", { shift: true }))).toEqual([{ kind: "done", keys: "shift+e" }]);
    expect(record(keydown("Enter"))).toEqual([{ kind: "done", keys: "enter" }]);
    expect(record(keydown("ArrowDown", { alt: true }))).toEqual([{ kind: "done", keys: "alt+arrowdown" }]);
  });

  it("waits after a plain key, then records a two-key sequence", () => {
    expect(record(keydown("g"), keydown("i"))).toEqual([
      { kind: "pending", first: "g" },
      { kind: "done", keys: "g i" },
    ]);
    expect(record(keydown("G", { shift: false }), keydown("#"))).toEqual([
      { kind: "pending", first: "g" },
      { kind: "done", keys: "g #" },
    ]);
    // A printable character typed with Shift keeps its own name ("?").
    expect(record(keydown("?", { shift: true }))).toEqual([{ kind: "pending", first: "?" }]);
  });

  it("ignores bare modifiers and dead keys", () => {
    expect(record(keydown("Shift", { shift: true }), keydown("Control", { ctrl: true }), keydown("Meta"))).toEqual([
      { kind: "ignore" },
      { kind: "ignore" },
      { kind: "ignore" },
    ]);
    expect(record(keydown("Dead", { alt: true }))).toEqual([{ kind: "ignore" }]);
  });

  it("cancels on Esc, even in the middle of a sequence", () => {
    expect(record(keydown("Escape"))).toEqual([{ kind: "cancel" }]);
    expect(record(keydown("g"), keydown("Escape"))).toEqual([{ kind: "pending", first: "g" }, { kind: "cancel" }]);
  });

  it("refuses reserved keys", () => {
    expect(record(keydown("Tab"))).toEqual([{ kind: "reserved", key: "tab" }]);
    expect(record(keydown("c", { mod: true }))).toEqual([{ kind: "reserved", key: "mod+c" }]);
    expect(record(keydown("g"), keydown("Tab"))[1]).toEqual({ kind: "reserved", key: "tab" });
    expect(isReservedKey("shift+tab")).toBe(true);
    expect(isReservedKey("mod+q")).toBe(IS_MAC);
    expect(isReservedKey("alt+f4")).toBe(!IS_MAC);
    expect(isReservedKey("mod+k")).toBe(false);
  });

  it("hides Ctrl-only defaults where Ctrl is the main modifier", () => {
    expect(isReachableKey("ctrl+k")).toBe(IS_MAC);
    expect(isReachableKey("mod+k")).toBe(true);
    expect(isReachableKey("g i")).toBe(true);
    // Removing ⌘/Ctrl+K from the palette leaves macOS's Ctrl+K: shown there,
    // not elsewhere, where that key can't fire.
    setKeyOverrides({ palette: ["ctrl+k"] });
    expect(shortcutFor(cmd("palette"))).toBe(IS_MAC ? "⌃K" : "");
  });
});

describe("conflicts", () => {
  it("sees a clash between commands live in the same place", () => {
    expect(findConflicts("reply", "e", ALL_COMMANDS, {}, contexts)).toEqual([
      { id: "mark-done", key: "e", clashesWith: "e" },
    ]);
  });

  it("ignores commands that are never live together", () => {
    // Send only runs in the composer; M opens the calendar (or month view) when no composer is open.
    expect(findConflicts("send", "m", ALL_COMMANDS, {}, contexts)).toEqual([]);
    // Compose works on the calendar screen too, where D is the day view.
    expect(findConflicts("compose", "d", ALL_COMMANDS, {}, contexts)).toEqual([
      { id: "calendar-day-view", key: "d", clashesWith: "d" },
    ]);
  });

  it("treats a single key that starts sequences as a clash with them", () => {
    expect(keysClash("g", "g i")).toBe(true);
    expect(keysClash("g i", "g")).toBe(true);
    expect(keysClash("t", "g t")).toBe(false);
    const ids = findConflicts("compose", "g", ALL_COMMANDS, {}, contexts).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["go-inbox", "go-sent", "go-all", "open-settings"]));
    expect(findConflicts("compose", "g", ALL_COMMANDS, {}, contexts).find((c) => c.id === "open-settings"))
      .toEqual({ id: "open-settings", key: "g ,", clashesWith: "g" });
  });

  it("follows the user's rebindings", () => {
    const map = { "mark-done": ["y"] };
    expect(findConflicts("reply", "e", ALL_COMMANDS, map, contexts)).toEqual([]);
    expect(findConflicts("reply", "y", ALL_COMMANDS, map, contexts)).toEqual([
      { id: "mark-done", key: "y", clashesWith: "y" },
    ]);
  });

  it("warns when a reset brings back a key another command took", () => {
    const map = { reply: ["e"], "mark-done": [] };
    expect(resetConflicts(map, ALL_COMMANDS, ["mark-done"], contexts)).toEqual([
      { id: "reply", key: "e", clashesWith: "e" },
    ]);
    expect(resetKeys(map, ALL_COMMANDS, ["mark-done"], [{ id: "reply", key: "e", clashesWith: "e" }])).toEqual({
      reply: [],
    });
  });

  it("finds none among the default keys", () => {
    const clashes = ALL_COMMANDS.flatMap((c) =>
      c.keys.flatMap((k) => findConflicts(c.id, k, ALL_COMMANDS, {}, contexts).map((x) => `${c.id}:${k} vs ${x.id}:${x.key}`)),
    );
    expect(clashes).toEqual([]);
  });
});

describe("settings list", () => {
  const rows = shortcutRows(ALL_COMMANDS, (c) => c.titleKey);

  it("groups commands that share a title and leaves out fixed keys", () => {
    const next = rows.find((r) => r.title === "commands:title.nextThread")!;
    expect(next.ids).toEqual(["next-thread", "list-down", "next-thread-arrow"]);
    const ids = rows.flatMap((r) => r.ids);
    expect(ids).not.toContain("back");
    expect(ids).not.toContain("go-label-0");
    // Unsubscribe is edited through the twin that owns its key.
    expect(ids).not.toContain("unsubscribe");
    expect(ids).toContain("unsubscribe-key");
  });

  it("orders sections like the help panel", () => {
    const sections = [...new Set(rows.map((r) => r.section))];
    expect(sections).toEqual(["Triage", "Navigation", "Go to", "Compose", "AI", "Calendar", "Inbox", "Meta"]);
    for (const s of sections) expect(catalog("en", "commands").section).toHaveProperty([s]);
  });
});

describe("dispatch", () => {
  let ran: string[];
  const make = (id: string, keys: string[]): Command => ({
    id,
    titleKey: id,
    aliases: [],
    keys,
    section: "Meta",
    run: () => void ran.push(id),
  });

  beforeEach(() => {
    ran = [];
    vi.stubGlobal("window", { setTimeout: () => 0 });
    registerCommands([make("archive", ["e"]), make("go", ["g i"]), make("other", ["o"])]);
  });

  it("runs the default key until it is rebound", () => {
    dispatchKeyboardEvent(keydown("e"));
    expect(ran).toEqual(["archive"]);
    setKeyOverrides({ archive: ["y"] });
    dispatchKeyboardEvent(keydown("e"));
    dispatchKeyboardEvent(keydown("y"));
    expect(ran).toEqual(["archive", "archive"]);
  });

  it("does nothing for an unbound command", () => {
    setKeyOverrides({ archive: [] });
    dispatchKeyboardEvent(keydown("e"));
    expect(ran).toEqual([]);
  });

  it("follows rebound sequences, old and new", () => {
    setKeyOverrides({ archive: ["x c"], go: ["shift+i"] });
    dispatchKeyboardEvent(keydown("g"));
    dispatchKeyboardEvent(keydown("i"));
    expect(ran).toEqual([]);
    dispatchKeyboardEvent(keydown("x"));
    expect(useUi.getState().keySequence).toBe("x");
    dispatchKeyboardEvent(keydown("c"));
    dispatchKeyboardEvent(keydown("I", { shift: true }));
    expect(ran).toEqual(["archive", "go"]);
  });

  it("drives the real keymap", () => {
    registerCommands(ALL_COMMANDS);
    setKeyOverrides({ help: ["f1"] });
    dispatchKeyboardEvent(keydown("?", { shift: true }));
    expect(useUi.getState().helpOpen).toBe(false);
    dispatchKeyboardEvent(keydown("F1"));
    expect(useUi.getState().helpOpen).toBe(true);
  });

  it.each([
    ["+", true, "zoom-in"],
    ["+", false, "zoom-in"],
    ["=", false, "zoom-in"],
    ["-", false, "zoom-out"],
    ["0", false, "zoom-reset"],
  ] as const)("dispatches key %s with shift=%s to %s", (key, shift, id) => {
    const run = vi.fn();
    registerCommands(ALL_COMMANDS.map((command) => command.id === id ? { ...command, run } : command));
    dispatchKeyboardEvent(keydown(key, { shift }));
    expect(run).not.toHaveBeenCalled();
    const event = keydown(key, { mod: true, shift });
    event.preventDefault = vi.fn();
    dispatchKeyboardEvent(event);
    expect(run).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("translations", () => {
  it.each(LOCALES)("%s has every shortcut string, with the keys as placeholders", (lng) => {
    const settings = catalog(lng, "settings");
    const commands = catalog(lng, "commands");
    const common = catalog(lng, "common");
    const compose = catalog(lng, "compose");
    expect(Object.keys(settings.shortcuts).sort()).toEqual(Object.keys(catalog("en", "settings").shortcuts).sort());
    expect(settings.section.shortcuts).toBeTruthy();
    expect(settings.page.shortcuts).toBeTruthy();
    expect(commands.section.Inbox).toBeTruthy();
    expect(commands.title.openShortcutSettings).toBeTruthy();
    expect(common.shortcutHelp.customize).toBeTruthy();
    expect(common.undoSuffix).toMatch(/\{\{label\}\}.*\{\{key\}\}/);
    expect(common.topbar.calendar).toMatch(/\{\{today\}\}.*\{\{week\}\}/);
    expect(compose.footerHints).toMatch(/\{\{send\}\}.*\{\{sendDone\}\}/);
    expect(compose.sendingIn).toMatch(/\{s\}.*\{\{key\}\}/);
    expect(compose.sendingInNoKey).toContain("{s}");
    for (const k of ["reserved", "conflict"]) expect(settings.shortcuts[k]).toContain("{{keys}}");
  });
});
