import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage, isAiKeyRejected } from "../../ipc/errors";
import type { AiFilterTurn } from "../../ipc/types";
import {
  useAccounts,
  useAsk,
  useContactSuggestions,
  useLabels,
  useSearch,
  useSearchExplain,
  useSettings,
} from "../../queries/hooks";
import { useModHeld } from "../../lib/useModHeld";
import { MOD_LABEL } from "../../lib/format";
import { useUi } from "../../stores/ui";
import { ThreadList } from "../inbox/ThreadList";
import { Markdown } from "../common/Markdown";
import { AiBadge, AiSurface } from "../ui/Ai";
import { SectionLabel, Segmented } from "../ui/Field";
import { Spinner } from "../ui/Spinner";
import { SourcePreview } from "./SourcePreview";
import {
  OPERATOR_META,
  applySuggestion,
  chipLabel,
  currentToken as tokenAt,
  describe,
  replaceSpan,
  suggestionsFor,
  tierHeaders,
  type Suggestion,
} from "./searchSyntax";

// Ready-made example queries for the "?" cheat-sheet. Each row is the query
// plus the i18n key (common:search.help.*) of what it does; clicking one drops
// it into the search box.
const SEARCH_EXAMPLES: [string, string][] = [
  ["from:alice in:inbox last:7d", "ex1"],
  ["subject:invoice has:attachment", "ex2"],
  ["from:me sort:oldest", "ex3"],
  ["label:work is:unread", "ex4"],
  ['between:2026-01-01:2026-03-31 "q1 report"', "ex5"],
  ["report -draft", "ex6"],
];
const STARTERS = OPERATOR_META.filter((m) => m.starter);

// ⌘/Ctrl+O on a plain-language description: AI writes the query. It may ask
// back first ("Which Hoang?"); answers accumulate in `history`.
type AiFilterState = {
  request: string;
  history: AiFilterTurn[];
  pending: boolean;
  ask: { question: string; options: { label: string; value: string }[] } | null;
  error: string | null;
  /** the error is a rejected API key: offer a jump to Settings → AI */
  keyRejected?: boolean;
};

// The most recent line of the model's reasoning, for the clipped one-line trace.
function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1] : text;
}

export function SearchScreen() {
  const { t, i18n } = useTranslation();
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
  const [aiFilter, setAiFilter] = useState<AiFilterState | null>(null);
  // Bumped per request so a cancelled or superseded reply is ignored.
  const aiFilterSeq = useRef(0);
  const aiAnswerRef = useRef<HTMLInputElement>(null);
  const aiOptionsRef = useRef<HTMLDivElement>(null);
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
  // What the query will do, parsed on every keystroke (no debounce) so the
  // chips and sentence keep pace with typing.
  const { data: explain } = useSearchExplain(mode === "search" ? input : "");

  // Typing (or switching mode) disarms Enter so refining a query can't open a
  // stale row.
  useEffect(() => setEnterArmed(false), [storedQuery, mode]);
  // Contact autocomplete: while typing a `from:`/`to:` value, suggest senders
  // matching the partial after the colon; for a plain query (no operator),
  // suggest people to turn the query into a `from:` filter.
  const { start: tokenStart, token: currentToken } = tokenAt(input);
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
  const { data: settings } = useSettings();
  const avatarUi = settings?.inboxUi === "avatar";

  const rows = useMemo(() => results?.threads ?? [], [results]);
  // "Partial matches" / "Related" headers above the first row of each weaker
  // tier, so it's obvious where exact keyword matches end.
  const sections = useMemo(() => tierHeaders(results?.hits ?? [], t), [results, t]);

  // Learn from what gets opened: each thread opened while these results are
  // on screen is recorded (locally) so future searches rank it, and its
  // sender, higher.
  const openThreadId = useUi((s) => s.openThreadId);
  const lastRecorded = useRef<number | null>(null);
  useEffect(() => {
    if (openThreadId == null || openThreadId === lastRecorded.current) return;
    if (!storedQuery.trim() || !rows.some((r) => r.id === openThreadId)) return;
    lastRecorded.current = openThreadId;
    void call("record_search_open", { query: storedQuery, threadId: openThreadId }).catch(() => {});
  }, [openThreadId, storedQuery, rows]);

  // For a list-focused entry ("View all from sender"), put the cursor on the
  // first result once it loads so there's a visible highlight and single-row
  // keys (x, J/K, Enter) have a target. Waits for results, then clears itself.
  useEffect(() => {
    if (!pendingListFocus || rows.length === 0) return;
    setPendingListFocus(false);
    setEnterArmed(true);
    selectThread(0, rows[0].id);
  }, [rows, pendingListFocus, selectThread]);

  // A new query puts the cursor back on the first result (and scrolls it into
  // view) once that query's results land; otherwise the highlight stays on
  // whatever row the previous search left it, often far down the list.
  const cursorResetFor = useRef<string | null>(null);
  useEffect(() => {
    cursorResetFor.current = storedQuery;
  }, [storedQuery]);
  useEffect(() => {
    if (cursorResetFor.current == null || isFetching) return;
    cursorResetFor.current = null;
    selectThread(0, rows[0]?.id ?? null);
  }, [rows, isFetching, selectThread]);

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

  // As-you-type completion of the token being typed: operators for a bare
  // word, and right after `label:` / `in:` / `is:` / … the values that
  // operator takes - so typing `label:` immediately lists your labels. The
  // first row is "active": Tab or Enter completes to it.
  const suggestions = useMemo(
    () => (mode === "search" ? suggestionsFor(currentToken, labels ?? []) : []),
    [currentToken, labels, mode],
  );
  const activeSuggestion: Suggestion | null =
    mode === "search" && !enterArmed ? (suggestions[0] ?? null) : null;

  const runAiFilter = (request: string, history: AiFilterTurn[]) => {
    const seq = ++aiFilterSeq.current;
    setAiFilter({ request, history, pending: true, ask: null, error: null });
    call("ai_search_filter", { request, history })
      .then((res) => {
        if (seq !== aiFilterSeq.current) return;
        if (res.kind === "query") {
          setAiFilter(null);
          setInput(res.query);
          inputRef.current?.focus();
        } else {
          setAiFilter({ request, history, pending: false, ask: res, error: null });
        }
      })
      .catch((err) => {
        if (seq !== aiFilterSeq.current) return;
        setAiFilter({
          request,
          history,
          pending: false,
          ask: null,
          error: errorMessage(err),
          keyRejected: isAiKeyRejected(err),
        });
      });
  };
  const answerAiFilter = (answer: string) => {
    if (!aiFilter?.ask || !answer.trim()) return;
    runAiFilter(aiFilter.request, [
      ...aiFilter.history,
      { question: aiFilter.ask.question, answer: answer.trim() },
    ]);
  };
  const cancelAiFilter = () => {
    aiFilterSeq.current++;
    setAiFilter(null);
    inputRef.current?.focus();
  };
  // Move focus to the question as it appears so 1-9 / Enter pick right away.
  useEffect(() => {
    if (!aiFilter?.ask) return;
    const first = aiOptionsRef.current?.querySelector("button");
    if (first) first.focus();
    else aiAnswerRef.current?.focus();
  }, [aiFilter?.ask]);

  const applyCompletion = (insert: string) => {
    setInput(applySuggestion(input, tokenStart, insert));
    inputRef.current?.focus();
  };

  // Edit the query from the explain row: drop a filter (× on its chip) or
  // apply a did-you-mean fix. Spans come from the parse of `input` itself.
  const editSpan = (start: number, end: number, text = "") => {
    setInput(replaceSpan(input, start, end, text));
    inputRef.current?.focus();
  };
  const sentence = useMemo(
    // Only once there's something to describe: a half-typed `label:` alone
    // would read as the empty "Emails, newest first."
    () =>
      explain && (explain.chips.length > 0 || explain.terms.length > 0)
        ? describe(explain, t, i18n.language)
        : "",
    [explain, input, t, i18n.language],
  );

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
                // Cmd/Ctrl+O: turn the plain-language text into a filter.
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (mode === "search" && input.trim()) runAiFilter(input.trim(), []);
                  return;
                }
                if (aiFilter && e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelAiFilter();
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
                  applyCompletion(activeSuggestion.insert);
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
              placeholder={mode === "ask" ? t("common:search.askPlaceholder") : t("common:search.placeholder")}
              className="w-full bg-transparent py-1 text-lg text-ink outline-none placeholder:text-ink-faint"
              spellCheck={false}
            />
            {mode === "search" && (
              <button
                type="button"
                disabled={input.trim() === "" || aiFilter != null}
                tabIndex={input.trim() === "" || aiFilter != null ? -1 : undefined}
                title={t("common:search.aiFilterHint", { shortcut: `${MOD_LABEL}O` })}
                onClick={() => runAiFilter(input.trim(), [])}
                className={`co-chip shrink-0 !py-0.5 !text-xs text-ink-muted hover:bg-bg2 ${
                  input.trim() === "" || aiFilter != null ? "invisible" : ""
                }`}
              >
                <AiBadge label={t("common:search.aiFilter")} className="!text-xs" />
                <kbd className="co-kbd !text-2xs">{MOD_LABEL}O</kbd>
              </button>
            )}
            {/* Fixed slot: the spinner blinks on every keystroke's refetch, and
                mounting it in the row would shove the input sideways. */}
            <span className="flex size-4 shrink-0 items-center justify-center">
              {(isFetching || ask.status === "pending" || ask.status === "streaming") && (
                <Spinner className={mode === "ask" ? "co-ai-icon" : "text-ink-faint"} />
              )}
            </span>
            {mode === "search" && (
              <span
                className={`co-chip min-w-[3rem] shrink-0 justify-center !py-0.5 !text-xs tabular-nums text-ink-muted ${
                  storedQuery.trim() !== "" && rows.length > 0 ? "" : "invisible"
                }`}
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
                  className={`flex size-5 items-center justify-center rounded-full border text-xs font-medium transition-colors ${
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
                    <div className="co-pop-in absolute right-0 top-full z-30 mt-2 w-[340px] overflow-hidden rounded-card border border-hairline bg-bg1 shadow-elev-2">
                      <div className="border-b border-hairline px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                        {t("common:search.help.title")}
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
                            <span className="w-[92px] shrink-0 font-mono text-sm text-ink">
                              {m.op}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                              {t(`common:search.ops.${m.descKey}`)}
                            </span>
                          </button>
                        ))}
                        <div className="mt-1 border-t border-hairline px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                          {t("common:search.help.examples")}
                        </div>
                        {SEARCH_EXAMPLES.map(([ex, key]) => (
                          <button
                            key={ex}
                            title={ex}
                            onClick={() => {
                              setInput(ex);
                              setShowHelp(false);
                              inputRef.current?.focus();
                            }}
                            className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-bg2"
                          >
                            <span className="break-words font-mono text-xs text-ink-muted">
                              {ex}
                            </span>
                            <span className="text-xs text-ink-faint">
                              {t(`common:search.help.${key}`)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="shrink-0" title={t("common:search.toggleHint")}>
              <Segmented
                value={mode}
                options={[
                  { value: "search" as const, label: t("common:search.modeSearch") },
                  { value: "ask" as const, label: <AiBadge label={t("common:search.modeAsk")} className="text-sm" /> },
                ]}
                onChange={(m) => {
                  setMode(m);
                  inputRef.current?.focus();
                }}
              />
            </div>
            <kbd className="co-kbd shrink-0">Esc</kbd>
          </div>
          {mode === "search" && aiFilter && (
            <AiSurface className="co-fade-in mt-2.5 px-3 py-2.5">
              <div
                className="flex flex-col gap-2"
                onKeyDown={(e) => {
                  // Keep Esc / digits away from the global registry.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelAiFilter();
                    return;
                  }
                  const opts = aiFilter.ask?.options ?? [];
                  if (e.target !== aiAnswerRef.current && /^[1-9]$/.test(e.key)) {
                    e.stopPropagation();
                    const o = opts[Number(e.key) - 1];
                    if (o) {
                      e.preventDefault();
                      answerAiFilter(o.value);
                    }
                  }
                }}
              >
                <div className="flex items-center gap-2 text-sm">
                  <AiBadge label={t("common:search.aiFilter")} className="shrink-0 !text-xs" />
                  <span className="min-w-0 flex-1 truncate text-ink-faint" title={aiFilter.request}>
                    {aiFilter.request}
                  </span>
                  <button
                    type="button"
                    onClick={cancelAiFilter}
                    title={`${t("common:search.aiFilterCancel")} (Esc)`}
                    className="shrink-0 text-xs text-ink-faint hover:text-ink"
                  >
                    {t("common:search.aiFilterCancel")}
                  </button>
                </div>
                {aiFilter.pending && (
                  <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Spinner className="co-ai-icon" />
                    {t("common:search.aiFilterWorking")}
                  </div>
                )}
                {aiFilter.error && (
                  <div className="flex items-center gap-3 text-sm text-danger">
                    <span className="min-w-0 flex-1">
                      {t("common:search.aiFilterFailed", { error: aiFilter.error })}
                    </span>
                    {aiFilter.keyRejected && (
                      <button
                        type="button"
                        onClick={() => set({ panel: "settings", settingsTab: "ai" })}
                        className="co-chip shrink-0 !py-0.5 !text-xs text-ink hover:bg-bg2"
                      >
                        {t("common:search.aiFilterSettings")}
                      </button>
                    )}
                  </div>
                )}
                {aiFilter.ask && !aiFilter.pending && (
                  <>
                    <div className="text-base text-ink">{aiFilter.ask.question}</div>
                    {aiFilter.ask.options.length > 0 && (
                      <div ref={aiOptionsRef} className="flex flex-wrap gap-1.5">
                        {aiFilter.ask.options.map((o, i) => (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => answerAiFilter(o.value)}
                            className="co-chip flex items-center gap-1.5 !py-1 text-sm text-ink hover:bg-bg2 focus-visible:outline focus-visible:outline-accent"
                          >
                            {i < 9 && <kbd className="co-kbd !text-2xs">{i + 1}</kbd>}
                            {o.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      ref={aiAnswerRef}
                      placeholder={t("common:search.aiFilterAnswer")}
                      spellCheck={false}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          answerAiFilter(e.currentTarget.value);
                        }
                      }}
                      className="w-full rounded-control border border-hairline bg-bg1 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
                    />
                  </>
                )}
              </div>
            </AiSurface>
          )}
          {mode === "search" && !aiFilter && (
            <div className="relative mt-2.5">
              {suggestions.length > 0 && (
                // Completing the current token: a floating list of operators
                // or of the values the operator takes (labels with their
                // colour). The first is active - Tab/Enter (or a click)
                // accepts it. Absolute so it overlays the row below without
                // nudging the results as it appears.
                <div className="co-pop-in absolute left-0 top-0 z-20 w-[380px] max-w-full overflow-hidden rounded-card border border-hairline bg-bg1 py-1 shadow-elev-2">
                  {suggestions.slice(0, 8).map((sg) => {
                    const active = sg === activeSuggestion;
                    return (
                      <button
                        key={sg.insert}
                        // mousedown, not click: fire before the input blurs so
                        // focus (and the caret) stays put through completion.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyCompletion(sg.insert);
                        }}
                        className={`flex w-full items-center gap-3 px-3 py-1.5 text-left ${
                          active ? "bg-accent/10" : "hover:bg-bg2"
                        }`}
                      >
                        {sg.kind === "label" && (
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: sg.color }}
                          />
                        )}
                        <span
                          className={`shrink-0 ${sg.kind === "label" ? "text-sm" : "font-mono text-sm"} ${
                            active ? "text-accent" : "text-ink"
                          }`}
                        >
                          {sg.label}
                        </span>
                        {sg.descKey && (
                          <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                            {t(`common:search.${sg.descKey}`)}
                          </span>
                        )}
                        {active && (
                          <kbd className="co-kbd ml-auto shrink-0 !text-2xs">⇥</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {input.trim() === "" ? (
                // Nothing typed: the starter operators, each labelled with
                // what it does.
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-ink-faint">
                    {t("common:search.try")}
                  </span>
                  {STARTERS.map((m) => (
                    <button
                      key={m.op}
                      title={t(`common:search.ops.${m.descKey}`)}
                      className="co-chip !py-0.5 !text-xs text-ink-muted hover:bg-bg2"
                      onClick={() => {
                        setInput(m.op);
                        inputRef.current?.focus();
                      }}
                    >
                      {m.op}
                    </button>
                  ))}
                </div>
              ) : (
                // The explain row: every understood filter as a removable
                // chip, anything that couldn't be used as an amber warning
                // with its fix, and one sentence saying what will be shown.
                <div className="flex min-h-[22px] flex-col gap-1.5">
                  {((explain?.chips.length ?? 0) > 0 || (explain?.warnings.length ?? 0) > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {explain?.chips.map((c) => {
                        const text = chipLabel(c, t);
                        const color =
                          c.kind === "label"
                            ? labels?.find((l) => l.name === c.value)?.color
                            : undefined;
                        return (
                          <span
                            key={`${c.start}-${c.kind}`}
                            className="co-chip flex items-center gap-1.5 !py-0.5 !text-xs text-ink"
                          >
                            {color && (
                              <span className="size-2 rounded-full" style={{ background: color }} />
                            )}
                            {text}
                            <button
                              type="button"
                              title={t("common:search.removeFilter", { label: text })}
                              aria-label={t("common:search.removeFilter", { label: text })}
                              className="text-ink-faint hover:text-ink"
                              onClick={() => editSpan(c.start, c.end)}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                      {explain?.warnings.map((w) => (
                        <span
                          key={`${w.start}-${w.kind}`}
                          className="co-chip flex items-center gap-1.5 !border-star/40 !bg-star/10 !py-0.5 !text-xs text-ink"
                        >
                          {t(`common:search.warn.${w.kind}`, { token: w.token })}
                          {w.suggestion && (
                            <button
                              type="button"
                              className="font-medium text-accent hover:underline"
                              onClick={() =>
                                editSpan(
                                  w.start,
                                  w.end,
                                  w.kind === "unknown_label"
                                    ? `label:${/\s/.test(w.suggestion!) ? `"${w.suggestion}"` : w.suggestion}`
                                    : w.suggestion!,
                                )
                              }
                            >
                              {t("common:search.warn.use", { fix: w.suggestion })}
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {sentence && <p className="truncate text-xs text-ink-faint" title={sentence}>{sentence}</p>}
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
              <p className="text-base text-ink-faint">{t("common:search.askIntro")}</p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Sources - left rail */}
            <aside className="co-hairline-r flex w-[300px] shrink-0 flex-col gap-1 overflow-y-auto px-3 py-5">
              <SectionLabel className="px-2">{t("common:search.sources")}</SectionLabel>
              {ask.citations.length > 0 ? (
                ask.citations.map((c, i) => (
                  <button
                    key={c.messageId}
                    onClick={() => setPreviewThreadId(c.threadId)}
                    className="flex items-baseline gap-2 rounded-control px-2 py-1.5 text-left hover:bg-bg2"
                  >
                    <span className="text-xs text-ink-faint">[{i + 1}]</span>
                    <span className="min-w-0 flex-1 truncate text-base text-ink">{c.subject}</span>
                    <span className="shrink-0 text-xs text-ink-faint">{c.from}</span>
                  </button>
                ))
              ) : (
                <p className="px-2 text-sm text-ink-faint">{t("common:search.searchingMailbox")}</p>
              )}
            </aside>

            {/* Answer - main pane */}
            <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-[760px]">
                {ask.reasoning && (
                  <p
                    title={ask.reasoning}
                    className="mb-4 flex items-center gap-2 overflow-hidden text-sm text-ink-faint"
                  >
                    {(ask.status === "streaming" || ask.status === "pending") && <Spinner />}
                    <span className="truncate">{lastLine(ask.reasoning)}</span>
                  </p>
                )}
                {ask.status === "error" ? (
                  <p className="text-base text-danger">{ask.error || t("common:search.askFailed")}</p>
                ) : (
                  <AiSurface className="px-5 py-4">
                    <AiBadge className="mb-2" />
                    {ask.answer ? (
                      <div className="text-md leading-relaxed text-ink">
                        <Markdown text={ask.answer} />
                        {ask.status === "streaming" && (
                          <span className="ml-0.5 inline-block animate-pulse text-ink-faint">▍</span>
                        )}
                      </div>
                    ) : (
                      <p className="text-base text-ink-faint">
                        {ask.citations.length > 0
                          ? t("common:search.readingSources", { count: ask.citations.length })
                          : t("common:search.searchingMailbox")}
                      </p>
                    )}
                  </AiSurface>
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
                  <span className="flex size-5 items-center justify-center rounded-full bg-bg2 text-2xs font-semibold uppercase text-ink-muted">
                    {(c.name ?? c.email).trim().charAt(0)}
                  </span>
                  <span className="text-sm text-ink">{c.name ?? c.email}</span>
                  <span className="text-xs text-ink-faint">{c.interactions}</span>
                </button>
              ))}
            </div>
          )}
          {storedQuery.trim() === "" ? (
            <p className="px-6 py-10 text-center text-base text-ink-faint">
              {t("common:search.emptyHint")}
            </p>
          ) : rows.length === 0 && !isFetching && suggestions.length > 0 ? (
            // Mid-completion (`label:` with its value list open): a bare
            // operator matches nothing yet, which isn't worth announcing.
            null
          ) : rows.length === 0 && !isFetching ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-base text-ink-faint">
                {t("common:search.noResults", { query: storedQuery })}
              </p>
              {/* Filters are the usual reason for an empty result: offer to
                  drop each one in a click. */}
              {(explain?.chips.length ?? 0) > 0 && input === storedQuery && (
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <span className="text-xs text-ink-faint">{t("common:search.noResultsHint")}</span>
                  {explain!.chips.map((c) => (
                    <button
                      key={`${c.start}-${c.kind}`}
                      type="button"
                      className="co-chip !py-0.5 !text-xs text-ink-muted hover:bg-bg2"
                      onClick={() => editSpan(c.start, c.end)}
                    >
                      {chipLabel(c, t)} ×
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ThreadList
              threads={rows}
              sections={sections}
              selfEmails={selfEmails}
              labelMap={labelMap}
              jumpHints={modHeld}
              layout={settings?.inboxUi}
              photos={avatarUi && (settings?.showSenderPhotos ?? true)}
            />
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
