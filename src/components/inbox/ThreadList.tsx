import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { Label, ThreadSummary } from "../../ipc/types";
import { buildCommandContext } from "../../keyboard/context";
import { dateGroup, primaryCorrespondent } from "../../lib/format";
import { prefetchThread } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { ContactPane } from "./ContactPane";
import { ThreadRow } from "./ThreadRow";

const ROW_HEIGHT = 42;

/** One virtualized row: a date header or a thread. Headers occupy a full
 *  ROW_HEIGHT so the list stays uniform-height (keeps the cursor + gutter-sweep
 *  math simple). */
type ListItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "thread"; thread: ThreadSummary };

/** Interleave date-group headers into the thread rows. When grouping is off the
 *  result is just the threads, one item each — identical to the old behavior. */
function buildListItems(threads: ThreadSummary[], grouped: boolean): ListItem[] {
  if (!grouped) return threads.map((thread) => ({ kind: "thread", thread }));
  const items: ListItem[] = [];
  let lastKey: string | null = null;
  for (const thread of threads) {
    const g = dateGroup(thread.lastMessageAt);
    if (g.key !== lastKey) {
      items.push({ kind: "header", key: g.key, label: g.label });
      lastKey = g.key;
    }
    items.push({ kind: "thread", thread });
  }
  return items;
}

type ThreadListProps = {
  /** Flattened thread summaries in display order. */
  threads: ThreadSummary[];
  selfEmails: Set<string>;
  labelMap: Map<number, Label>;
  /** Infinite scroll: called when the viewport nears the end of the list. */
  onEndReached?: () => void;
  isFetchingMore?: boolean;
  /** Insert Today / Yesterday / … date headers. Only for date-sorted lists
   *  (the inbox); off for relevance-ranked search results. */
  groupByDate?: boolean;
  /** Reveal ⌘/Ctrl+1..9 jump numbers on the first nine rows (search screen). */
  jumpHints?: boolean;
};

/**
 * The homescreen thread list: virtualized full-width rows, contact pane,
 * bulk bar, gutter range-sweep, leave animation. Shared by the inbox and
 * search screens so their layouts cannot drift apart.
 */
export function ThreadList({
  threads,
  selfEmails,
  labelMap,
  onEndReached,
  isFetchingMore,
  groupByDate = false,
  jumpHints = false,
}: ThreadListProps) {
  const { t } = useTranslation();
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectedIndex = useUi((s) => s.selectedIndex);
  const selection = useUi((s) => s.selection);
  const ui = useUi((s) => s.set);
  const selectThread = useUi((s) => s.selectThread);
  const openThread = useUi((s) => s.openThread);
  const toggleSelect = useUi((s) => s.toggleSelect);

  // Brief leave animation: keep removed rows for 150ms, action already committed.
  const [rows, setRows] = useState<ThreadSummary[]>(threads);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<number>>(new Set());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Virtualized items: threads plus interleaved date headers. `rows` stays the
  // thread-only array (selection, keyboard cursor, leave animation all index by
  // thread), while `items` is what the virtualizer lays out.
  const items = useMemo(() => buildListItems(rows, groupByDate), [rows, groupByDate]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // While ⌘/Ctrl is held on the search screen, map the first nine threads to
  // their jump-to number so each row can show its ⌘/Ctrl+1..9 badge.
  const jumpNumbers = useMemo(() => {
    if (!jumpHints) return null;
    const m = new Map<number, string>();
    rows.slice(0, 9).forEach((r, i) => m.set(r.id, String(i + 1)));
    return m;
  }, [jumpHints, rows]);

  // Contact pane: the highlighted thread and this correspondent's recent
  // conversations. Derive from `rows` (not `threads`) so the pane stays valid
  // during the 155ms leave animation.
  const selectedThread = useMemo(
    () => rows.find((r) => r.id === selectedThreadId) ?? null,
    [rows, selectedThreadId],
  );
  const recentWithContact = useMemo(() => {
    if (!selectedThread) return [];
    const primary = primaryCorrespondent(selectedThread.participants, selfEmails);
    if (!primary) return [];
    const email = primary.email.toLowerCase();
    return threads
      .filter(
        (t) =>
          t.id !== selectedThread.id &&
          t.participants.some((p) => p.email.toLowerCase() === email),
      )
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, 5);
  }, [threads, selectedThread, selfEmails]);

  // Active gutter-drag state (null when not dragging).
  const dragRef = useRef<{ startId: number; base: number[]; moved: boolean } | null>(null);

  // Stable per-row handlers so memoized ThreadRows don't re-render on hover.
  const handleToggleCheck = useCallback((id: number) => toggleSelect(id), [toggleSelect]);

  // Hover intent: after the pointer rests on a row for 80ms, warm the thread
  // cache so a click paints from cache instead of paying the IPC round-trip.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRowHover = useCallback((id: number | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = id == null ? null : setTimeout(() => prefetchThread(id), 80);
  }, []);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  // Keyboard cursor: prefetch the highlighted thread so Enter opens instantly.
  useEffect(() => {
    if (selectedThreadId != null) prefetchThread(selectedThreadId);
  }, [selectedThreadId]);

  // Row click: Shift = range, Cmd/Ctrl = toggle one, plain = open.
  const handleRowClick = useCallback(
    (id: number, e: ReactMouseEvent) => {
      if (e.shiftKey) {
        useUi.getState().selectRange(id, true);
      } else if (e.metaKey || e.ctrlKey) {
        useUi.getState().toggleSelect(id);
      } else {
        openThread(id);
      }
    },
    [openThread],
  );

  // Right-click a row: open the context menu at the pointer. If the row is part
  // of an active multi-selection the menu acts on the whole selection; otherwise
  // it targets (and highlights) just that row.
  const handleRowContextMenu = useCallback(
    (id: number, e: ReactMouseEvent) => {
      e.preventDefault();
      const state = useUi.getState();
      const th = rowsRef.current.find((r) => r.id === id);
      const inSelection = state.selection.length > 0 && state.selection.includes(id);
      if (!inSelection) {
        const idx = rowsRef.current.findIndex((r) => r.id === id);
        state.set({ selection: [], selectedThreadId: id, selectedIndex: idx < 0 ? 0 : idx });
      }
      state.set({
        contextMenu: {
          x: e.clientX,
          y: e.clientY,
          targets: inSelection ? state.selection : [id],
          unread: (th?.unreadCount ?? 0) > 0,
          starred: th?.isStarred ?? false,
        },
      });
    },
    [],
  );

  // Press-and-drag in the checkbox gutter sweeps a contiguous range.
  // Virtualization unmounts off-screen rows, so the hovered index is derived
  // from pointer Y against the scroll container rather than per-row events.
  const onGutterDown = useCallback((id: number, _e: ReactMouseEvent) => {
    const el = scrollRef.current;
    dragRef.current = { startId: id, base: useUi.getState().selection, moved: false };
    useUi.getState().set({ selectAnchorId: id });
    el?.classList.add("select-none");

    // Uniform ROW_HEIGHT (headers included), so pointer Y maps straight to an
    // item index; range selection then filters that slice down to thread ids.
    const itemIndexFromY = (clientY: number): number => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const y = clientY - r.top + el.scrollTop;
      return Math.max(0, Math.min(Math.floor(y / ROW_HEIGHT), itemsRef.current.length - 1));
    };

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const list = itemsRef.current;
      const startIdx = list.findIndex((it) => it.kind === "thread" && it.thread.id === drag.startId);
      if (startIdx < 0) return;
      const cur = itemIndexFromY(ev.clientY);
      if (cur !== startIdx) drag.moved = true;
      const ids = list
        .slice(Math.min(startIdx, cur), Math.max(startIdx, cur) + 1)
        .flatMap((it) => (it.kind === "thread" ? [it.thread.id] : []));
      useUi.getState().setSelection([...drag.base, ...ids]);
    };

    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      el?.classList.remove("select-none");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // A press with no movement is a plain checkbox click: toggle one row.
      if (drag && !drag.moved) useUi.getState().toggleSelect(drag.startId);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const prev = rowsRef.current;
    const nextIds = new Set(threads.map((t) => t.id));
    const removed = prev.filter((t) => !nextIds.has(t.id));
    if (removed.length > 0 && removed.length <= 6 && prev.length > 0) {
      setLeavingIds(new Set(removed.map((r) => r.id)));
      const timer = setTimeout(() => {
        setLeavingIds(new Set());
        setRows(threads);
      }, 155);
      return () => clearTimeout(timer);
    }
    setLeavingIds(new Set());
    setRows(threads);
  }, [threads]);

  // Keep a valid cursor.
  useEffect(() => {
    if (threads.length === 0) return;
    if (selectedThreadId == null || !threads.some((t) => t.id === selectedThreadId)) {
      const idx = Math.min(selectedIndex, threads.length - 1);
      selectThread(idx, threads[idx]?.id ?? null);
    } else {
      const idx = threads.findIndex((t) => t.id === selectedThreadId);
      if (idx >= 0 && idx !== selectedIndex) selectThread(idx, selectedThreadId);
    }
  }, [threads, selectedThreadId, selectedIndex, selectThread]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Keep the keyboard cursor on screen. Only scrolls when the selected row is
  // actually out of view, so hovering a visible row never triggers a scroll.
  useEffect(() => {
    if (selectedThreadId == null) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = itemsRef.current.findIndex(
      (it) => it.kind === "thread" && it.thread.id === selectedThreadId,
    );
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedThreadId, virtualizer]);

  // Infinite scroll.
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (onEndReached && lastIndex >= items.length - 12) {
      onEndReached();
    }
  }, [onEndReached, lastIndex, items.length]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ background: "color-mix(in srgb, var(--bg0) 85%, transparent)" }}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const style = { top: vi.start, height: vi.size } as const;
            if (item.kind === "header") {
              return (
                <div key={`h-${item.key}`} className="absolute inset-x-0" style={style}>
                  <DateHeader label={item.label} />
                </div>
              );
            }
            const th = item.thread;
            return (
              <div key={th.id} className="absolute inset-x-0" style={style}>
                <ThreadRow
                  thread={th}
                  selected={th.id === selectedThreadId && selection.length === 0}
                  checked={selection.includes(th.id)}
                  selectionMode={selection.length > 0}
                  selfEmails={selfEmails}
                  labelMap={labelMap}
                  leaving={leavingIds.has(th.id)}
                  onRowClick={handleRowClick}
                  onRowContextMenu={handleRowContextMenu}
                  onRowHover={handleRowHover}
                  onToggleCheck={handleToggleCheck}
                  onGutterDown={onGutterDown}
                  jumpHint={jumpNumbers?.get(th.id)}
                />
              </div>
            );
          })}
        </div>
        {isFetchingMore && (
          <div className="py-3 text-center text-[12px] text-ink-faint">{t("common:loading")}</div>
        )}
      </div>

      <ContactPane
        thread={selectedThread}
        recent={recentWithContact}
        selfEmails={selfEmails}
        onOpen={openThread}
        className="hidden w-[340px] shrink-0 border-l border-hairline lg:flex"
      />

      {selection.length > 0 && <BulkBar count={selection.length} onClear={() => ui({ selection: [] })} />}
    </div>
  );
}

/** Sticky-looking date separator between thread rows (Today / Yesterday / …). */
function DateHeader({ label }: { label: string }) {
  return (
    <div className="flex h-full items-end px-4 pb-1.5">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
        {label}
      </span>
    </div>
  );
}

function BulkBar({ count, onClear }: { count: number; onClear: () => void }) {
  const { t } = useTranslation();
  const run = (fn: (ctx: ReturnType<typeof buildCommandContext>) => void) => () => {
    fn(buildCommandContext());
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center lg:pr-[340px]">
      <div
        className="co-pop-in pointer-events-auto flex items-center gap-1 rounded-xl border border-hairline bg-bg1 px-2 py-1.5"
        style={{ boxShadow: "var(--elev-2)" }}
      >
        <span className="px-2 text-[12.5px] font-semibold text-ink">{t("common:selectedCount", { count })}</span>
        <BulkButton label={t("common:action.done")} kbd="E" onClick={run((c) => c.act("archive"))} />
        <BulkButton label={t("common:action.snooze")} kbd="H" onClick={run((c) => c.openSnooze())} />
        <BulkButton label={t("common:action.star")} kbd="S" onClick={run((c) => c.toggleStar())} />
        <BulkButton label={t("common:action.read")} kbd="U" onClick={run((c) => c.toggleRead())} />
        <BulkButton label={t("common:action.trash")} kbd="#" onClick={run((c) => c.act("trash"))} />
        <BulkButton label={t("common:action.spam")} kbd="!" onClick={run((c) => c.act("spam"))} />
        <button
          className="ml-1 rounded-md px-2 py-1 text-[12.5px] text-ink-faint hover:bg-bg2"
          onClick={onClear}
        >
          {t("common:action.clear")}
        </button>
      </div>
    </div>
  );
}

function BulkButton({ label, kbd, onClick }: { label: string; kbd: string; onClick: () => void }) {
  return (
    <button
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] text-ink hover:bg-bg2"
      onClick={onClick}
    >
      {label}
      <kbd className="co-kbd !h-[1.35em] !text-[10px]">{kbd}</kbd>
    </button>
  );
}
