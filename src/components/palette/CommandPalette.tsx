import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { runAiCommand } from "../../lib/aiCommand";
import { commandScore } from "../../keyboard/commandScore";
import { buildCommandContext } from "../../keyboard/context";
import { getCommands, shortcutFor, type Command } from "../../keyboard/registry";
import { useUi } from "../../stores/ui";

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

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useUi((s) => s.paletteOpen);
  const set = useUi((s) => s.set);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [aiPending, setAiPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    const ctx = buildCommandContext();
    const usage = loadUsage();
    const available = getCommands().filter(
      (c) => !c.hiddenInPalette && (!c.when || c.when(ctx)),
    );
    const q = query.trim();
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
  }, [open, query, t]);

  // Natural-language fallback: when nothing matches (or the query reads like a
  // sentence), offer to let the AI turn it into an action.
  const showAiRow = query.trim().length >= 3 && (results.length === 0 || /\s/.test(query.trim()));
  const rowCount = results.length + (showAiRow ? 1 : 0);
  const aiRowIndex = results.length;

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

  const runAi = async () => {
    if (aiPending) return;
    setAiPending(true);
    try {
      // runAiCommand closes the palette itself on success paths
      await runAiCommand(query.trim());
    } finally {
      setAiPending(false);
    }
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
              setCursor((c) => Math.min(rowCount - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (showAiRow && cursor === aiRowIndex) {
                void runAi();
                return;
              }
              const cmd = results[cursor];
              if (cmd) run(cmd);
            }
          }}
          placeholder={t("common:palette.placeholder")}
          className="co-hairline-b w-full bg-transparent px-5 py-4 text-[16px] text-ink outline-none placeholder:text-ink-faint"
          spellCheck={false}
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {rowCount === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-faint">{t("common:palette.empty")}</div>
          )}
          {results.map((cmd, i) => (
            <button
              key={cmd.id}
              data-idx={i}
              className={`flex w-full items-center justify-between gap-4 rounded-lg px-3.5 py-2 text-left ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => run(cmd)}
            >
              <span className="flex items-baseline gap-2.5 truncate">
                <span className={`text-[14px] ${i === cursor ? "text-ink" : "text-ink"}`}>{cmd.title ? cmd.title() : t(cmd.titleKey, cmd.titleParams)}</span>
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
          ))}
          {showAiRow && (
            <button
              data-idx={aiRowIndex}
              data-testid="palette-ai-row"
              disabled={aiPending}
              className={`flex w-full items-center justify-between gap-4 rounded-lg px-3.5 py-2 text-left ${
                cursor === aiRowIndex ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(aiRowIndex)}
              onClick={() => void runAi()}
            >
              <span className="flex min-w-0 items-baseline gap-2.5">
                <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-accent uppercase">
                  {t("commands:aiIntent.badge")}
                </span>
                <span className="truncate text-[14px] text-ink">
                  {t("commands:aiIntent.row", { query: query.trim() })}
                </span>
              </span>
              {aiPending ? (
                <span className="co-spinner size-3.5 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
              ) : (
                <kbd className="co-kbd shrink-0">↵</kbd>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
