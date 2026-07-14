import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { runAiCommand } from "../../lib/aiCommand";
import { folderLeafName, isUserFolder } from "../../lib/folders";
import { commandScore } from "../../keyboard/commandScore";
import { buildCommandContext } from "../../keyboard/context";
import { getCommands, shortcutFor, type Command } from "../../keyboard/registry";
import { useFolders } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import i18n from "../../i18n";

const USAGE_KEY = "comail:cmd-usage";

function loadUsage(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function bumpUsage(id: string) {
  const usage = loadUsage();
  usage[id] = (usage[id] ?? 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    /* ignore */
  }
}

/** A palette row: a runnable command, the "search mail for …" fallback, or the
 *  "ask AI" fallback. Search + AI are always last so real matches win. */
type Row =
  | { kind: "command"; cmd: Command }
  | { kind: "search" }
  | { kind: "ai" };

// A query that opens with an action verb reads like an instruction to carry out
// ("make a meeting for …", "reply to Sam", "summarize this"), so the AI action
// should be the default rather than a literal mail search. Plain terms
// ("invoice", "from:john", "quarterly report") keep search as the default.
const INSTRUCTION_RE =
  /^(make|create|schedule|set ?up|add|new|draft|write|compose|reply|respond|send|forward|summar(?:ize|ise)|remind|book|invite|cancel|snooze|translate|generate|plan|organi[sz]e|tell|ask|give me)\b/i;
function looksLikeInstruction(q: string): boolean {
  return /\s/.test(q) && INSTRUCTION_RE.test(q);
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUi((s) => s.paletteOpen);
  const set = useUi((s) => s.set);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [aiPending, setAiPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Folders across all accounts, exposed as "Go to folder: …" palette entries so
  // typing a folder name jumps straight there instead of only offering the AI.
  const { data: folders } = useFolders(null);
  const folderCommands = useMemo<Command[]>(() => {
    return (folders ?? []).filter(isUserFolder).map((f) => {
      const leaf = folderLeafName(f);
      return {
        id: `go-folder-${f.id}`,
        titleKey: "commands:title.goToFolder",
        title: () => i18n.t("commands:title.goToFolder", { name: leaf }),
        // Match on the leaf name, the full path, and natural "go to …" phrasings.
        aliases: [leaf, f.imapName, `folder ${leaf}`, `go to ${leaf}`, `go to folder ${leaf}`],
        keys: [],
        section: "Go to",
        run: () => useUi.getState().selectFolder(f.id),
      };
    });
  }, [folders]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setAiPending(false);
      // focus after mount
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    if (!open) return [];
    // Build the context as if the palette weren't open: commands run against a
    // fresh context after it closes, so their availability (`when`) must ignore
    // the palette itself. Otherwise every command gated on `!paletteOpen`
    // (reply, forward, trash, mark done, …) would be filtered out here.
    const ctx = { ...buildCommandContext(), paletteOpen: false };
    const usage = loadUsage();
    const q = query.trim();
    // The empty-query list stays a clean set of top commands; folders only join
    // the pool once the user types, so the default view isn't flooded by them.
    const pool = q ? [...getCommands(), ...folderCommands] : getCommands();
    const available = pool.filter((c) => !c.hiddenInPalette && (!c.when || c.when(ctx)));
    if (!q) {
      return available
        .slice()
        .sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0))
        .slice(0, 12);
    }
    return available
      .map((c) => {
        const base = Math.max(
          commandScore(c.title ? c.title() : t(c.titleKey, c.titleParams), q),
          ...c.aliases.map((a) => commandScore(a, q) * 0.98),
        );
        // recent/usage boost, gentle
        const boost = 1 + Math.min(usage[c.id] ?? 0, 20) * 0.02;
        return { c, score: base * boost };
      })
      .filter((r) => r.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.c);
  }, [open, query, t, folderCommands]);

  const q = query.trim();
  // Search is a universal fallback: any non-empty query can always run a search.
  const showSearchRow = q.length >= 1;
  // Natural-language fallback: when nothing matches (or the query reads like a
  // sentence), offer to let the AI turn it into an action.
  const showAiRow = q.length >= 3 && (results.length === 0 || /\s/.test(q));

  // When no command matched and the query reads like an instruction, put the AI
  // action first so Enter runs it instead of a literal search.
  const aiFirst = showAiRow && results.length === 0 && looksLikeInstruction(q);
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = results.map((cmd) => ({ kind: "command", cmd }));
    if (aiFirst) {
      r.push({ kind: "ai" });
      if (showSearchRow) r.push({ kind: "search" });
    } else {
      if (showSearchRow) r.push({ kind: "search" });
      if (showAiRow) r.push({ kind: "ai" });
    }
    return r;
  }, [results, showSearchRow, showAiRow, aiFirst]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const run = (cmd: Command) => {
    set({ paletteOpen: false });
    bumpUsage(cmd.id);
    // run against a fresh context (palette now closed)
    cmd.run(buildCommandContext());
  };

  const runSearch = () => {
    set({ paletteOpen: false, searchOpen: true, searchQuery: q, openThreadId: null });
  };

  const runAi = async () => {
    if (aiPending) return;
    setAiPending(true);
    try {
      // runAiCommand closes the palette itself on success paths
      await runAiCommand(q);
    } finally {
      setAiPending(false);
    }
  };

  const activate = (row: Row) => {
    if (row.kind === "command") run(row.cmd);
    else if (row.kind === "search") runSearch();
    else void runAi();
  };

  return (
    <div className="co-overlay flex items-start justify-center pt-[16vh]" onMouseDown={() => set({ paletteOpen: false })}>
      <div
        className="co-pop-in w-[560px] overflow-hidden rounded-xl border border-hairline bg-bg1"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(rows.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[cursor];
              if (row) activate(row);
            }
          }}
          placeholder={t("common:palette.placeholder")}
          className="co-hairline-b w-full bg-transparent px-5 py-4 text-[16px] text-ink outline-none placeholder:text-ink-faint"
          spellCheck={false}
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-faint">{t("common:palette.empty")}</div>
          )}
          {rows.map((row, i) => {
            const selected = i === cursor;
            const rowCls = `flex w-full items-center justify-between gap-4 rounded-lg px-3.5 py-2 text-left ${
              selected ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
            }`;
            if (row.kind === "command") {
              const cmd = row.cmd;
              return (
                <button
                  key={cmd.id}
                  data-idx={i}
                  className={rowCls}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => run(cmd)}
                >
                  <span className="flex items-baseline gap-2.5 truncate">
                    <span className="text-[14px] text-ink">{cmd.title ? cmd.title() : t(cmd.titleKey, cmd.titleParams)}</span>
                    <span className="text-[11.5px] text-ink-faint">{t(`commands:section.${cmd.section}`)}</span>
                  </span>
                  {shortcutFor(cmd) && (
                    <span className="flex shrink-0 gap-1">
                      {shortcutFor(cmd)
                        .split(" then ")
                        .map((part, j, arr) => (
                          <span key={j} className="flex items-center gap-1">
                            <kbd className="co-kbd">{part}</kbd>
                            {j < arr.length - 1 && <span className="text-[10px] text-ink-faint">then</span>}
                          </span>
                        ))}
                    </span>
                  )}
                </button>
              );
            }
            if (row.kind === "search") {
              return (
                <button
                  key="palette-search-row"
                  data-idx={i}
                  data-testid="palette-search-row"
                  className={rowCls}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => runSearch()}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <SearchIcon />
                    <span className="truncate text-[14px] text-ink">
                      {t("commands:searchFor", { query: q })}
                    </span>
                  </span>
                  <kbd className="co-kbd shrink-0">↵</kbd>
                </button>
              );
            }
            // row.kind === "ai"
            return (
              <button
                key="palette-ai-row"
                data-idx={i}
                data-testid="palette-ai-row"
                disabled={aiPending}
                className={rowCls}
                onMouseMove={() => setCursor(i)}
                onClick={() => void runAi()}
              >
                <span className="flex min-w-0 items-baseline gap-2.5">
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-accent uppercase">
                    {t("commands:aiIntent.badge")}
                  </span>
                  <span className="truncate text-[14px] text-ink">
                    {t("commands:aiIntent.row", { query: q })}
                  </span>
                </span>
                {aiPending ? (
                  <span className="co-spinner size-3.5 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
                ) : (
                  <kbd className="co-kbd shrink-0">↵</kbd>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Magnifier glyph for the "search mail for …" fallback row. */
function SearchIcon() {
  return (
    <span className="shrink-0 text-ink-faint" aria-hidden>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    </span>
  );
}
