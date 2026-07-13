import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts, useAsk, useContactSuggestions, useLabels, useSearch } from "../../queries/hooks";
import { useModHeld } from "../../lib/useModHeld";
import { useUi } from "../../stores/ui";
import { ThreadList } from "../inbox/ThreadList";

// Shown in the "Try" row when nothing is being completed.
const OPERATORS = ["from:", "in:", "is:unread", "has:attachment"];

// The full set the search parser understands, used for as-you-type completion.
// `from:`/`to:` take a freeform address value, so they complete to the bare
// prefix; the rest are self-contained.
const OPERATOR_SUGGESTIONS = [
  "from:",
  "to:",
  "in:inbox",
  "in:sent",
  "in:drafts",
  "in:archive",
  "in:trash",
  "in:spam",
  "is:unread",
  "is:starred",
  "has:attachment",
];

export function SearchScreen() {
  const { t } = useTranslation();
  const storedQuery = useUi((s) => s.searchQuery);
  const set = useUi((s) => s.set);
  const openThread = useUi((s) => s.openThread);
  const selectThread = useUi((s) => s.selectThread);

  const [input, setInput] = useState(storedQuery);
  const [mode, setMode] = useState<"search" | "ask">("search");
  // Enter guard: false while typing, so Enter never opens an email until you
  // arrow into the list. Arrowing moves the shared cursor (highlight and
  // scrolling live in ThreadList, same as the inbox).
  const [enterArmed, setEnterArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ask = useAsk();
  // ⌘/Ctrl held: reveal each result's jump-to number (⌘/Ctrl+1..9 opens it).
  const modHeld = useModHeld();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Adopt a one-shot mode request (palette "Ask AI" opens straight into Ask).
  const modeRequest = useUi((s) => s.searchModeRequest);
  useEffect(() => {
    if (modeRequest) {
      setMode(modeRequest);
      useUi.getState().set({ searchModeRequest: null });
    }
  }, [modeRequest]);

  // 150ms debounce into the store (which keys the query)
  useEffect(() => {
    const t = setTimeout(() => set({ searchQuery: input }), 150);
    return () => clearTimeout(t);
  }, [input, set]);

  // Adopt a query pushed from outside while already open (palette "View all
  // from this sender"). During typing storedQuery only ever catches up to
  // input via the debounce above, so this is a no-op then.
  useEffect(() => {
    setInput((cur) => (cur === storedQuery ? cur : storedQuery));
  }, [storedQuery]);

  const { data: results, isFetching } = useSearch(storedQuery);

  // Typing (or switching mode) disarms Enter so refining a query can't open a
  // stale row.
  useEffect(() => setEnterArmed(false), [storedQuery, mode]);
  const { data: contactHits } = useContactSuggestions(
    mode === "search" && !storedQuery.includes("from:") ? storedQuery : "",
  );
  const { data: accounts } = useAccounts();
  const { data: labels } = useLabels();
  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const labelMap = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  const rows = results ?? [];

  // Arrow keys from the input move the shared cursor through the results.
  const moveCursor = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    const cur = enterArmed
      ? rows.findIndex((r) => r.id === useUi.getState().selectedThreadId)
      : -1;
    const next = cur + delta;
    if (next < 0) {
      setEnterArmed(false);
      return;
    }
    const idx = Math.min(rows.length - 1, next);
    setEnterArmed(true);
    selectThread(idx, rows[idx].id);
  };

  // As-you-type operator completion: match the token being typed (the text
  // after the last space) against the known operators. The first match is the
  // "active" suggestion — Tab or Enter completes to it.
  const tokenStart = input.lastIndexOf(" ") + 1;
  const currentToken = input.slice(tokenStart);
  const opSuggestions = useMemo(() => {
    const tok = currentToken.toLowerCase();
    if (!tok) return [];
    return OPERATOR_SUGGESTIONS.filter(
      (s) => s.toLowerCase().startsWith(tok) && s.toLowerCase() !== tok,
    );
  }, [currentToken]);
  const activeSuggestion = mode === "search" && !enterArmed ? (opSuggestions[0] ?? null) : null;

  const applyCompletion = (op: string) => {
    setInput(input.slice(0, tokenStart) + op);
    inputRef.current?.focus();
  };

  return (
    <div className="co-fade-in flex min-h-0 flex-1 flex-col">
      <div className="co-hairline-b shrink-0 px-6 pt-4 pb-3">
        <div className="mx-auto max-w-[860px]">
          <div className="flex items-center gap-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ink-faint">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+J flips between keyword Search and AI Ask without
                // leaving the field. Stop it here so the global registry's
                // composer-only mod+j binding never sees it.
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
                  e.preventDefault();
                  e.stopPropagation();
                  setMode((m) => (m === "search" ? "ask" : "search"));
                  return;
                }
                // ⌘/Ctrl+1..9 jumps straight to the Nth result. Stop it here so
                // the global registry's mod+N (inbox split tabs) never fires
                // behind the search screen.
                if ((e.metaKey || e.ctrlKey) && mode === "search" && /^[1-9]$/.test(e.key)) {
                  e.preventDefault();
                  e.stopPropagation();
                  const row = rows[Number(e.key) - 1];
                  if (row) openThread(row.id);
                  return;
                }
                // Accept the highlighted operator suggestion with Tab or Enter.
                if (activeSuggestion && (e.key === "Tab" || e.key === "Enter")) {
                  e.preventDefault();
                  applyCompletion(activeSuggestion);
                  return;
                }
                if (mode === "search" && rows.length > 0) {
                  // Arrow keys move the highlight through the results; Enter
                  // opens the highlighted one. Until you arrow in, Enter does
                  // nothing so plain typing never jumps to an email.
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveCursor(1);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveCursor(-1);
                    return;
                  }
                  if (e.key === "Enter" && enterArmed) {
                    e.preventDefault();
                    const id = useUi.getState().selectedThreadId;
                    if (id != null) openThread(id);
                    return;
                  }
                }
                if (e.key !== "Enter") return;
                // Ask mode: Enter runs the question. Search mode with no
                // highlight: nothing — never yank into an email while typing.
                if (mode === "ask") {
                  e.preventDefault();
                  if (input.trim()) ask.run(input.trim());
                }
              }}
              placeholder={mode === "ask" ? "Ask anything about your mailbox…" : t("common:search.placeholder")}
              className="w-full bg-transparent py-1 text-[17px] text-ink outline-none placeholder:text-ink-faint"
              spellCheck={false}
            />
            {(isFetching || ask.status === "pending" || ask.status === "streaming") && (
              <span className="co-spinner size-3 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
            )}
            <div className="flex shrink-0 rounded-lg border border-hairline bg-bg0 p-0.5">
              {(["search", "ask"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  title={t("common:search.toggleHint")}
                  onClick={() => {
                    setMode(m);
                    inputRef.current?.focus();
                  }}
                  className={`rounded-md px-2.5 py-0.5 text-[12px] transition-colors ${
                    m === mode ? "bg-bg2 font-medium text-ink" : "text-ink-faint hover:text-ink-muted"
                  }`}
                >
                  {m === "search" ? "Search" : "Ask"}
                </button>
              ))}
            </div>
            <kbd className="co-kbd shrink-0">Esc</kbd>
          </div>
          {mode === "search" && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <span className="text-[11px] text-ink-faint">{t("common:search.try")}</span>
              {opSuggestions.length > 0
                ? // Completing the current token: show matches, first is active.
                  opSuggestions.slice(0, 6).map((op) => {
                    const active = op === activeSuggestion;
                    return (
                      <button
                        key={op}
                        className={`co-chip !py-0.5 !text-[11.5px] hover:bg-bg2 ${
                          active
                            ? "!border-accent/60 bg-accent/10 text-ink"
                            : "text-ink-muted"
                        }`}
                        onClick={() => applyCompletion(op)}
                      >
                        {op}
                        {active && <kbd className="co-kbd ml-1.5 !text-[9px]">⇥</kbd>}
                      </button>
                    );
                  })
                : // Nothing to complete: the default starter operators.
                  OPERATORS.map((op) => (
                    <button
                      key={op}
                      className="co-chip !py-0.5 !text-[11.5px] text-ink-muted hover:bg-bg2"
                      onClick={() => {
                        setInput((v) => (v.trim() ? `${v.trim()} ${op}` : op));
                        inputRef.current?.focus();
                      }}
                    >
                      {op}
                    </button>
                  ))}
            </div>
          )}
        </div>
      </div>

      {mode === "ask" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[860px] px-6 py-6">
            {ask.status === "idle" ? (
              <p className="text-[13px] text-ink-faint">
                Ask a question like “what did Alice say about the Q3 budget?” and get an answer
                grounded in your mail, with sources.
              </p>
            ) : ask.status === "error" ? (
              <p className="text-[13px] text-danger">
                Ask failed. Make sure AI is configured in Settings.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {ask.answer ? (
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">
                    {ask.answer}
                    {ask.status === "streaming" && (
                      <span className="ml-0.5 inline-block animate-pulse text-ink-faint">▍</span>
                    )}
                  </p>
                ) : (
                  <p className="text-[13px] text-ink-faint">
                    {ask.citations.length > 0
                      ? `Reading ${ask.citations.length} source${ask.citations.length === 1 ? "" : "s"}…`
                      : "Searching your mailbox…"}
                  </p>
                )}
                {ask.citations.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                      Sources
                    </span>
                    {ask.citations.map((c, i) => (
                      <button
                        key={c.messageId}
                        onClick={() => openThread(c.threadId)}
                        className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
                      >
                        <span className="text-[11px] text-ink-faint">[{i + 1}]</span>
                        <span className="flex-1 truncate text-[13px] text-ink">{c.subject}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-faint">{c.from}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {(contactHits?.length ?? 0) > 0 && storedQuery.trim() !== "" && (
            <div className="co-hairline-b flex shrink-0 flex-wrap items-center gap-2 px-6 py-2.5">
              {contactHits!.map((c) => (
                <button
                  key={c.email}
                  type="button"
                  title={`from:${c.email}`}
                  onClick={() => setInput(`from:${c.email} `)}
                  className="co-chip flex items-center gap-2 !py-1 hover:bg-bg2"
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-bg2 text-[10px] font-semibold uppercase text-ink-muted">
                    {(c.name ?? c.email).trim().charAt(0)}
                  </span>
                  <span className="text-[12.5px] text-ink">{c.name ?? c.email}</span>
                  <span className="text-[11px] text-ink-faint">{c.interactions}</span>
                </button>
              ))}
            </div>
          )}
          {storedQuery.trim() === "" ? (
            <p className="px-6 py-10 text-center text-[13px] text-ink-faint">
              {t("common:search.emptyHint")}
            </p>
          ) : rows.length === 0 && !isFetching ? (
            <p className="px-6 py-10 text-center text-[13px] text-ink-faint">
              {t("common:search.noResults", { query: storedQuery })}
            </p>
          ) : (
            <ThreadList threads={rows} selfEmails={selfEmails} labelMap={labelMap} jumpHints={modHeld} />
          )}
        </div>
      )}
    </div>
  );
}
