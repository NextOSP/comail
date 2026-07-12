// Mouse interactions for the week grid: drag-create on empty columns,
// drag-move and bottom-edge resize of eligible event blocks. One window-level
// mousemove/mouseup pair per gesture (the ThreadList gutter-drag idiom), a
// 4px threshold to tell clicks from drags, 15-minute snapping, Esc to cancel,
// and auto-scroll near the scroll container's edges.

import { useCallback, useRef, useState } from "react";
import type { CalendarEvent } from "../../ipc/types";
import { DAY_MS, GUTTER_PX, HOUR_PX, snapMinutes, startOfDayMs } from "../../lib/calendarGrid";

const CLICK_SLOP_PX = 4;
const EDGE_ZONE_PX = 40;
const EDGE_STEP_PX = 14;
const MIN_EVENT_MIN = 15;

export type GridDragPreview =
  | { kind: "create"; dayIndex: number; startsAt: number; endsAt: number }
  | { kind: "move"; ev: CalendarEvent; dayIndex: number; startsAt: number; endsAt: number }
  | { kind: "resize"; ev: CalendarEvent; dayIndex: number; startsAt: number; endsAt: number };

export interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GridDragOptions {
  /** Day-start ms for each rendered column, left to right. */
  days: number[];
  /** Vertical scroll container of the grid. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The 24h-tall content row (hour gutter + day columns). */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Drag on an empty column released after moving. */
  onCreate: (startsAt: number, endsAt: number) => void;
  /** Press with no movement on an empty column (legacy 30-min click). */
  onClickCreate: (dayStart: number, rawMinutes: number) => void;
  /** Move drop: whole-day + wall-clock minute deltas (feed to shiftEvent). */
  onMove: (ev: CalendarEvent, dayDelta: number, minuteDelta: number) => void;
  /** Resize drop: new end (start is untouched). */
  onResize: (ev: CalendarEvent, endsAt: number) => void;
  /** Press with no movement on a block: open the detail popover. */
  onOpenDetail: (ev: CalendarEvent, anchor: AnchorRect) => void;
}

interface DragState {
  kind: "create" | "move" | "resize";
  ev: CalendarEvent | null;
  anchor: AnchorRect | null;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  moved: boolean;
  /** create: pressed column + snapped press minutes (and raw for the click path) */
  pressDayIndex: number;
  pressMinutes: number;
  rawPressMinutes: number;
  /** move: source column + pointer-to-start offset in wall minutes */
  srcDayIndex: number;
  grabOffsetMin: number;
  /** current result (applied on mouseup; state is async so it lives here) */
  result: { dayDelta: number; minuteDelta: number; startsAt: number; endsAt: number } | null;
  scrollRaf: number | null;
  cleanup: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const wallMinutes = (ms: number) => (ms - startOfDayMs(ms)) / 60_000;

export function useGridDrag(opts: GridDragOptions) {
  const [preview, setPreview] = useState<GridDragPreview | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** clientX/Y → (column index, minutes-of-day) in grid-content space. */
  const locate = useCallback((clientX: number, clientY: number) => {
    const content = optsRef.current.contentRef.current;
    const days = optsRef.current.days;
    if (!content) return { dayIndex: 0, minutes: 0 };
    const rect = content.getBoundingClientRect();
    const colWidth = (rect.width - GUTTER_PX) / days.length;
    const dayIndex = clamp(
      Math.floor((clientX - rect.left - GUTTER_PX) / colWidth),
      0,
      days.length - 1,
    );
    const minutes = clamp(((clientY - rect.top) / HOUR_PX) * 60, 0, 24 * 60);
    return { dayIndex, minutes };
  }, []);

  /** Recompute the preview (and drop payload) for the pointer position. */
  const update = useCallback(
    (clientX: number, clientY: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { days } = optsRef.current;
      const at = locate(clientX, clientY);

      if (drag.kind === "create") {
        // Vertical range within the pressed column.
        const cur = snapMinutes(at.minutes);
        const lo = Math.min(drag.pressMinutes, cur);
        const hi = Math.max(drag.pressMinutes, cur);
        const start = clamp(lo, 0, 24 * 60 - MIN_EVENT_MIN);
        const end = clamp(Math.max(hi, start + MIN_EVENT_MIN), start + MIN_EVENT_MIN, 24 * 60);
        const day = days[drag.pressDayIndex];
        drag.result = {
          dayDelta: 0,
          minuteDelta: 0,
          startsAt: day + start * 60_000,
          endsAt: day + end * 60_000,
        };
        setPreview({
          kind: "create",
          dayIndex: drag.pressDayIndex,
          startsAt: drag.result.startsAt,
          endsAt: drag.result.endsAt,
        });
        return;
      }

      const ev = drag.ev!;
      if (drag.kind === "move") {
        const durationMs = (ev.endsAt ?? ev.startsAt + 30 * 60_000) - ev.startsAt;
        const startMin = clamp(
          snapMinutes(at.minutes - drag.grabOffsetMin),
          0,
          24 * 60 - Math.max(MIN_EVENT_MIN, Math.min(durationMs / 60_000, 24 * 60)),
        );
        const dayDelta = at.dayIndex - drag.srcDayIndex;
        const minuteDelta = startMin - wallMinutes(ev.startsAt);
        drag.result = { dayDelta, minuteDelta, startsAt: 0, endsAt: 0 };
        const startsAt = days[at.dayIndex] + startMin * 60_000;
        setPreview({
          kind: "move",
          ev,
          dayIndex: at.dayIndex,
          startsAt,
          endsAt: startsAt + durationMs,
        });
        return;
      }

      // resize: end only, clamped to the event's own day
      const dayStart = startOfDayMs(ev.startsAt);
      const rawEnd = dayStart + snapMinutes(at.minutes) * 60_000;
      const endsAt = clamp(rawEnd, ev.startsAt + MIN_EVENT_MIN * 60_000, dayStart + DAY_MS);
      drag.result = { dayDelta: 0, minuteDelta: 0, startsAt: ev.startsAt, endsAt };
      const dayIndex = optsRef.current.days.indexOf(dayStart);
      setPreview({
        kind: "resize",
        ev,
        dayIndex: dayIndex < 0 ? drag.srcDayIndex : dayIndex,
        startsAt: ev.startsAt,
        endsAt,
      });
    },
    [locate],
  );

  /** rAF loop: nudge scrollTop while the pointer sits near an edge. */
  const autoScroll = useCallback(() => {
    const drag = dragRef.current;
    const scroller = optsRef.current.scrollRef.current;
    if (!drag || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const y = drag.lastClientY;
    let delta = 0;
    if (y < rect.top + EDGE_ZONE_PX) delta = -EDGE_STEP_PX;
    else if (y > rect.bottom - EDGE_ZONE_PX) delta = EDGE_STEP_PX;
    if (delta !== 0) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + delta;
      if (scroller.scrollTop !== before) update(drag.lastClientX, drag.lastClientY);
    }
    drag.scrollRaf = requestAnimationFrame(autoScroll);
  }, [update]);

  const begin = useCallback(
    (
      e: React.MouseEvent,
      init: Pick<DragState, "kind" | "ev" | "anchor" | "pressDayIndex" | "srcDayIndex"> & {
        grabOffsetMin?: number;
      },
    ) => {
      if (e.button !== 0 || dragRef.current) return;
      e.preventDefault();

      const at = locate(e.clientX, e.clientY);
      const drag: DragState = {
        ...init,
        grabOffsetMin: init.grabOffsetMin ?? 0,
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        moved: false,
        pressMinutes: snapMinutes(at.minutes),
        rawPressMinutes: at.minutes,
        result: null,
        scrollRaf: null,
        cleanup: () => {},
      };

      const onMouseMove = (ev: MouseEvent) => {
        drag.lastClientX = ev.clientX;
        drag.lastClientY = ev.clientY;
        if (!drag.moved) {
          const dist = Math.hypot(ev.clientX - drag.startClientX, ev.clientY - drag.startClientY);
          if (dist <= CLICK_SLOP_PX) return;
          drag.moved = true;
          drag.scrollRaf = requestAnimationFrame(autoScroll);
        }
        update(ev.clientX, ev.clientY);
      };

      const finish = (commit: boolean) => {
        drag.cleanup();
        dragRef.current = null;
        setPreview(null);
        if (!commit) return;
        const o = optsRef.current;
        if (!drag.moved) {
          // Plain click: open detail (block) or 30-min create (column).
          if (drag.kind === "move" && drag.ev && drag.anchor) {
            o.onOpenDetail(drag.ev, drag.anchor);
          } else if (drag.kind === "create") {
            o.onClickCreate(o.days[drag.pressDayIndex], drag.rawPressMinutes);
          }
          return;
        }
        if (drag.kind === "create" && drag.result) {
          o.onCreate(drag.result.startsAt, drag.result.endsAt);
        } else if (drag.kind === "move" && drag.ev && drag.result) {
          const { dayDelta, minuteDelta } = drag.result;
          if (dayDelta !== 0 || minuteDelta !== 0) o.onMove(drag.ev, dayDelta, minuteDelta);
        } else if (drag.kind === "resize" && drag.ev && drag.result) {
          if (drag.result.endsAt !== drag.ev.endsAt) o.onResize(drag.ev, drag.result.endsAt);
        }
      };

      const onMouseUp = () => finish(true);
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false); // Esc cancels the drag without touching the esc-stack
      };

      drag.cleanup = () => {
        if (drag.scrollRaf != null) cancelAnimationFrame(drag.scrollRaf);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("keydown", onKeyDown, true);
        document.body.classList.remove("select-none");
      };

      dragRef.current = drag;
      document.body.classList.add("select-none");
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      window.addEventListener("keydown", onKeyDown, true);
    },
    [autoScroll, locate, update],
  );

  /** Mousedown on an empty day column (index within `days`). */
  const onColumnMouseDown = useCallback(
    (dayIndex: number, e: React.MouseEvent) => {
      begin(e, { kind: "create", ev: null, anchor: null, pressDayIndex: dayIndex, srcDayIndex: dayIndex });
    },
    [begin],
  );

  /** Mousedown on an eligible (local, timed, not cancelled) event block. */
  const onBlockMouseDown = useCallback(
    (ev: CalendarEvent, e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const at = locate(e.clientX, e.clientY);
      const srcDayIndex = (() => {
        const idx = optsRef.current.days.indexOf(startOfDayMs(ev.startsAt));
        return idx >= 0 ? idx : at.dayIndex;
      })();
      begin(e, {
        kind: "move",
        ev,
        anchor: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        pressDayIndex: at.dayIndex,
        srcDayIndex,
        grabOffsetMin: at.minutes - wallMinutes(ev.startsAt),
      });
    },
    [begin, locate],
  );

  /** Mousedown on the bottom resize strip of an event block. */
  const onResizeMouseDown = useCallback(
    (ev: CalendarEvent, e: React.MouseEvent) => {
      e.stopPropagation();
      const at = locate(e.clientX, e.clientY);
      const idx = optsRef.current.days.indexOf(startOfDayMs(ev.startsAt));
      begin(e, {
        kind: "resize",
        ev,
        anchor: null,
        pressDayIndex: at.dayIndex,
        srcDayIndex: idx >= 0 ? idx : at.dayIndex,
      });
    },
    [begin, locate],
  );

  return { preview, onColumnMouseDown, onBlockMouseDown, onResizeMouseDown };
}
