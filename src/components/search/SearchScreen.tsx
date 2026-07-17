import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { useAccounts, useAsk, useContactSuggestions, useLabels, useSearch } from "../../queries/hooks";
import { useModHeld } from "../../lib/useModHeld";
import { useUi } from "../../stores/ui";
import { ThreadList } from "../inbox/ThreadList";
import { Markdown } from "../common/Markdown";
import { SourcePreview } from "./SourcePreview";

// Every operator the search parser understands, each with a one-line
// description that drives the as-you-type suggestion list and hover hints.
// Operators ending in `:` take a freeform value, so they complete to the bare
// prefix; the rest are self-contained. `starter` surfaces the operator in the
// "Try" row shown when there's nothing to complete.
type OperatorMeta = { op: string; desc: string; starter?: boolean };
const OPERATOR_META: OperatorMeta[] = [
  { op: "from:", desc: "Sender name or email", starter: true },
  { op: "to:", desc: "Recipient name or email" },
  { op: "subject:", desc: 'Words or "phrase" in the subject', starter: true },
  { op: "body:", desc: 'Words or "phrase" in the body' },
  { op: "in:inbox", desc: "Only the inbox", starter: true },
  { op: "in:sent", desc: "Only sent mail" },
  { op: "in:drafts", desc: "Only drafts" },
  { op: "in:archive", desc: "Only archived mail" },
  { op: "in:trash", desc: "Only trash" },
  { op: "in:spam", desc: "Only spam" },
  { op: "is:unread", desc: "Unread only", starter: true },
  { op: "is:starred", desc: "Starred only" },
  { op: "has:attachment", desc: "Has an attachment", starter: true },
  { op: "last:7days", desc: "Within the last 7 days", starter: true },
  { op: "last:month", desc: "Within the last 30 days" },
  { op: "after:", desc: "On or after a date, YYYY-MM-DD" },
  { op: "before:", desc: "Before a date, YYYY-MM-DD" },
  { op: "between:", desc: "Date range, YYYY-MM-DD:YYYY-MM-DD" },
  { op: "sort:newest", desc: "Newest first (default)" },
  { op: "sort:oldest", desc: "Oldest first" },
  { op: "exclude:", desc: "Drop results with a word" },
];
const OPERATORS = OPERATOR_META.filter((m) => m.starter);

// Ready-made example queries for the "?" cheat-sheet, grouped by theme. Each
// row is [query, what it does]; clicking one drops it into the search box.
const SEARCH_EXAMPLES: { title: string; rows: [string, string][] }[] = [
  {
    title: "Combine operators",
    rows: [
      ["from:alice in:inbox last:7days", "recent inbox mail from Alice"],
      ["subject:invoice has:attachment", "invoices with an attachment"],
      ["in:sent sort:oldest", "your sent mail, oldest first"],
      ["from:bob is:unread is:starred", "unread, starred mail from Bob"],
      [
        'between:2026-01-01:2026-03-31 subject:"q1 report"',
        "a phrase within a date range",
      ],
    ],
  },
  {
    title: "Phrases & case",
    rows: [
      ['subject:"quarterly report"', "match an exact phrase"],
      ['subject:!"phrase"', "ignore case (the default)"],
      ['subject:!!"Phrase"', "match case exactly"],
      ['"kept together"', "quote any phrase, not just fields"],
    ],
  },
];

// The most recent line of the model's reasoning, for the clipped one-line trace.
function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1] : text;
}

export function SearchScreen() {
  const { t } = useTranslation();
  const storedQuery = useUi((s) => s.searchQuery);
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const openThread = useUi((s) => s.openThread);
  const selectThread = useUi((s) => s.selectThread);

  const [input, setInput] = useState(storedQuery);
  const [mode, setMode] = useState<"search" | "ask">("search");
  // The "?" cheat-sheet popover that introduces the search operators.
  const [showHelp, setShowHelp] = useState(false);
  // Enter guard: false while typing, so Enter never opens an email until you
  // arrow into the list. Arrowing moves the shared cursor (highlight and
  // scrolling live in ThreadList, same as the inbox).
  const [enterArmed, setEnterArmed] = useState(false);
  // Source citation opened in a preview modal (keeps the Ask mounted).
  const [previewThreadId, setPreviewThreadId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ask = useAsk();
  // ⌘/Ctrl held: reveal each result's jump-to number (⌘/Ctrl+1..9 opens it).
  const modHeld = useModHeld();

  // Focus management. A pushed query ("View all from this sender") should land
  // on the results so triage keys (⌘A, x, #) work right away; a normal open
  // focuses the query box for typing. Driven off the store flag so it works
  // whether search was just opened or is already on screen when the query
  // arrives, and the flag is always consumed so it can't leak to a later open.
  const focusListReq = useUi((s) => s.searchFocusList);
  const openedOnList = useRef(focusListReq);
  const [pendingListFocus, setPendingListFocus] = useState(false);
  useEffect(() => {
    if (!openedOnList.current) inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!focusListReq) return;
    useUi.getState().set({ searchFocusList: false });
    setPendingListFocus(true);
    inputRef.current?.blur();
  }, [focusListReq]);

  // Adopt a one-shot mode request (palette "Ask AI" opens straight into Ask).
  const modeRequest = useUi((s) => s.searchModeRequest);
  useEffect(() => {
    if (modeRequest) {
      setMode(modeRequest);
      useUi.getState().set({ searchModeRequest: null });
    }
  }, [modeRequest]);

  // 50ms debounce into the store (which keys the query). keepPreviousData in
  // useSearch keeps the previous results on screen between keystrokes.
  useEffect(() => {
    const t = setTimeout(() => set({ searchQuery: input }), 50);
    return () => clearTimeout(t);
  }, [input, set]);

  // Pre-warm the semantic query embedding while typing (trailing throttle) so
  // the search that fires when the user pauses hits the embedding cache
  // instead of paying the model forward pass. Fire-and-forget.
  useEffect(() => {
    if (mode !== "search" || input.trim().length < 3) return;
    const t = setTimeout(() => {
      void call("warm_search_embedding", { query: input }).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [input, mode]);

  // Adopt a query pushed from outside while already open (palette "View all
  // from this sender"). During typing storedQuery only ever catches up to
  // input via the debounce above, so this is a no-op then.
  useEffect(() => {
    setInput((cur) => (cur === storedQuery ? cur : storedQuery));
  }, [storedQuery]);

  const { data: results, isFetching } = useSearch(storedQuery, accountFilter);

  // Typing (or switching mode) disarms Enter so refining a query can't open a
  // stale row.
  useEffect(() => setEnterArmed(false), [storedQuery, mode]);
  // Contact autocomplete: while typing a `from:`/`to:` value, suggest senders
  // matching the partial after the colon; for a plain query (no operator),
  // suggest people to turn the query into a `from:` filter.
  const tokenStart = input.lastIndexOf(" ") + 1;
  const currentToken = input.slice(tokenStart);
  const contactOp = /^(from:|to:)/i.exec(currentToken)?.[1].toLowerCase() ?? null;
  const contactQuery = contactOp
    ? currentToken.slice(contactOp.length)
    : mode === "search" && !input.includes(":")
      ? input.trim()
      : "";
  const { data: contactHits } = useContactSuggestions(contactQuery);
  const { data: accounts } = useAccounts();
  const { data: labels } = useLabels();
  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const labelMap = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  const rows = results ?? [];

  // For a list-focused entry ("View all from sender"), put the cursor on the
  // first result once it loads so there's a visible highlight and single-row
  // keys (x, J/K, Enter) have a target. Waits for results, then clears itself.
  useEffect(() => {
    if (!pendingListFocus || rows.length === 0) return;
    setPendingListFocus(false);
    setEnterArmed(true);
    selectThread(0, rows[0].id);
  }, [rows, pendingListFocus, selectThread]);

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
  // "active" suggestion - Tab or Enter completes to it.
  const opSuggestions = useMemo(() => {
    const tok = currentToken.toLowerCase();
    if (!tok) return [] as OperatorMeta[];
    return OPERATOR_META.filter(
      (m) => m.op.toLowerCase().startsWith(tok) && m.op.toLowerCase() !== tok,
    );
  }, [currentToken]);
  const activeSuggestion =
    mode === "search" && !enterArmed ? (opSuggestions[0]?.op ?? null) : null;

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
                // Cmd/Ctrl+A selects the query text. Handled explicitly: the
                // native menu equivalent doesn't reliably reach the field in
                // the webview (notably with IME input), leaving the key to
                // fall through as a plain "a".
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.select();
                  return;
                }
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
                  // Arrow keys move the highlight through the results. Enter
                  // steps into the list: the first Enter highlights the top
                  // result (moving focus out of the input), a second Enter
                  // opens it. It never opens on the first press, so plain
                  // typing can't yank into an email.
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
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (enterArmed) {
                      const id = useUi.getState().selectedThreadId;
                      if (id != null) openThread(id);
                    } else {
                      // Highlight the first result (cursor was at -1).
                      moveCursor(1);
                    }
                    return;
                  }
                }
                if (e.key !== "Enter") return;
                // Ask mode: Enter runs the question. Search mode with no
                // highlight: nothing - never yank into an email while typing.
                if (mode === "ask") {
                  e.preventDefault();
                  if (input.trim()) ask.run(input.trim(), accountFilter);
                }
              }}
              placeholder={mode === "ask" ? "Ask anything about your mailbox…" : t("common:search.placeholder")}
              className="w-full bg-transparent py-1 text-[17px] text-ink outline-none placeholder:text-ink-faint"
              spellCheck={false}
            />
            {(isFetching || ask.status === "pending" || ask.status === "streaming") && (
              <span className="co-spinner size-3 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
            )}
            {mode === "search" && storedQuery.trim() !== "" && rows.length > 0 && (
              <span
                className="co-chip shrink-0 !py-0.5 !text-[11px] tabular-nums text-ink-muted"
                title={`${rows.length}${rows.length >= 60 ? "+" : ""} result${
                  rows.length === 1 ? "" : "s"
                }`}
              >
                {rows.length}
                {rows.length >= 60 ? "+" : ""}
              </span>
            )}
            {mode === "search" && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  title="Search syntax"
                  aria-label="Search syntax"
                  onClick={() => setShowHelp((v) => !v)}
                  className={`flex size-5 items-center justify-center rounded-full border text-[11px] font-medium transition-colors ${
                    showHelp
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-hairline text-ink-faint hover:text-ink-muted"
                  }`}
                >
                  ?
                </button>
                {showHelp && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowHelp(false)}
                    />
                    <div className="co-pop-in absolute right-0 top-full z-30 mt-2 w-[340px] overflow-hidden rounded-xl border border-hairline bg-bg1 shadow-lg">
                      <div className="border-b border-hairline px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                        Search operators
                      </div>
                      <div className="max-h-[46vh] overflow-y-auto py-1">
                        {OPERATOR_META.map((m) => (
                          <button
                            key={m.op}
                            onClick={() => {
                              setInput((v) =>
                                v.trim() ? `${v.trim()} ${m.op}` : m.op,
                              );
                              setShowHelp(false);
                              inputRef.current?.focus();
                            }}
                            className="flex w-full items-center gap-3 px-3 py-1 text-left hover:bg-bg2"
                          >
                            <span className="w-[92px] shrink-0 font-mono text-[12px] text-ink">
                              {m.op}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-faint">
                              {m.desc}
                            </span>
                          </button>
                        ))}
                        {SEARCH_EXAMPLES.map((group) => (
                          <div key={group.title}>
                            <div className="mt-1 border-t border-hairline px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                              {group.title}
                            </div>
                            {group.rows.map(([ex, desc]) => (
                              <button
                                key={ex}
                                title={`Search: ${ex}`}
                                onClick={() => {
                                  setInput(ex);
                                  setShowHelp(false);
                                  inputRef.current?.focus();
                                }}
                                className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-bg2"
                              >
                                <span className="break-words font-mono text-[11.5px] text-ink-muted">
                                  {ex}
                                </span>
                                <span className="text-[11px] text-ink-faint">
                                  {desc}
                                </span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
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
            <div className="relative mt-2.5">
              {opSuggestions.length > 0 ? (
                // Completing the current token: a floating list of matches, each
                // with a one-line description. The first is active - Tab/Enter
                // (or a click) accepts it. Absolute so it overlays results
                // without nudging them as it appears.
                <div className="co-pop-in absolute left-0 top-0 z-20 w-[360px] max-w-full overflow-hidden rounded-xl border border-hairline bg-bg1 py-1 shadow-lg">
                  {opSuggestions.slice(0, 7).map((m) => {
                    const active = m.op === activeSuggestion;
                    return (
                      <button
                        key={m.op}
                        // mousedown, not click: fire before the input blurs so
                        // focus (and the caret) stays put through completion.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyCompletion(m.op);
                        }}
                        className={`flex w-full items-center gap-3 px-3 py-1.5 text-left ${
                          active ? "bg-accent/10" : "hover:bg-bg2"
                        }`}
                      >
                        <span
                          className={`shrink-0 font-mono text-[12.5px] ${
                            active ? "text-accent" : "text-ink"
                          }`}
                        >
                          {m.op}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-faint">
                          {m.desc}
                        </span>
                        {active && (
                          <kbd className="co-kbd shrink-0 !text-[9px]">⇥</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                // Nothing to complete: the default starter operators, each
                // labelled with what it does.
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-ink-faint">
                    {t("common:search.try")}
                  </span>
                  {OPERATORS.map((m) => (
                    <button
                      key={m.op}
                      title={m.desc}
                      className="co-chip !py-0.5 !text-[11.5px] text-ink-muted hover:bg-bg2"
                      onClick={() => {
                        setInput((v) => (v.trim() ? `${v.trim()} ${m.op}` : m.op));
                        inputRef.current?.focus();
                      }}
                    >
                      {m.op}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {mode === "ask" ? (
        ask.status === "idle" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[760px] px-6 py-6">
              <p className="text-[13px] text-ink-faint">
                Ask a question like “what did Alice say about the Q3 budget?” and get an answer
                grounded in your mail, with sources.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Sources - left rail */}
            <aside className="co-hairline-r flex w-[300px] shrink-0 flex-col gap-1 overflow-y-auto px-3 py-5">
              <span className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Sources
              </span>
              {ask.citations.length > 0 ? (
                ask.citations.map((c, i) => (
                  <button
                    key={c.messageId}
                    onClick={() => setPreviewThreadId(c.threadId)}
                    className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
                  >
                    <span className="text-[11px] text-ink-faint">[{i + 1}]</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{c.subject}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint">{c.from}</span>
                  </button>
                ))
              ) : (
                <p className="px-2 text-[12px] text-ink-faint">Searching your mailbox…</p>
              )}
            </aside>

            {/* Answer - main pane */}
            <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-[760px]">
                {ask.reasoning && (
                  <p
                    title={ask.reasoning}
                    className="mb-4 flex items-center gap-2 overflow-hidden text-[12px] text-ink-faint"
                  >
                    {ask.status === "streaming" && (
                      <span className="inline-block size-3 shrink-0 animate-spin rounded-full border border-ink-faint border-t-transparent" />
                    )}
                    <span className="truncate">{lastLine(ask.reasoning)}</span>
                  </p>
                )}
                {ask.status === "error" ? (
                  <p className="text-[13px] text-danger">
                    {ask.error || "Ask failed. Make sure AI is configured in Settings."}
                  </p>
                ) : ask.answer ? (
                  <div className="text-[14px] leading-relaxed text-ink">
                    <Markdown text={ask.answer} />
                    {ask.status === "streaming" && (
                      <span className="ml-0.5 inline-block animate-pulse text-ink-faint">▍</span>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-ink-faint">
                    {ask.citations.length > 0
                      ? `Reading ${ask.citations.length} source${ask.citations.length === 1 ? "" : "s"}…`
                      : "Searching your mailbox…"}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {(contactHits?.length ?? 0) > 0 && contactQuery.trim() !== "" && (
            <div className="co-hairline-b flex shrink-0 flex-wrap items-center gap-2 px-6 py-2.5">
              {contactHits!.map((c) => (
                <button
                  key={c.email}
                  type="button"
                  title={`${contactOp ?? "from:"}${c.email}`}
                  onClick={() => {
                    setInput(
                      contactOp
                        ? `${input.slice(0, tokenStart)}${contactOp}${c.email} `
                        : `from:${c.email} `,
                    );
                    inputRef.current?.focus();
                  }}
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

      {previewThreadId != null && (
        <SourcePreview
          threadId={previewThreadId}
          onClose={() => setPreviewThreadId(null)}
          onOpenFull={() => {
            const id = previewThreadId;
            setPreviewThreadId(null);
            openThread(id);
          }}
        />
      )}
    </div>
  );
}
