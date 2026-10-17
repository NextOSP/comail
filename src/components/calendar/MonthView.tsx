import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import {
  DAY_MS,
  monthGridDays,
  packSpans,
  startOfDayMs,
  startOfMonth,
  type CalendarWeekStart,
  type Span,
} from "../../lib/calendarGrid";
import { useVisibleCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { tint, useEventHex } from "./calendarColor";
import { DayListPopover } from "./DayListPopover";
import { eventEnd, groupByDay, isCancelled, rsvpKind, timeLabel, timeRange } from "./eventUtils";

/** Height of the day-number strip at the top of each cell. */
const HEAD_PX = 28;
/** One bar / chip line. */
const LINE_PX = 20;
const COL_PCT = 100 / 7;

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** All-day events and anything crossing midnight render as spanning bars. */
function isBar(ev: CalendarEvent): boolean {
  return ev.allDay || startOfDayMs(ev.startsAt) !== startOfDayMs(eventEnd(ev) - 1);
}

interface WeekLayout {
  bars: Span[];
  /** per column: timed chips to show, the line they start on, and the hidden count */
  cols: { chips: CalendarEvent[]; firstLine: number; hidden: number }[];
}

/**
 * Fit one week row into `cap` lines per day. Bars keep their packed row; a bar
 * hidden in any of its days is hidden everywhere (a bar is one element), which
 * can in turn push more days into overflow - iterate until stable.
 */
function layoutWeek(
  spans: Span[],
  timed: Map<number, CalendarEvent[]>,
  days: number[],
  cap: number,
): WeekLayout {
  const covers = (s: Span, c: number) => s.startCol <= c && c <= s.endCol;
  const timedAt = days.map((d) => timed.get(d) ?? []);
  const limit = days.map((_, c) => {
    const barLines = spans.reduce((m, s) => (covers(s, c) ? Math.max(m, s.row + 1) : m), 0);
    return barLines + timedAt[c].length <= cap ? cap : cap - 1;
  });
  let hidden = new Set<Span>();
  for (;;) {
    hidden = new Set(
      spans.filter((s) => {
        for (let c = s.startCol; c <= s.endCol; c++) if (s.row >= limit[c]) return true;
        return false;
      }),
    );
    let changed = false;
    for (const s of hidden) {
      for (let c = s.startCol; c <= s.endCol; c++) {
        if (limit[c] === cap) {
          limit[c] = cap - 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const bars = spans.filter((s) => !hidden.has(s));
  const cols = days.map((_, c) => {
    const here = spans.filter((s) => covers(s, c));
    const firstLine = bars.reduce((m, s) => (covers(s, c) ? Math.max(m, s.row + 1) : m), 0);
    const chips = timedAt[c].slice(0, Math.max(0, limit[c] - firstLine));
    const shown = here.filter((s) => !hidden.has(s)).length + chips.length;
    return { chips, firstLine, hidden: here.length + timedAt[c].length - shown };
  });
  return { bars, cols };
}

/** Month layout of the full-screen calendar. 6 week rows; all-day and
 *  multi-day events span as bars, timed events show as dot chips, and as many
 *  lines as fit the row height are shown before "+N more" (day list popover).
 *  Double-click a day opens it in Day view. */
export function MonthView({
  anchor,
  weekStartsOn,
}: {
  anchor: number;
  weekStartsOn: CalendarWeekStart;
}) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const hexFor = useEventHex();

  const monthStart = startOfMonth(anchor);
  const month = new Date(monthStart).getMonth();
  const cells = useMemo(
    () => monthGridDays(monthStart, weekStartsOn),
    [monthStart, weekStartsOn],
  );
  const weeks = useMemo(
    () => Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7)),
    [cells],
  );
  const rangeEnd = cells[cells.length - 1] + DAY_MS;
  const { data: events } = useVisibleCalendarEvents(cells[0], rangeEnd);

  // Row height -> how many lines fit under the day number.
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowPx, setRowPx] = useState(0);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setRowPx(el.clientHeight / 6);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cap = Math.max(1, Math.floor((rowPx - HEAD_PX - 2) / LINE_PX));

  const layouts = useMemo(() => {
    const bars = (events ?? []).filter(isBar);
    const timed = (events ?? [])
      .filter((ev) => !isBar(ev))
      .sort((a, b) => a.startsAt - b.startsAt);
    return weeks.map((days) =>
      layoutWeek(packSpans(bars, days), groupByDay(timed, days), days, cap),
    );
  }, [events, weeks, cap]);

  const todayStart = startOfDayMs(Date.now());

  const openDetail = (ev: CalendarEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    set({ eventDetail: { event: ev, anchor: rectOf(e.currentTarget) } });
  };
  const openDayList = (day: number, e: React.MouseEvent) => {
    e.stopPropagation();
    // Anchor to the whole day cell, not the small link.
    const cell = e.currentTarget.closest("[data-week-row]")?.querySelector(`[data-day-cell="${day}"]`);
    set({ calendarDayList: { day, anchor: rectOf(cell ?? e.currentTarget) } });
  };

  const stateClass = (ev: CalendarEvent) =>
    isCancelled(ev) ? "line-through opacity-60" : rsvpKind(ev) === "declined" ? "opacity-50" : "";

  return (
    <div className="co-fade-in flex min-h-0 flex-1 flex-col" data-testid="calendar-month">
      {/* Weekday header follows the configured first day of the week. */}
      <div className="co-hairline-b grid shrink-0 grid-cols-7">
        {cells.slice(0, 7).map((day) => {
          const wd = new Date(day).getDay();
          return (
            <div
              key={day}
              className={`px-2 py-1.5 text-[11px] font-medium tracking-wide text-ink-faint uppercase ${
                wd === 0 || wd === 6 ? "bg-bg2/40" : ""
              }`}
            >
              {new Date(day).toLocaleDateString(i18n.language, { weekday: "short" })}
            </div>
          );
        })}
      </div>

      <div ref={gridRef} className="grid min-h-0 flex-1 grid-rows-6">
        {weeks.map((days, w) => {
          const { bars, cols } = layouts[w];
          return (
            <div
              key={days[0]}
              data-week-row
              className={`relative grid min-h-0 grid-cols-7 overflow-hidden ${
                w > 0 ? "border-t border-hairline" : ""
              }`}
            >
              {/* Day cells: background, day number, double-click target. */}
              {days.map((day, c) => {
                const date = new Date(day);
                const inMonth = date.getMonth() === month;
                const isToday = day === todayStart;
                const weekend = date.getDay() === 0 || date.getDay() === 6;
                return (
                  <div
                    key={day}
                    data-day-cell={day}
                    className={`min-h-0 px-1.5 pt-1 ${c > 0 ? "border-l border-hairline" : ""} ${
                      weekend ? "bg-bg2/40" : ""
                    } ${inMonth ? "" : "co-hatch"}`}
                    onDoubleClick={() => set({ calendarView: "day", calendarFocusDay: day })}
                  >
                    <span
                      className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[12px] tabular-nums ${
                        isToday
                          ? "bg-accent font-semibold text-white"
                          : inMonth
                            ? "text-ink-muted"
                            : "text-ink-faint"
                      }`}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                );
              })}

              {/* Items layer: bars by packed row, then timed chips per day. */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0"
                style={{ top: HEAD_PX }}
              >
                {bars.map((s) => {
                  const hex = hexFor(s.ev);
                  const title = s.ev.summary ?? t("calendar:noTitle");
                  const when = s.ev.allDay
                    ? t("calendar:allDay")
                    : timeRange(s.ev.startsAt, eventEnd(s.ev));
                  const inset = (clipped: boolean) => (clipped ? "0px" : "4px");
                  return (
                    <button
                      key={`${s.ev.id}:${s.ev.startsAt}`}
                      type="button"
                      aria-label={`${title}, ${when}`}
                      title={title}
                      className={`pointer-events-auto absolute flex h-[18px] items-center truncate px-1.5 text-left text-[11px] font-medium hover:brightness-95 ${
                        s.clippedStart ? "" : "rounded-l"
                      } ${s.clippedEnd ? "" : "rounded-r"} ${stateClass(s.ev)}`}
                      style={{
                        top: s.row * LINE_PX + 1,
                        left: `calc(${s.startCol * COL_PCT}% + ${inset(s.clippedStart)})`,
                        width: `calc(${(s.endCol - s.startCol + 1) * COL_PCT}% - ${inset(s.clippedStart)} - ${inset(s.clippedEnd)})`,
                        backgroundColor: tint(hex, 18),
                        color: tint(hex),
                        boxShadow: s.clippedStart ? undefined : `inset 3px 0 0 ${tint(hex)}`,
                      }}
                      onClick={(e) => openDetail(s.ev, e)}
                    >
                      <span className="truncate">
                        {!s.ev.allDay && !s.clippedStart && (
                          <span className="mr-1 tabular-nums opacity-80">
                            {timeLabel(s.ev.startsAt)}
                          </span>
                        )}
                        {title}
                      </span>
                    </button>
                  );
                })}

                {cols.map(({ chips, firstLine, hidden }, c) => {
                  const day = days[c];
                  const pos = (line: number) => ({
                    top: line * LINE_PX,
                    left: `calc(${c * COL_PCT}% + 2px)`,
                    width: `calc(${COL_PCT}% - 4px)`,
                  });
                  return (
                    <div key={day}>
                      {chips.map((ev, i) => {
                        const hex = hexFor(ev);
                        const title = ev.summary ?? t("calendar:noTitle");
                        const rsvp = rsvpKind(ev);
                        const hollow = rsvp === "tentative" || rsvp === "needs";
                        return (
                          <button
                            key={`${ev.id}:${ev.startsAt}`}
                            type="button"
                            aria-label={`${title}, ${timeLabel(ev.startsAt)}`}
                            title={title}
                            className={`pointer-events-auto absolute flex h-[20px] items-center gap-1.5 rounded px-1 text-left text-[11.5px] text-ink hover:bg-bg2 ${stateClass(ev)}`}
                            style={pos(firstLine + i)}
                            onClick={(e) => openDetail(ev, e)}
                          >
                            <span
                              className="size-1.5 shrink-0 rounded-full"
                              style={
                                hollow
                                  ? { boxShadow: `inset 0 0 0 1.25px ${tint(hex)}` }
                                  : { backgroundColor: tint(hex) }
                              }
                            />
                            <span className="shrink-0 text-ink-faint tabular-nums">
                              {timeLabel(ev.startsAt)}
                            </span>
                            <span className="min-w-0 truncate">{title}</span>
                          </button>
                        );
                      })}
                      {hidden > 0 && (
                        <button
                          type="button"
                          className="pointer-events-auto absolute flex h-[20px] items-center rounded px-1 text-left text-[11px] font-medium text-ink-faint hover:bg-bg2 hover:text-ink"
                          style={pos(firstLine + chips.length)}
                          onClick={(e) => openDayList(day, e)}
                        >
                          {t("calendar:moreEvents", { count: hidden })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <DayListPopover />
    </div>
  );
}
