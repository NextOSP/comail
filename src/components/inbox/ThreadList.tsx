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
import { primaryCorrespondent } from "../../lib/format";
import { buildListItems, type Bundle, type SectionHeader } from "../../lib/listItems";
import { prefetchThread } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Button } from "../ui/Button";
import { BundleRow } from "./BundleRow";
import { ContactPane } from "./ContactPane";
import { ThreadRow, type AccountMeta, type QuickAction } from "./ThreadRow";

// Superhuman-like density: one line per thread, ~36px, so a large screen
// shows a full page of mail instead of a handful of tall rows.
const ROW_HEIGHT = 40;
const AVATAR_ROW_HEIGHT = 42;

type ThreadListProps = {
  /** Flattened thread summaries in display order. */
  threads: ThreadSummary[];
  selfEmails: Set<string>;
  labelMap: Map<number, Label>;
  /** Per-account color + short name, keyed by account id. Provided only when
   *  rows should carry an account marker (unified inbox, several accounts). */
  accountMeta?: Map<number, AccountMeta>;
  /** Infinite scroll: called when the viewport nears the end of the list. */
  onEndReached?: () => void;
  isFetchingMore?: boolean;
  /** Insert Today / Yesterday / … date headers. Only for date-sorted lists
   *  (the inbox); off for relevance-ranked search results. */
  groupByDate?: boolean;
  /** Reveal ⌘/Ctrl+1..9 jump numbers on the first nine rows (search screen). */
  jumpHints?: boolean;
  /** Avatar: tall rows with avatars, no contact pane. */
  layout?: "classic" | "avatar";
  /** Avatar UI only: load Gravatar photos into avatars. */
  photos?: boolean;
  /** Avatar inbox: other tabs collapsed into rows inside the list. */
  bundles?: Bundle[];
  onOpenBundle?: (bundle: Bundle) => void;
  /** Ungrouped lists only: a header row above each keyed thread (search
   *  results' "Partial matches" / "Related" sections). */
  sections?: ReadonlyMap<number, SectionHeader>;
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
  accountMeta,
  onEndReached,
  isFetchingMore,
  groupByDate = false,
  jumpHints = false,
  layout = "classic",
  photos = false,
  bundles,
  onOpenBundle,
  sections,
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
  // Arrive animation: new mail that lands near the top of the list we're on.
  const [arrivingIds, setArrivingIds] = useState<ReadonlySet<number>>(new Set());
  /** True for the 300ms the rows below glide down to make room. */
  const [shifting, setShifting] = useState(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Virtualized items: threads plus interleaved date headers. `rows` stays the
  // thread-only array (selection, keyboard cursor, leave animation all index by
  // thread), while `items` is what the virtualizer lays out.
  const items = useMemo(
    () => buildListItems(rows, groupByDate, bundles, Date.now(), sections),
    [rows, groupByDate, bundles, sections],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const avatarUi = layout === "avatar";
  const rowHeight = avatarUi ? AVATAR_ROW_HEIGHT : ROW_HEIGHT;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

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

  // Hover quick actions (Done / Remind / Star): act on exactly that row, moving
  // the cursor onto it first so auto-advance continues from where the user is.
  const handleQuickAction = useCallback((id: number, action: QuickAction) => {
    const state = useUi.getState();
    if (state.selectedThreadId !== id) {
      const idx = rowsRef.current.findIndex((r) => r.id === id);
      state.set({ selectedThreadId: id, selectedIndex: idx < 0 ? 0 : idx });
    }
    const ctx = buildCommandContext([id]);
    if (action === "done") ctx.act("archive");
    else if (action === "remind") ctx.openSnooze();
    else ctx.toggleStar();
  }, []);

  // Press-and-drag sweeps a contiguous range. The gutter and the row body both
  // start one; they differ only in what a no-move press means (see the two
  // callers below). Virtualization unmounts off-screen rows, so the hovered
  // index is derived from pointer Y against the scroll container rather than
  // per-row events.
  const beginSweep = useCallback((id: number, toggleOnTap: boolean) => {
    const el = scrollRef.current;
    dragRef.current = { startId: id, base: useUi.getState().selection, moved: false };
    useUi.getState().set({ selectAnchorId: id });
    el?.classList.add("select-none");

    // Uniform row height (headers and bundles included), so pointer Y maps straight to an
    // item index; range selection then filters that slice down to thread ids.
    const itemIndexFromY = (clientY: number): number => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const y = clientY - r.top + el.scrollTop;
      return Math.max(0, Math.min(Math.floor(y / rowHeightRef.current), itemsRef.current.length - 1));
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
      if (drag?.moved) {
        // A real sweep happened: swallow the trailing click so releasing back on
        // the start row doesn't also open it. Self-removes if no click follows.
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      } else if (toggleOnTap && drag) {
        // A press with no movement in the gutter is a plain checkbox click.
        useUi.getState().toggleSelect(drag.startId);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Gutter press: sweep, or toggle this one row on a no-move tap.
  const onGutterDown = useCallback((id: number) => beginSweep(id, true), [beginSweep]);

  // Row-body press: drag over subjects/names to sweep a range. Modifier presses
  // fall through to the click handler (Shift range / Cmd toggle), and a no-move
  // press stays a plain click that opens the thread.
  const onRowDown = useCallback(
    (id: number, e: ReactMouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
      beginSweep(id, false);
    },
    [beginSweep],
  );

  useEffect(() => {
    const prev = rowsRef.current;
    const prevIds = new Set(prev.map((t) => t.id));
    const nextIds = new Set(threads.map((t) => t.id));
    const removed = prev.filter((t) => !nextIds.has(t.id));
    const gained = threads.some((t) => !prevIds.has(t.id));
    // Play the brief leave animation for a pure removal - a triage action (on
    // one row or a whole multi-selection) that drops rows and adds none. Skip
    // it when the list also gains rows: that is a wholesale swap (view/tab
    // switch, refetch, new mail) that should replace in place rather than fly
    // every changed row out. The count cap is a backstop so a large filter
    // narrow can't animate dozens of rows at once.
    if (removed.length > 0 && !gained && removed.length <= 25 && prev.length > 0) {
      setLeavingIds(new Set(removed.map((r) => r.id)));
      const timer = setTimeout(() => {
        setLeavingIds(new Set());
        setRows(threads);
      }, 155);
      return () => clearTimeout(timer);
    }
    setLeavingIds(new Set());
    setRows(threads);
    // A handful of rows appearing near the top while the rest of the list
    // stays put is new mail arriving; anything bigger (tab/view switch, first
    // load, a page of infinite scroll) just swaps in place.
    const gainedIdx = threads.flatMap((t, i) => (prevIds.has(t.id) ? [] : [i]));
    if (
      prev.length > 0 &&
      gainedIdx.length > 0 &&
      gainedIdx.length <= 5 &&
      removed.length <= 5 &&
      gainedIdx.every((i) => i < 10)
    ) {
      setArrivingIds(new Set(gainedIdx.map((i) => threads[i].id)));
      setShifting(true);
      const shiftTimer = setTimeout(() => setShifting(false), 320);
      // Outlives the drop-in so the accent wash can finish fading.
      const arriveTimer = setTimeout(() => setArrivingIds(new Set()), 1300);
      return () => {
        clearTimeout(shiftTimer);
        clearTimeout(arriveTimer);
      };
    }
    setShifting(false);
    setArrivingIds(new Set());
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
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  // UI switch: drop cached sizes so every row re-lays out at the new height.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

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
    const top = idx * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedThreadId, virtualizer, rowHeight]);

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
        // Superhuman: the list is a plain white sheet; only the side pane is tinted.
        className="min-h-0 flex-1 overflow-y-auto bg-bg1"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const style = { top: vi.start, height: vi.size } as const;
            if (item.kind === "header") {
              return (
                <div key={`h-${item.key}`} className={`absolute inset-x-0${shifting ? " co-row-shift" : ""}`} style={style}>
                  <DateHeader label={item.label} subtitle={item.subtitle} avatarUi={avatarUi} />
                </div>
              );
            }
            if (item.kind === "bundle") {
              return (
                <div key={`b-${item.bundle.key}`} className={`absolute inset-x-0${shifting ? " co-row-shift" : ""}`} style={style}>
                  <BundleRow
                    bundle={item.bundle}
                    selfEmails={selfEmails}
                    photos={photos}
                    onOpen={onOpenBundle ?? noop}
                  />
                </div>
              );
            }
            const th = item.thread;
            return (
              <div key={th.id} className={`absolute inset-x-0${shifting ? " co-row-shift" : ""}`} style={style}>
                <ThreadRow
                  thread={th}
                  selected={th.id === selectedThreadId}
                  checked={selection.includes(th.id)}
                  selectionMode={selection.length > 0}
                  selfEmails={selfEmails}
                  labelMap={labelMap}
                  account={accountMeta?.get(th.accountId)}
                  leaving={leavingIds.has(th.id)}
                  arriving={arrivingIds.has(th.id)}
                  onRowClick={handleRowClick}
                  onRowContextMenu={handleRowContextMenu}
                  onQuickAction={handleQuickAction}
                  onRowHover={handleRowHover}
                  onToggleCheck={handleToggleCheck}
                  onGutterDown={onGutterDown}
                  onRowDown={onRowDown}
                  jumpHint={jumpNumbers?.get(th.id)}
                  avatarUi={avatarUi}
                  photos={photos}
                />
              </div>
            );
          })}
        </div>
        {isFetchingMore && (
          <div className="py-3 text-center text-sm text-ink-faint">{t("common:loading")}</div>
        )}
      </div>

      {!avatarUi && (
        <ContactPane
          thread={selectedThread}
          recent={recentWithContact}
          selfEmails={selfEmails}
          onOpen={openThread}
          className="hidden w-[340px] shrink-0 bg-bg0 lg:flex"
        />
      )}

      {selection.length > 0 && (
        <BulkBar count={selection.length} withPane={!avatarUi} onClear={() => ui({ selection: [] })} />
      )}
    </div>
  );
}

const noop = () => {};

/** Sticky-looking date separator between thread rows (Today / Yesterday / …). */
function DateHeader({
  label,
  subtitle,
  avatarUi,
}: {
  label: string;
  subtitle?: string;
  avatarUi: boolean;
}) {
  if (avatarUi) {
    return (
      <div className="flex h-full items-end gap-2 pb-1.5 pl-14">
        <span className="text-sm text-ink-faint">{label}</span>
        {subtitle && <span className="text-sm text-ink-faint/70">{subtitle}</span>}
      </div>
    );
  }
  // Superhuman: a quiet sentence-case label aligned with the sender column.
  return (
    <div className="flex h-full items-end pb-1.5 pl-14">
      <span className="text-sm text-ink-faint">{label}</span>
    </div>
  );
}

function BulkBar({
  count,
  withPane,
  onClear,
}: {
  count: number;
  /** Centre over the list only, leaving room for the contact pane. */
  withPane: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const run = (fn: (ctx: ReturnType<typeof buildCommandContext>) => void) => () => {
    fn(buildCommandContext());
  };
  return (
    <div className={`pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center ${withPane ? "lg:pr-[340px]" : ""}`}>
      <div
        className="co-pop-in pointer-events-auto flex items-center gap-1 rounded-card border border-hairline bg-bg1 px-2 py-1.5 shadow-elev-2"
      >
        <span className="px-2 text-sm font-semibold text-ink">{t("common:selectedCount", { count })}</span>
        <BulkButton label={t("common:action.done")} kbd="E" onClick={run((c) => c.act("archive"))} />
        <BulkButton label={t("common:action.snooze")} kbd="H" onClick={run((c) => c.openSnooze())} />
        <BulkButton label={t("common:action.star")} kbd="S" onClick={run((c) => c.toggleStar())} />
        <BulkButton label={t("common:action.read")} kbd="U" onClick={run((c) => c.toggleRead())} />
        <BulkButton label={t("common:action.trash")} kbd="#" onClick={run((c) => c.act("trash"))} />
        <BulkButton label={t("common:action.spam")} kbd="!" onClick={run((c) => c.act("spam"))} />
        <Button variant="ghost" size="sm" className="ml-1 px-2" onClick={onClear}>
          {t("common:action.clear")}
        </Button>
      </div>
    </div>
  );
}

function BulkButton({ label, kbd, onClick }: { label: string; kbd: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      {label}
      <kbd className="co-kbd !h-[1.35em] !text-2xs">{kbd}</kbd>
    </Button>
  );
}
