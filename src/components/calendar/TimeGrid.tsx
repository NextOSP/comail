import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import {
  DAY_MS,
  GUTTER_PX,
  HOUR_PX,
  layoutDay,
  msToY,
  packSpans,
  shiftEvent,
  startOfDayMs,
} from "../../lib/calendarGrid";
import { useMoveEvent, useVisibleCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { useEventHex } from "./calendarColor";
import { EventBlock, eventLook } from "./EventBlock";
import {
  eventEnd,
  groupByDay,
  isDraggable,
  timeLabel,
  timeRange,
  withoutShadowedCancels,
} from "./eventUtils";
import { CalIcon } from "./icons";
import { useGridDrag, type AnchorRect } from "./useGridDrag";
import { useNow } from "./useNow";

/** All-day bars shown before the row collapses behind a "+N" toggle. */
const ALL_DAY_ROWS = 2;
const ALL_DAY_ROW_PX = 22;

const rectOf = (el: Element): AnchorRect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** Time grid for the day (1 column) and week (7 columns) views: day headers,
 *  all-day bars, hour gutter, now-line, and drag create/move/resize. */
export function TimeGrid({ days }: { days: number[] }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const moveEvent = useMoveEvent();
  const now = useNow();
  const todayStart = startOfDayMs(now);
  const hexFor = useEventHex();
  const single = days.length === 1;

  const rangeStart = days[0];
  const rangeEnd = days[days.length - 1] + DAY_MS;
  const { data: events } = useVisibleCalendarEvents(rangeStart, rangeEnd);

  const allDaySpans = useMemo(
    () => packSpans((events ?? []).filter((e) => e.allDay), days),
    [events, days],
  );
  const byDay = useMemo(
    () => groupByDay((events ?? []).filter((e) => !e.allDay), days),
    [events, days],
  );

  const [allDayOpen, setAllDayOpen] = useState(false);
  const allDayRows = allDaySpans.reduce((m, s) => Math.max(m, s.row + 1), 0);
  const shownRows = allDayOpen ? allDayRows : Math.min(allDayRows, ALL_DAY_ROWS);
  const hiddenAllDay = allDaySpans.filter((s) => s.row >= shownRows).length;

  // Land on the working day once when the grid opens (an hour and a half
  // before now, never earlier than 08:00). Paging keeps the scroll position so
  // the time of day stays put while the days change.
  const showsToday = todayStart >= rangeStart && todayStart < rangeEnd;
  useEffect(() => {
    const nowHours = (Date.now() - startOfDayMs(Date.now())) / 3_600_000;
    const hour = Math.max(Math.min(nowHours - 1.5, 17), 8);
    scrollRef.current?.scrollTo({ top: hour * HOUR_PX - 12 });
  }, []);

  const openDetail = (ev: CalendarEvent, anchor: AnchorRect) =>
    set({ eventDetail: { event: ev, anchor } });

  const { preview, onColumnMouseDown, onBlockMouseDown, onResizeMouseDown } = useGridDrag({
    days,
    scrollRef,
    contentRef,
    onCreate: (startsAt, endsAt) => set({ eventCreate: { prefill: { startsAt, endsAt } } }),
    onClickCreate: (dayStart, rawMinutes) => {
      const rounded = Math.floor(rawMinutes / 30) * 30;
      const startsAt = dayStart + rounded * 60_000;
      set({ eventCreate: { prefill: { startsAt, endsAt: startsAt + 30 * 60_000 } } });
    },
    onMove: (ev, dayDelta, minuteDelta) => {
      const shifted = shiftEvent(ev.startsAt, eventEnd(ev), dayDelta, minuteDelta);
      moveEvent.mutate(updateArgsFor(ev, shifted.startsAt, shifted.endsAt));
    },
    onResize: (ev, endsAt) => {
      moveEvent.mutate(updateArgsFor(ev, ev.startsAt, endsAt));
    },
    onOpenDetail: openDetail,
  });
  const dragging = preview != null;
  const nowTop = msToY(now, todayStart);

  return (
    <>
      {/* day headers + all-day bars */}
      <div className="co-hairline-b shrink-0 pr-3">
        <div className="flex" style={{ paddingLeft: GUTTER_PX }}>
          {days.map((day) => {
            const isToday = day === todayStart;
            const d = new Date(day);
            return (
              <button
                key={day}
                type="button"
                disabled={single}
                className={`flex min-w-0 flex-1 items-center gap-1.5 border-l border-hairline px-2 pt-2 pb-1.5 text-left ${
                  single ? "cursor-default" : "hover:bg-bg2/60"
                }`}
                title={single ? undefined : t("calendar:viewDay")}
                onClick={() => set({ calendarView: "day", calendarFocusDay: day })}
              >
                <span
                  className={`text-[11px] font-semibold tracking-wide uppercase ${
                    isToday ? "text-accent" : "text-ink-faint"
                  }`}
                >
                  {d.toLocaleDateString(i18n.language, { weekday: single ? "long" : "short" })}
                </span>
                <span
                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[13px] font-semibold tabular-nums ${
                    isToday ? "bg-accent text-white" : "text-ink"
                  }`}
                >
                  {d.getDate()}
                </span>
              </button>
            );
          })}
        </div>

        {allDayRows > 0 && (
          <div className="relative flex">
            <div
              className="flex shrink-0 items-start justify-end pt-0.5 pr-2"
              style={{ width: GUTTER_PX }}
            >
              {allDayRows > ALL_DAY_ROWS ? (
                <button
                  type="button"
                  className="rounded px-1 text-[10.5px] font-medium text-ink-faint hover:bg-bg2 hover:text-ink"
                  aria-expanded={allDayOpen}
                  onClick={() => setAllDayOpen((o) => !o)}
                >
                  {allDayOpen ? (
                    <span className="inline-block rotate-180">
                      <CalIcon name="chevronDown" size={12} />
                    </span>
                  ) : (
                    t("calendar:allDayMore", { count: hiddenAllDay })
                  )}
                </button>
              ) : (
                <span className="text-[10.5px] text-ink-faint">{t("calendar:allDay")}</span>
              )}
            </div>
            <div
              className="relative flex-1 border-l border-hairline"
              style={{ height: shownRows * ALL_DAY_ROW_PX + 4 }}
            >
              {allDaySpans
                .filter((s) => s.row < shownRows)
                .map((s) => {
                  const look = eventLook(s.ev, hexFor(s.ev));
                  const cols = days.length;
                  return (
                    <button
                      key={`${s.ev.id}:${s.ev.startsAt}`}
                      type="button"
                      className={`absolute truncate border-l-[3px] px-1.5 text-left text-[11.5px] leading-[18px] font-medium hover:brightness-[1.04] ${
                        look.className
                      } ${s.clippedStart ? "rounded-l-none" : "rounded-l-md"} ${
                        s.clippedEnd ? "rounded-r-none" : "rounded-r-md"
                      }`}
                      style={{
                        ...look.style,
                        ...(s.clippedStart ? { borderLeftColor: "transparent" } : null),
                        top: 2 + s.row * ALL_DAY_ROW_PX,
                        height: ALL_DAY_ROW_PX - 3,
                        left: `calc(${(s.startCol / cols) * 100}% + 2px)`,
                        width: `calc(${((s.endCol - s.startCol + 1) / cols) * 100}% - 4px)`,
                      }}
                      title={s.ev.summary ?? undefined}
                      onClick={(e) => openDetail(s.ev, rectOf(e.currentTarget))}
                    >
                      {s.ev.summary ?? t("calendar:noTitle")}
                    </button>
                  );
                })}
              {/* column rules under the bars */}
              {days.slice(1).map((day, i) => (
                <div
                  key={day}
                  className="pointer-events-none absolute top-0 bottom-0 border-l border-hairline"
                  style={{ left: `${((i + 1) / days.length) * 100}%` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* time grid */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-3">
        <div ref={contentRef} className="relative flex" style={{ height: 24 * HOUR_PX }}>
          {/* hour gutter */}
          <div className="relative shrink-0" style={{ width: GUTTER_PX }}>
            {Array.from({ length: 24 }, (_, h) =>
              h > 0 && !(showsToday && Math.abs(h * HOUR_PX - nowTop) < 12) ? (
                <div
                  key={h}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-ink-faint tabular-nums"
                  style={{ top: h * HOUR_PX }}
                >
                  {timeLabel(todayStart + h * 3_600_000)}
                </div>
              ) : null,
            )}
            {showsToday && (
              <div
                className="absolute right-1 z-10 -translate-y-1/2 rounded-full bg-danger px-1.5 py-px text-[10.5px] font-semibold text-white tabular-nums"
                style={{ top: nowTop }}
                aria-label={t("calendar:now")}
              >
                {timeLabel(now)}
              </div>
            )}
          </div>

          {days.map((day, dayIndex) => {
            const isToday = day === todayStart;
            const positioned = layoutDay(withoutShadowedCancels(byDay.get(day) ?? []), day);
            const ghost = preview != null && preview.dayIndex === dayIndex ? preview : null;
            return (
              <div
                key={day}
                className="relative min-w-0 flex-1 border-l border-hairline"
                onMouseDown={(e) => onColumnMouseDown(dayIndex, e)}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute right-0 left-0 border-t border-hairline/70"
                    style={{ top: h * HOUR_PX }}
                  />
                ))}
                {showsToday && (
                  <div
                    className={`pointer-events-none absolute right-0 left-0 z-10 ${
                      isToday ? "border-t-2 border-danger" : "border-t border-danger/25"
                    }`}
                    style={{ top: nowTop }}
                  >
                    {isToday && (
                      <span className="absolute -top-[5px] -left-[4px] size-2 rounded-full bg-danger" />
                    )}
                  </div>
                )}
                {positioned.map(({ ev, top, height, lane, lanes }) => {
                  const draggable = isDraggable(ev);
                  return (
                    <EventBlock
                      key={`${ev.id}:${ev.startsAt}`}
                      ev={ev}
                      hex={hexFor(ev)}
                      height={height}
                      now={now}
                      draggable={draggable}
                      dimmed={preview != null && preview.kind !== "create" && preview.ev.id === ev.id}
                      showResize={draggable && !dragging}
                      style={{
                        top: top + 1,
                        height: height - 2,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                      onMouseDown={(e) => onBlockMouseDown(ev, e)}
                      onOpen={(el) => openDetail(ev, rectOf(el))}
                      onResizeMouseDown={(e) => onResizeMouseDown(ev, e)}
                    />
                  );
                })}
                {/* live drag preview: create highlight or move/resize ghost */}
                {ghost && (
                  <div
                    className={`pointer-events-none absolute right-0.5 left-0.5 z-20 overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-[11.5px] leading-tight ${
                      ghost.kind === "create"
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-accent bg-accent/30 text-ink"
                    }`}
                    style={{
                      top: msToY(ghost.startsAt, day),
                      height: Math.max(msToY(ghost.endsAt, day) - msToY(ghost.startsAt, day), 14),
                      boxShadow: ghost.kind === "create" ? undefined : "var(--elev-2)",
                    }}
                  >
                    <div className="truncate font-semibold">
                      {ghost.kind === "create"
                        ? timeRange(ghost.startsAt, ghost.endsAt)
                        : (ghost.ev.summary ?? t("calendar:noTitle"))}
                    </div>
                    {ghost.kind !== "create" && (
                      <div className="truncate text-[11px] tabular-nums opacity-80">
                        {timeRange(ghost.startsAt, ghost.endsAt)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** Full update payload for a drag drop: the event's fields with new times. */
function updateArgsFor(ev: CalendarEvent, startsAt: number, endsAt: number) {
  return {
    eventId: ev.id,
    accountId: ev.accountId,
    summary: ev.summary ?? "",
    description: ev.description,
    location: ev.location,
    joinUrl: ev.joinUrl,
    startsAt,
    endsAt,
    allDay: ev.allDay,
    attendees: ev.attendees.map((a) => ({ name: a.name, email: a.email })),
    notify: true,
  };
}
