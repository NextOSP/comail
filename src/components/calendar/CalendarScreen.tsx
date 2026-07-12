import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import {
  addMonths,
  DAY_MS,
  GUTTER_PX,
  HOUR_PX,
  layoutDay,
  msToY,
  shiftEvent,
  startOfDayMs,
  startOfMonth,
  startOfWeekMs,
} from "../../lib/calendarGrid";
import { useCalendarEvents, useMoveEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { MonthView } from "./MonthView";
import { useGridDrag, type AnchorRect } from "./useGridDrag";

function isCancelled(ev: CalendarEvent): boolean {
  return ev.status?.toUpperCase() === "CANCELLED" || ev.method?.toUpperCase() === "CANCEL";
}

/** Local events we organize can be dragged/resized; invites are read-only. */
function isDraggable(ev: CalendarEvent): boolean {
  return ev.isLocal && !isCancelled(ev) && !ev.allDay;
}

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** One horizontal wheel burst (|Δx|>|Δy| or shift+wheel) = one page. */
function usePageWheel(ref: React.RefObject<HTMLElement | null>, page: (dir: 1 | -1) => void) {
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    let latchedAt = 0;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (!horizontal) return;
      e.preventDefault();
      const now = Date.now();
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (latchedAt > 0) {
        // Already paged for this swipe: swallow until 250ms of quiet.
        if (now - latchedAt < 250) {
          latchedAt = now;
          return;
        }
        latchedAt = 0;
        acc = 0;
      }
      acc += delta;
      if (Math.abs(acc) >= 120) {
        pageRef.current(acc > 0 ? 1 : -1);
        acc = 0;
        latchedAt = now;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

/** Full-screen calendar (`2`): week grid with drag create/move/resize and a
 *  month layout (`m`). Click an event for details; `-`/`=` page, `t` = today,
 *  Esc/1 returns to the inbox. */
export function CalendarScreen() {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const focusDay = useUi((s) => s.calendarFocusDay);
  const view = useUi((s) => s.calendarView);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const moveEvent = useMoveEvent();

  const todayStart = startOfDayMs(Date.now());
  const anchor = focusDay ?? todayStart;
  const weekStart = startOfWeekMs(anchor);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS),
    [weekStart],
  );
  const { data: events } = useCalendarEvents(weekStart, weekStart + 7 * DAY_MS, view === "week");

  const byDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const day of days) map.set(day, []);
    for (const ev of events ?? []) {
      const evEnd = ev.endsAt ?? ev.startsAt + 30 * 60_000;
      for (const day of days) {
        if (ev.startsAt < day + DAY_MS && evEnd > day) map.get(day)!.push(ev);
      }
    }
    return map;
  }, [events, days]);

  // Open scrolled to the working morning.
  useEffect(() => {
    if (view === "week") scrollRef.current?.scrollTo({ top: 8 * HOUR_PX - 12 });
  }, [weekStart, view]);

  const heading =
    view === "month"
      ? new Date(startOfMonth(anchor)).toLocaleDateString(i18n.language, {
          month: "long",
          year: "numeric",
        })
      : `${new Date(weekStart).toLocaleDateString(i18n.language, { month: "long", day: "numeric" })} – ${new Date(weekStart + 6 * DAY_MS).toLocaleDateString(i18n.language, { month: "long", day: "numeric", year: "numeric" })}`;

  const page = (dir: 1 | -1) =>
    set({
      calendarFocusDay:
        view === "month" ? addMonths(startOfMonth(anchor), dir) : weekStart + dir * 7 * DAY_MS,
    });
  usePageWheel(rootRef, page);

  const openDetail = (ev: CalendarEvent, anchorRect: AnchorRect) =>
    set({ eventDetail: { event: ev, anchor: anchorRect } });

  const openDetailFromClick = (ev: CalendarEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openDetail(ev, { x: r.x, y: r.y, w: r.width, h: r.height });
  };

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
      const shifted = shiftEvent(
        ev.startsAt,
        ev.endsAt ?? ev.startsAt + 30 * 60_000,
        dayDelta,
        minuteDelta,
      );
      moveEvent.mutate(updateArgsFor(ev, shifted.startsAt, shifted.endsAt));
    },
    onResize: (ev, endsAt) => {
      moveEvent.mutate(updateArgsFor(ev, ev.startsAt, endsAt));
    },
    onOpenDetail: openDetail,
  });

  const now = Date.now();
  const nowTop = ((now - todayStart) / 3_600_000) * HOUR_PX;
  const dragging = preview != null;

  return (
    <div
      ref={rootRef}
      className="co-fade-in flex min-h-0 flex-1 flex-col"
      data-testid="calendar-screen"
    >
      <header className="co-hairline-b flex shrink-0 items-center gap-2 px-4 py-2.5">
        <h1 className="text-[15px] font-semibold text-ink">{heading}</h1>
        <div className="ml-2 flex items-center gap-1">
          <button
            className="rounded-md px-2 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            title="-"
            aria-label={t("calendar:prevAria")}
            onClick={() => page(-1)}
          >
            ‹
          </button>
          <button
            className="rounded-md px-2 py-0.5 text-[12px] text-ink-muted hover:bg-bg2 hover:text-ink"
            title="t"
            onClick={() => set({ calendarFocusDay: null })}
          >
            {t("calendar:today")}
          </button>
          <button
            className="rounded-md px-2 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            title="="
            aria-label={t("calendar:nextAria")}
            onClick={() => page(1)}
          >
            ›
          </button>
        </div>
        {/* Week | Month segmented toggle (`m`) */}
        <div className="ml-2 flex items-center rounded-md border border-hairline p-0.5">
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              title="m"
              className={`rounded px-2 py-0.5 text-[12px] font-medium ${
                view === v ? "bg-bg2 text-ink" : "text-ink-faint hover:text-ink"
              }`}
              onClick={() => set({ calendarView: v })}
            >
              {t(`calendar:${v}`)}
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="text-[11.5px] text-ink-faint">{t("calendar:screenHint")}</span>
        <button
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:bg-bg2 hover:text-ink"
          onClick={() => set({ eventCreate: {} })}
        >
          + {t("calendar:create.title")}
        </button>
      </header>

      {view === "month" ? (
        <MonthView anchor={anchor} />
      ) : (
        <>
          {/* day headers + all-day row */}
          <div className="co-hairline-b flex shrink-0 pr-3" style={{ paddingLeft: GUTTER_PX }}>
            {days.map((day) => {
              const allDay = (byDay.get(day) ?? []).filter((e) => e.allDay);
              const isToday = day === todayStart;
              return (
                <div key={day} className="min-w-0 flex-1 border-l border-hairline px-1.5 py-1.5">
                  <div
                    className={`text-[11.5px] font-semibold tracking-wide uppercase ${
                      isToday ? "text-accent" : "text-ink-faint"
                    }`}
                  >
                    {new Date(day).toLocaleDateString(i18n.language, { weekday: "short" })}{" "}
                    <span className="tabular-nums">{new Date(day).getDate()}</span>
                  </div>
                  {allDay.map((ev) => (
                    <div
                      key={`${ev.id}:${ev.startsAt}`}
                      className={`mt-1 cursor-pointer truncate rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/25 ${
                        isCancelled(ev) ? "line-through opacity-60" : ""
                      }`}
                      title={ev.summary ?? undefined}
                      onClick={(e) => openDetailFromClick(ev, e)}
                    >
                      {ev.summary ?? t("calendar:noTitle")}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* time grid */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-3">
            <div ref={contentRef} className="relative flex" style={{ height: 24 * HOUR_PX }}>
              {/* hour gutter */}
              <div className="relative shrink-0" style={{ width: GUTTER_PX }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute right-2 -translate-y-1/2 text-[10.5px] text-ink-faint tabular-nums"
                    style={{ top: h * HOUR_PX }}
                  >
                    {h > 0 && timeLabel(todayStart + h * 3_600_000)}
                  </div>
                ))}
              </div>

              {days.map((day, dayIndex) => {
                const isToday = day === todayStart;
                const positioned = layoutDay(byDay.get(day) ?? [], day);
                const ghost = preview != null && preview.dayIndex === dayIndex ? preview : null;
                return (
                  <div
                    key={day}
                    className={`relative min-w-0 flex-1 border-l border-hairline ${
                      isToday ? "bg-accent/[0.03]" : ""
                    }`}
                    onMouseDown={(e) => onColumnMouseDown(dayIndex, e)}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute right-0 left-0 border-t border-hairline/60"
                        style={{ top: h * HOUR_PX }}
                      />
                    ))}
                    {isToday && now >= day && now < day + DAY_MS && (
                      <div
                        className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-danger"
                        style={{ top: nowTop }}
                      >
                        <span className="absolute -top-[5px] -left-[4px] size-2 rounded-full bg-danger" />
                      </div>
                    )}
                    {positioned.map(({ ev, top, height, lane, lanes }) => {
                      const cancelled = isCancelled(ev);
                      const draggable = isDraggable(ev);
                      const beingDragged =
                        preview != null && preview.kind !== "create" && preview.ev.id === ev.id;
                      return (
                        <div
                          key={`${ev.id}:${ev.startsAt}`}
                          className={`absolute overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] leading-tight ${
                            cancelled
                              ? "border-hairline bg-bg2 text-ink-faint line-through opacity-70"
                              : ev.isLocal
                                ? "border-accent/50 bg-accent/20 text-ink"
                                : "border-accent/30 bg-accent/10 text-ink"
                          } ${draggable ? "cursor-grab" : "cursor-pointer"} ${
                            beingDragged ? "opacity-40" : ""
                          }`}
                          style={{
                            top,
                            height,
                            left: `calc(${(lane / lanes) * 100}% + 2px)`,
                            width: `calc(${100 / lanes}% - 4px)`,
                          }}
                          title={`${ev.summary ?? ""}${ev.location ? ` · ${ev.location}` : ""}`}
                          onMouseDown={(e) => {
                            if (draggable) onBlockMouseDown(ev, e);
                            else e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Draggable blocks open from the no-move mouseup path.
                            if (!draggable) openDetailFromClick(ev, e);
                          }}
                        >
                          <div className="truncate font-medium">
                            {ev.summary ?? t("calendar:noTitle")}
                          </div>
                          {height >= 34 && (
                            <div className="truncate text-[10.5px] text-ink-faint tabular-nums">
                              {timeLabel(ev.startsAt)}
                              {ev.location && !ev.location.startsWith("http")
                                ? ` · ${ev.location}`
                                : ""}
                            </div>
                          )}
                          {ev.joinUrl && !cancelled && height >= 50 && (
                            <button
                              type="button"
                              className="mt-0.5 rounded border border-accent/50 px-1 text-[10.5px] font-medium text-accent hover:bg-accent/10"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                void openUrl(ev.joinUrl!);
                              }}
                            >
                              {t("calendar:join")}
                            </button>
                          )}
                          {draggable && !dragging && (
                            <div
                              className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize"
                              onMouseDown={(e) => onResizeMouseDown(ev, e)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {/* live drag preview: create highlight or move/resize ghost */}
                    {ghost && (
                      <div
                        className={`pointer-events-none absolute right-0.5 left-0.5 z-20 overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] leading-tight ${
                          ghost.kind === "create"
                            ? "border-accent/50 bg-accent/15 text-accent"
                            : "border-accent bg-accent/30 text-ink"
                        }`}
                        style={{
                          top: msToY(ghost.startsAt, day),
                          height: Math.max(msToY(ghost.endsAt, day) - msToY(ghost.startsAt, day), 12),
                          boxShadow: ghost.kind === "create" ? undefined : "var(--elev-2)",
                        }}
                      >
                        <div className="truncate font-medium">
                          {ghost.kind === "create"
                            ? `${timeLabel(ghost.startsAt)} – ${timeLabel(ghost.endsAt)}`
                            : (ghost.ev.summary ?? t("calendar:noTitle"))}
                        </div>
                        {ghost.kind !== "create" && (
                          <div className="truncate text-[10.5px] tabular-nums opacity-80">
                            {timeLabel(ghost.startsAt)} – {timeLabel(ghost.endsAt)}
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
      )}
    </div>
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
