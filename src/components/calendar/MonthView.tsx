import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import { DAY_MS, monthGridDays, startOfDayMs, startOfMonth } from "../../lib/calendarGrid";
import { useCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

const MAX_CHIPS = 3;

function isCancelled(ev: CalendarEvent): boolean {
  return ev.status?.toUpperCase() === "CANCELLED" || ev.method?.toUpperCase() === "CANCEL";
}

/** Month layout of the full-screen calendar (`m` toggles it). 42 fixed cells;
 *  chips open the detail popover, a day (or its "+k more") jumps to that week. */
export function MonthView({ anchor }: { anchor: number }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);

  const monthStart = startOfMonth(anchor);
  const month = new Date(monthStart).getMonth();
  const cells = useMemo(() => monthGridDays(monthStart), [monthStart]);
  const rangeEnd = cells[cells.length - 1] + DAY_MS;
  const { data: events } = useCalendarEvents(cells[0], rangeEnd);

  const byDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const day of cells) map.set(day, []);
    for (const ev of events ?? []) {
      const evEnd = ev.endsAt ?? ev.startsAt + 30 * 60_000;
      for (const day of cells) {
        if (ev.startsAt < day + DAY_MS && evEnd > day) map.get(day)!.push(ev);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);
    }
    return map;
  }, [events, cells]);

  const todayStart = startOfDayMs(Date.now());
  const gotoWeek = (day: number) => set({ calendarView: "week", calendarFocusDay: day });

  const openDetail = (ev: CalendarEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    set({ eventDetail: { event: ev, anchor: { x: r.x, y: r.y, w: r.width, h: r.height } } });
  };

  return (
    <div className="co-fade-in flex min-h-0 flex-1 flex-col" data-testid="calendar-month">
      {/* weekday header (Monday-based, from the grid's first week) */}
      <div className="co-hairline-b grid shrink-0 grid-cols-7">
        {cells.slice(0, 7).map((day) => (
          <div
            key={day}
            className="border-l border-hairline px-2 py-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase first:border-l-0"
          >
            {new Date(day).toLocaleDateString(i18n.language, { weekday: "short" })}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map((day, i) => {
          const inMonth = new Date(day).getMonth() === month;
          const isToday = day === todayStart;
          const list = byDay.get(day) ?? [];
          const overflow = list.length - MAX_CHIPS;
          return (
            <div
              key={day}
              className={`flex min-h-0 cursor-pointer flex-col gap-0.5 border-l border-hairline px-1 py-0.5 hover:bg-bg2/50 ${
                i % 7 === 0 ? "border-l-0" : ""
              } ${i >= 7 ? "border-t" : ""} ${inMonth ? "" : "bg-bg1/40"}`}
              onClick={() => gotoWeek(day)}
            >
              <span
                className={`mb-0.5 flex size-5 items-center justify-center self-start rounded-full text-[11px] tabular-nums ${
                  isToday
                    ? "bg-accent font-semibold text-white"
                    : inMonth
                      ? "text-ink-muted"
                      : "text-ink-faint opacity-60"
                }`}
              >
                {new Date(day).getDate()}
              </span>
              {list.slice(0, MAX_CHIPS).map((ev) => {
                const cancelled = isCancelled(ev);
                return (
                  <button
                    key={`${ev.id}:${ev.startsAt}`}
                    type="button"
                    className={`w-full truncate rounded px-1 py-px text-left text-[10.5px] leading-tight font-medium ${
                      cancelled
                        ? "bg-bg2 text-ink-faint line-through opacity-70"
                        : inMonth
                          ? "bg-accent/15 text-accent hover:bg-accent/25"
                          : "bg-accent/10 text-accent/70 hover:bg-accent/20"
                    }`}
                    title={ev.summary ?? undefined}
                    onClick={(e) => openDetail(ev, e)}
                  >
                    {!ev.allDay && (
                      <span className="mr-1 tabular-nums opacity-80">
                        {new Date(ev.startsAt).toLocaleTimeString(i18n.language, {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </span>
                    )}
                    {ev.summary ?? t("calendar:noTitle")}
                  </button>
                );
              })}
              {overflow > 0 && (
                <button
                  type="button"
                  className="w-full truncate rounded px-1 py-px text-left text-[10.5px] font-medium text-ink-faint hover:bg-bg2 hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    gotoWeek(day);
                  }}
                >
                  {t("calendar:moreEvents", { count: overflow })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
