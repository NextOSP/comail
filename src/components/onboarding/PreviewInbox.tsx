import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiBadge, AiSurface } from "../ui/Ai";
import { Icon, type IconName } from "../ui/Icon";

/**
 * The real app, in miniature, for the onboarding stage. Built from the same
 * markup and classes as TopBar, SplitTabs, ThreadRow, ConversationScreen,
 * SearchScreen, CommandPalette and Toasts (co-row, co-glass, co-kbd,
 * AiSurface, the theme tokens) at true size and then scaled down, so it is
 * the app rather than an illustration of one, and it re-skins with the live
 * theme/accent pickers. The flow drives it with "beats".
 */

export type PreviewMode = "welcome" | "connect" | "waiting" | "connected" | "personalize" | "shortcuts" | "sync";
export type PreviewBeatKind =
  | "down"
  | "up"
  | "search"
  | "done"
  | "star"
  | "snooze"
  | "reply"
  | "palette"
  | "back"
  | "reset"
  | "resetThread"
  | "summarize"
  | "aiWrite"
  | "proofread"
  | "ask";
/** `n` increments per key press, so repeating the same beat replays it. */
export type PreviewBeat = { kind: PreviewBeatKind; n: number } | null;

interface Row {
  from: string;
  count?: number;
  labels?: string[];
  subject: string;
  snippet: string;
  time: string;
  unread?: boolean;
  starred?: boolean;
  group: "today" | "earlier";
}

interface PaletteItem {
  title: string;
  section: string;
  key: string;
}

type View = "list" | "thread" | "search";
type Draft = null | "typed" | "ai" | "proofread";

// The label palette (lib/labelColors), as ThreadRow tints it.
const LABEL_COLOR: Record<string, string> = {
  work: "#2563eb",
  followUp: "#d97706",
  personal: "#16a34a",
};

const VISIBLE = 8;
const EASE = [0.2, 0.8, 0.2, 1] as const;

export function PreviewInbox({
  mode,
  beat = null,
  syncFill = 1,
  account,
}: {
  mode: PreviewMode;
  beat?: PreviewBeat;
  /** The connected account, listed in the account menu ("connected" mode). */
  account?: { label: string; detail?: string };
  /** Sync mode: fraction of the inbox that has arrived. */
  syncFill?: number;
}) {
  const { t } = useTranslation();
  const rows = arr<Row>(t("onboarding:preview.rows", { returnObjects: true }));
  const tabs = arr<{ name: string; count: number }>(t("onboarding:preview.tabs", { returnObjects: true }));

  // Rows are keyed by an ever-growing counter so a row marked done can be
  // backfilled from the bottom (cycling the samples) without key collisions.
  const [keys, setKeys] = useState(() => Array.from({ length: VISIBLE }, (_, i) => i));
  const nextKey = useRef(VISIBLE);
  const [sel, setSel] = useState(0); // cursor row, an index into `keys`
  const [starred, setStarred] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ n: number; message: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [view, setView] = useState<View>("list");
  const [summary, setSummary] = useState(false);
  const [draft, setDraft] = useState<Draft>(null);
  const [ask, setAsk] = useState(false);
  const rowAt = (key: number) => rows[key % Math.max(1, rows.length)];

  // Leaving the shortcuts sandbox puts the window back on the inbox.
  useEffect(() => {
    if (mode !== "shortcuts") {
      setView("list");
      setPalette(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!beat) return;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    const toList = () => {
      setView("list");
      setSummary(false);
      setDraft(null);
      setAsk(false);
    };
    const key = keys[sel];
    setPalette(false);
    switch (beat.kind) {
      case "down":
        toList();
        setSel((s) => Math.min(VISIBLE - 1, s + 1));
        break;
      case "up":
        toList();
        setSel((s) => Math.max(0, s - 1));
        break;
      case "back":
        toList();
        break;
      case "reset":
      case "resetThread":
        // A fresh sandbox: the starting inbox, cursor on the first row -
        // or (AI lesson) that first conversation already open.
        toList();
        setKeys(Array.from({ length: VISIBLE }, (_, i) => i));
        setSel(0);
        setStarred(new Set());
        if (beat.kind === "resetThread") setView("thread");
        break;
      case "star":
        setStarred((s) => {
          const next = new Set(s);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        break;
      case "done":
      case "snooze":
        // The row leaves; the list closes up and backfills from the bottom.
        toList();
        setKeys((k) => [...k.filter((x) => x !== key), nextKey.current++]);
        setToast({
          n: beat.n,
          message: t(beat.kind === "done" ? "onboarding:preview.doneToast" : "onboarding:preview.snoozeToast"),
        });
        later(() => setToast(null), 1800);
        break;
      case "reply":
        setView("thread");
        setDraft("typed");
        break;
      case "summarize":
        setView("thread");
        setSummary(true);
        break;
      case "aiWrite":
        setView("thread");
        setDraft("ai");
        break;
      case "proofread":
        setView("thread");
        setDraft("proofread");
        break;
      case "search":
        setView("search");
        setAsk(false);
        break;
      case "ask":
        setView("search");
        setAsk(true);
        break;
      case "palette":
        setPalette(true);
        later(() => setPalette(false), 2600);
        break;
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
    // Only a new beat replays; the row bookkeeping must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat?.n, beat?.kind]);

  const empty = mode === "connect" || mode === "waiting";
  const syncing = mode === "waiting" || (mode === "sync" && syncFill < 1);
  const shown = mode === "sync" ? Math.max(0, Math.round(syncFill * VISIBLE)) : VISIBLE;
  const visible = keys
    .slice(0, shown)
    .map((key) => ({ key, row: rowAt(key) }))
    .filter((r) => r.row);
  const groups = (["today", "earlier"] as const).map((g) => ({ g, items: visible.filter((r) => r.row.group === g) }));
  const current = rowAt(keys[sel]);

  return (
    <div className="co-preview" aria-hidden>
      {/* TopBar */}
      <div className="co-glass relative z-10 flex h-10 shrink-0 items-center gap-3 px-4">
        <Icon name="menu" size={16} className="-ml-1 text-ink-muted" />
        <span className="text-sm font-semibold tracking-[0.14em] text-ink-faint uppercase">Comail</span>
        <span className="text-base font-medium text-ink-muted">
          {view === "search" ? t("onboarding:preview.searchTitle") : t("onboarding:preview.title")}
        </span>
        <div className="grow" />
        <AnimatePresence>
          {syncing && (
            <motion.span
              className="flex items-center gap-1.5 text-xs text-ink-muted"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
              {t("onboarding:preview.checkingMail")}
            </motion.span>
          )}
        </AnimatePresence>
        {(["edit", "calendar", "settings"] as IconName[]).map((icon) => (
          <span key={icon} className="grid size-7 place-items-center text-ink-muted">
            <Icon name={icon} size={16} />
          </span>
        ))}
        <span className="flex items-center gap-1.5 rounded-full border border-hairline bg-bg1 py-1 pr-2 pl-2.5 text-sm font-medium text-ink">
          {t("onboarding:preview.allAccounts")}
          <Icon name="chevronDown" size={11} className="text-ink-faint" />
        </span>

        {/* The account menu (TopBar's Popover), open on the new account. */}
        <AnimatePresence>
          {mode === "connected" && account && (
            <motion.div
              className="absolute top-[46px] right-4 z-30 w-64 rounded-card border border-hairline bg-bg1 p-1 shadow-elev-2"
              initial={{ opacity: 0, scale: 0.97, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: EASE, delay: 0.25 }}
            >
              <div className="flex w-full items-center gap-2.5 rounded-control bg-bg2 px-2.5 py-1.5 text-base">
                <span className="flex-1 truncate font-medium text-ink">{t("onboarding:preview.allAccounts")}</span>
                <kbd className="co-kbd">⌃0</kbd>
              </div>
              <motion.div
                className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-base"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.45, duration: 0.2 }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ink">{account.label}</span>
                  {account.detail && <span className="truncate text-xs text-ink-faint">{account.detail}</span>}
                </span>
                <kbd className="co-kbd">⌃1</kbd>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <AnimatePresence mode="wait" initial={false}>
          {view === "thread" && current ? (
            <Screen key="thread" className="bg-bg1">
              <Conversation row={current} summary={summary} draft={draft} />
            </Screen>
          ) : view === "search" ? (
            <Screen key="search" className="bg-bg1">
              <SearchView ask={ask} />
            </Screen>
          ) : (
            <Screen key="list" className="bg-bg0">
              {/* SplitTabs */}
              <div className="flex shrink-0 items-center gap-1 bg-bg1 px-5">
                {tabs.map((tab, i) => (
                  <span
                    key={tab.name}
                    className={`relative flex items-center gap-1.5 px-3 pt-3 pb-2.5 text-md whitespace-nowrap ${
                      i === 0
                        ? "text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
                        : "text-ink-faint"
                    }`}
                  >
                    {tab.name}
                    {!empty && tab.count > 0 && <span className="text-sm text-ink-faint tabular-nums">{tab.count}</span>}
                  </span>
                ))}
              </div>
              {/* ThreadList */}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {empty ? (
                  <SkeletonList />
                ) : (
                  groups.map(({ g, items }) =>
                    items.length === 0 ? null : (
                      <div key={g}>
                        <motion.div layout="position" className="pt-4 pb-1.5 pl-14 text-sm text-ink-faint">
                          {t(`onboarding:preview.${g}`)}
                        </motion.div>
                        <AnimatePresence initial={false} mode="popLayout">
                          {items.map(({ key, row }) => (
                            <motion.div
                              key={key}
                              layout
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, x: 28, transition: { duration: 0.15, ease: "easeIn" } }}
                              transition={{ duration: 0.3, ease: EASE }}
                              className="co-row flex h-10 items-center gap-3 pr-6 pl-6"
                              data-selected={key === keys[sel]}
                            >
                              <ThreadRowFace row={row} starred={starred.has(key) !== !!row.starred} />
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    ),
                  )
                )}
              </div>
            </Screen>
          )}
        </AnimatePresence>

        {/* Toasts */}
        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.n}
              className="absolute inset-x-0 bottom-5 z-10 flex justify-center"
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
            >
              <div className="flex items-center gap-2.5 rounded-card border border-hairline bg-bg1 py-2 pr-1.5 pl-3 text-base text-ink shadow-elev-2">
                <Icon name="check" size={14} className="text-ink-faint" />
                {toast.message}
                <span className="px-2 font-semibold text-accent">{t("onboarding:preview.undo")}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* CommandPalette */}
      <AnimatePresence>
        {palette && (
          <motion.div
            className="co-preview-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.14 } }}
            transition={{ duration: 0.12 }}
          >
            <motion.div
              className="w-[560px] overflow-hidden rounded-sheet border border-hairline bg-bg1 shadow-elev-2"
              initial={{ opacity: 0, scale: 0.97, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
            >
              <div className="co-hairline-b px-5 py-4 text-lg text-ink">
                <Typed text="mark" speed={70} caret />
              </div>
              <PaletteList />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One screen of the window body, cross-faded on navigation. */
function Screen({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <motion.div
      className={`absolute inset-0 flex flex-col overflow-hidden ${className}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
    >
      {children}
    </motion.div>
  );
}

/** ConversationScreen: header, the AI summary (⌘J), the message, and the
 *  reply composer when a draft is open. */
function Conversation({ row, summary, draft }: { row: Row; summary: boolean; draft: Draft }) {
  const { t } = useTranslation();
  const points = arr<string>(t("onboarding:preview.summary.points", { returnObjects: true }));
  const fixes = arr<[string, boolean]>(t("onboarding:preview.proofread.parts", { returnObjects: true }));
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-faint">
            ← {t("onboarding:preview.thread.back")}
            <kbd className="co-kbd !text-[10px]">Esc</kbd>
          </div>
          <h1 className="text-[23px] leading-tight font-semibold tracking-tight text-ink">{row.subject}</h1>
          <p className="mt-1 text-[12px] text-ink-faint">
            {t("onboarding:preview.thread.meta", { from: row.from, time: row.time })}
          </p>
        </div>
        <span className="mt-1 shrink-0 text-[11.5px] text-ink-faint tabular-nums">
          {t("onboarding:preview.thread.position")}
        </span>
      </header>

      <AnimatePresence initial={false}>
        {summary && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <AiSurface as="section" className="overflow-hidden">
              <div className="flex items-center gap-2 py-2 pr-1.5 pl-3.5">
                <AiBadge label={t("onboarding:preview.summary.title")} className="text-sm" />
              </div>
              <div className="flex flex-col gap-3 px-3.5 pt-1 pb-3.5">
                <ul className="flex flex-col gap-1.5">
                  {points.map((p, i) => (
                    <motion.li
                      key={p}
                      className="flex gap-2 text-base leading-snug text-ink"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 + i * 0.22 }}
                    >
                      <span className="mt-[0.5em] size-1 shrink-0 rounded-full bg-ink-faint" />
                      <span>{p}</span>
                    </motion.li>
                  ))}
                </ul>
                <motion.p
                  className="co-ai-fill rounded-control px-3 py-2 text-sm leading-snug text-ink"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.15 + points.length * 0.22 }}
                >
                  {t("onboarding:preview.summary.next")}
                </motion.p>
              </div>
            </AiSurface>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rounded-card border border-hairline bg-bg0 px-5 py-4 shadow-card">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold text-ink">{row.from}</span>
          <span className="text-sm text-ink-faint">{t("onboarding:preview.thread.to")}</span>
          <span className="ml-auto text-xs text-ink-faint">{row.time}</span>
        </div>
        <p className="mt-3 text-base leading-relaxed text-ink">{row.snippet}.</p>
      </div>

      <AnimatePresence initial={false}>
        {draft && (
          <motion.div
            className="rounded-card border border-hairline bg-bg0 px-5 py-4 shadow-card"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <div className="flex items-baseline gap-1.5 text-md">
              <span className="font-semibold text-ok">{t("onboarding:preview.thread.draft")}</span>
              <span className="text-ink-muted">{t("onboarding:preview.thread.draftTo", { from: row.from })}</span>
              {draft === "ai" && <AiBadge label={t("onboarding:preview.aiWritten")} className="ml-auto text-xs" />}
              {draft === "proofread" && (
                <AiBadge label={t("onboarding:preview.proofread.badge")} className="ml-auto text-xs" />
              )}
            </div>
            <div className="co-hairline-b mt-2 flex items-center gap-3 pb-2 text-sm">
              <span className="w-8 text-ink-faint">{t("onboarding:preview.thread.toLabel")}</span>
              <span className="rounded-full border border-hairline px-2.5 py-0.5 text-ink">{row.from}</span>
            </div>
            <div className="mt-2.5 flex items-center gap-3.5 text-xs font-semibold text-ink-faint">
              <span>B</span>
              <span className="italic">I</span>
              <span className="underline">U</span>
              <span className="line-through">S</span>
            </div>
            <p className="mt-3 min-h-12 text-base text-ink">
              {draft === "typed" ? (
                <Typed key="typed" text={t("onboarding:preview.replyText")} speed={30} />
              ) : draft === "ai" ? (
                <Typed key="ai" text={t("onboarding:preview.aiText")} speed={14} />
              ) : (
                fixes.map(([text, fixed], i) =>
                  fixed ? (
                    <motion.span
                      key={i}
                      className="co-ai-fill rounded-[3px] px-0.5"
                      initial={{ opacity: 0.3 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4, delay: 0.1 + i * 0.1 }}
                    >
                      {text}
                    </motion.span>
                  ) : (
                    <span key={i}>{text}</span>
                  ),
                )
              )}
            </p>
            <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3">
              <span className="inline-flex h-8 items-center rounded-control bg-accent px-3.5 text-sm font-semibold text-on-accent">
                {t("onboarding:preview.thread.send")}
              </span>
              <span className="co-kbd">⌘</span>
              <span className="co-kbd">↵</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** SearchScreen: the query band (field, Search / Ask AI, Esc), then either
 *  keyword results or the AI answer. */
function SearchView({ ask }: { ask: boolean }) {
  const { t } = useTranslation();
  const results = arr<Row>(t("onboarding:preview.search.results", { returnObjects: true }));
  return (
    <>
      <div className="co-hairline-b shrink-0 px-6 pt-4 pb-3">
        <div className="mx-auto max-w-[860px]">
          <div className="flex items-center gap-3">
            <Icon name="search" size={14} className="text-ink-faint" />
            <div className="flex h-10 min-w-0 flex-1 items-center rounded-control border border-accent bg-bg0 px-2 text-lg text-ink">
              <Typed
                key={ask ? "ask" : "search"}
                text={ask ? t("onboarding:preview.search.askQuery") : t("onboarding:preview.search.query")}
                speed={ask ? 34 : 70}
                caret
              />
            </div>
            {!ask && <span className="co-chip shrink-0 !py-0.5 !text-xs text-ink-muted tabular-nums">{results.length}</span>}
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-hairline text-xs font-medium text-ink-faint">
              ?
            </span>
            <div className="flex shrink-0 rounded-control border border-hairline bg-bg0 p-0.5">
              <span className={`inline-flex items-center rounded-md px-3 py-1 text-sm ${ask ? "text-ink-faint" : "bg-bg2 font-medium text-ink"}`}>
                {t("onboarding:preview.search.modeSearch")}
              </span>
              <span className={`inline-flex items-center rounded-md px-3 py-1 text-sm ${ask ? "bg-bg2" : ""}`}>
                <AiBadge label={t("onboarding:preview.search.modeAsk")} className="text-sm" />
              </span>
            </div>
            <kbd className="co-kbd shrink-0">Esc</kbd>
          </div>
          {!ask && (
            <>
              <div className="mt-2.5 flex items-center gap-1.5">
                <span className="co-chip !py-0.5 !text-xs">
                  {t("onboarding:preview.search.chip")}
                  <Icon name="close" size={9} className="text-ink-faint" />
                </span>
              </div>
              <p className="mt-2 text-xs text-ink-faint">{t("onboarding:preview.search.hint")}</p>
            </>
          )}
        </div>
      </div>
      {ask ? (
        <div className="mx-auto w-full max-w-[860px] px-6 py-5">
          <AiSurface className="px-4 py-3.5">
            <AiBadge label={t("onboarding:preview.search.modeAsk")} className="text-sm" />
            <p className="mt-2 text-base leading-relaxed text-ink">
              <Typed text={t("onboarding:preview.search.askAnswer")} speed={18} />
            </p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-ink-faint">
              {t("onboarding:preview.search.sources")}
              <span className="co-chip !py-0.5 !text-xs">Q3 roadmap review - final deck</span>
            </div>
          </AiSurface>
        </div>
      ) : (
        <div className="bg-bg0 pt-1">
          {results.map((row, i) => (
            <motion.div
              key={row.subject}
              className="co-row flex h-10 items-center gap-3 pr-6 pl-6"
              data-selected={i === 0}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 + i * 0.06, duration: 0.2 }}
            >
              <ThreadRowFace row={row} starred={!!row.starred} />
            </motion.div>
          ))}
        </div>
      )}
    </>
  );
}

/** ThreadRow's layout: unread dot / star, sender + count, label chips,
 *  subject + snippet, time. */
function ThreadRowFace({ row, starred }: { row: Row; starred: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="flex w-5 shrink-0 items-center justify-center self-stretch">
        {starred ? (
          <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 18 }}>
            <Icon name="star" size={13} filled className="text-star" />
          </motion.span>
        ) : row.unread ? (
          <span className="size-2 rounded-full bg-info" />
        ) : null}
      </span>
      <span className="w-48 shrink-0 truncate text-base font-medium text-ink">
        {row.from}
        {row.count != null && <span className="ml-1.5 text-xs font-normal text-ink-faint">{row.count}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-base">
        {row.labels?.map((l) => (
          <span
            key={l}
            className="shrink-0 rounded-[4px] px-1.5 text-2xs leading-[17px] font-medium"
            style={{ background: `${LABEL_COLOR[l]}24`, color: LABEL_COLOR[l] }}
          >
            {t(`onboarding:preview.labels.${l}`)}
          </span>
        ))}
        <span className="min-w-0 truncate">
          <span className="text-ink">{row.subject}</span>
          <span className="text-ink-faint">&ensp;{row.snippet}</span>
        </span>
      </span>
      <span className="w-12 shrink-0 text-right text-sm text-ink-faint tabular-nums">{row.time}</span>
    </>
  );
}

/** The list before any mail exists: row geometry, shimmering. */
function SkeletonList() {
  const widths = [62, 48, 70, 55, 66, 44, 58, 50];
  return (
    <div className="pt-[42px]">
      {widths.map((w, i) => (
        <div key={i} className="flex h-10 items-center gap-3 pr-6 pl-6">
          <span className="w-5" />
          <span className="co-skeleton h-2.5 w-36 rounded-full" />
          <span className="co-skeleton h-2.5 rounded-full" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

function PaletteList() {
  const { t } = useTranslation();
  const items = arr<PaletteItem>(t("onboarding:preview.paletteItems", { returnObjects: true }));
  return (
    <div className="p-1.5">
      {items.map((item, i) => (
        <div
          key={item.title}
          className={`flex w-full items-center justify-between gap-4 rounded-control px-3.5 py-2 ${
            i === 0 ? "bg-[var(--selected-bg)]" : ""
          }`}
        >
          <span className="flex items-baseline gap-2.5 truncate">
            <span className="text-base text-ink">{item.title}</span>
            <span className="text-xs text-ink-faint">{item.section}</span>
          </span>
          <span className="flex shrink-0 gap-1">
            {item.key.split(" ").map((k) => (
              <kbd key={k} className="co-kbd">
                {k}
              </kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Types `text` out one character at a time. */
function Typed({ text, speed = 32, caret = false }: { text: string; speed?: number; caret?: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const id = window.setInterval(() => setN((v) => (v >= text.length ? v : v + 1)), speed);
    return () => window.clearInterval(id);
  }, [text, speed]);
  return (
    <>
      {text.slice(0, n)}
      {(caret || n < text.length) && <span className="co-preview-caret" />}
    </>
  );
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
