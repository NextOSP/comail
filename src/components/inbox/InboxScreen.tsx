import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../../ipc/types";
import { buildCommandContext } from "../../keyboard/context";
import { flattenThreads, useAccounts, useLabels, useThreads } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { InboxZero } from "./InboxZero";
import { SplitTabs } from "./SplitTabs";
import { ThreadRow } from "./ThreadRow";

const ROW_HEIGHT = 42;

export function InboxScreen() {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const accountFilter = useUi((s) => s.accountFilter);
  const labelFilter = useUi((s) => s.labelFilter);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectedIndex = useUi((s) => s.selectedIndex);
  const selection = useUi((s) => s.selection);
  const ui = useUi((s) => s.set);
  const selectThread = useUi((s) => s.selectThread);
  const openThread = useUi((s) => s.openThread);
  const toggleSelect = useUi((s) => s.toggleSelect);

  const { data: accounts } = useAccounts();
  const { data: labels } = useLabels();
  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const labelMap = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  const query = useThreads(view, view === "inbox" ? splitId : null, accountFilter, labelFilter);
  const threads = useMemo(() => flattenThreads(query.data), [query.data]);

  // Brief leave animation: keep removed rows for 150ms, action already committed.
  const [rows, setRows] = useState<ThreadSummary[]>(threads);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<number>>(new Set());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Active gutter-drag state (null when not dragging).
  const dragRef = useRef<{ startId: number; base: number[]; moved: boolean } | null>(null);

  // Stable per-row handlers so memoized ThreadRows don't re-render on hover.
  const handleToggleCheck = useCallback((id: number) => toggleSelect(id), [toggleSelect]);
  const handleHover = useCallback(
    (id: number) => {
      // Don't fight the sweep with hover-cursor moves while dragging.
      if (dragRef.current) return;
      if (id === useUi.getState().selectedThreadId) return;
      const idx = rowsRef.current.findIndex((t) => t.id === id);
      selectThread(idx >= 0 ? idx : 0, id);
    },
    [selectThread],
  );

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

  // Press-and-drag in the checkbox gutter sweeps a contiguous range.
  // Virtualization unmounts off-screen rows, so the hovered index is derived
  // from pointer Y against the scroll container rather than per-row events.
  const onGutterDown = useCallback((id: number, _e: ReactMouseEvent) => {
    const el = scrollRef.current;
    dragRef.current = { startId: id, base: useUi.getState().selection, moved: false };
    useUi.getState().set({ selectAnchorId: id });
    el?.classList.add("select-none");

    const indexFromY = (clientY: number): number => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const y = clientY - r.top + el.scrollTop;
      return Math.max(0, Math.min(Math.floor(y / ROW_HEIGHT), rowsRef.current.length - 1));
    };

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const list = rowsRef.current;
      const startIdx = list.findIndex((t) => t.id === drag.startId);
      if (startIdx < 0) return;
      const cur = indexFromY(ev.clientY);
      if (cur !== startIdx) drag.moved = true;
      const ids = list.slice(Math.min(startIdx, cur), Math.max(startIdx, cur) + 1).map((t) => t.id);
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
    count: rows.length,
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
    const idx = rowsRef.current.findIndex((t) => t.id === selectedThreadId);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedThreadId, virtualizer]);

  // Infinite scroll.
  const items = virtualizer.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (
      lastIndex >= rows.length - 12 &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    ) {
      void query.fetchNextPage();
    }
  }, [lastIndex, rows.length, query]);

  const empty = !query.isLoading && threads.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view === "inbox" && <SplitTabs />}

      {empty ? (
        <InboxZero viewTitle={t(`common:view.${view}`)} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative mx-auto max-w-[1040px]" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((vi) => {
              const t = rows[vi.index];
              if (!t) return null;
              return (
                <div
                  key={t.id}
                  className="absolute inset-x-0"
                  style={{ top: vi.start, height: vi.size }}
                >
                  <ThreadRow
                    thread={t}
                    selected={t.id === selectedThreadId && selection.length === 0}
                    checked={selection.includes(t.id)}
                    selectionMode={selection.length > 0}
                    selfEmails={selfEmails}
                    labelMap={labelMap}
                    leaving={leavingIds.has(t.id)}
                    onRowClick={handleRowClick}
                    onToggleCheck={handleToggleCheck}
                    onGutterDown={onGutterDown}
                    onHover={handleHover}
                  />
                </div>
              );
            })}
          </div>
          {query.isFetchingNextPage && (
            <div className="py-3 text-center text-[12px] text-ink-faint">{t("common:loading")}</div>
          )}
        </div>
      )}

      {selection.length > 0 && <BulkBar count={selection.length} onClear={() => ui({ selection: [] })} />}
    </div>
  );
}

function BulkBar({ count, onClear }: { count: number; onClear: () => void }) {
  const { t } = useTranslation();
  const run = (fn: (ctx: ReturnType<typeof buildCommandContext>) => void) => () => {
    fn(buildCommandContext());
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
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
