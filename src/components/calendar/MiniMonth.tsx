import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  addMonths,
  DAY_MS,
  monthGridDays,
  startOfDayMs,
  startOfMonth,
  startOfWeekMs,
} from "../../lib/calendarGrid";
import { useSettings, useVisibleCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { groupByDay } from "./eventUtils";
import { CalIcon } from "./icons";

/** Sidebar month picker: shows the visible range, event dots, and moves the
 *  main calendar's focus day on click. */
export function MiniMonth() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const weekStartsOn = settings?.calendarWeekStart ?? "monday";
  const view = useUi((s) => s.calendarView);
  const focusDay = useUi((s) => s.calendarFocusDay);
  const today = startOfDayMs(Date.now());
  const anchor = focusDay ?? today;
  const anchorMonth = startOfMonth(anchor);

  // Own displayed month, re-synced whenever the main calendar's focus moves
  // into a different month (adjust-state-during-render, no effect flash).
  const [month, setMonth] = useState(anchorMonth);
  const [followed, setFollowed] = useState(anchorMonth);
  if (followed !== anchorMonth) {
    setFollowed(anchorMonth);
    setMonth(anchorMonth);
  }

  const days = useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1] + DAY_MS;
  const { data: events } = useVisibleCalendarEvents(gridStart, gridEnd);
  const byDay = useMemo(() => groupByDay(events ?? [], days), [events, days]);

  const [rangeStart, rangeEnd] = useMemo((): [number, number] => {
    if (view === "day") return [anchor, anchor + DAY_MS];
    if (view === "week") {
      const start = startOfWeekMs(anchor, weekStartsOn);
      const end = new Date(start);
      end.setDate(end.getDate() + 7); // DST-safe
      return [start, end.getTime()];
    }
    return [0, 0]; // month view: the grid itself shows the range
  }, [view, anchor, weekStartsOn]);
  const inRange = (day: number) => day >= rangeStart && day < rangeEnd;

  const monthIndex = new Date(month).getMonth();
  const title = new Date(month).toLocaleDateString(i18n.language, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="select-none">
      <div className="mb-1.5 flex items-center gap-1 pl-1">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{title}</span>
        <button
          type="button"
          aria-label={t("calendar:prevMonthAria")}
          onClick={() => setMonth(startOfMonth(addMonths(month, -1)))}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted hover:bg-bg2 hover:text-ink"
        >
          <CalIcon name="chevronLeft" />
        </button>
        <button
          type="button"
          aria-label={t("calendar:nextMonthAria")}
          onClick={() => setMonth(startOfMonth(addMonths(month, 1)))}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted hover:bg-bg2 hover:text-ink"
        >
          <CalIcon name="chevronRight" />
        </button>
      </div>
      <div className="grid grid-cols-7">
        {days.slice(0, 7).map((day) => (
          <div
            key={day}
            className="flex h-6 items-center justify-center text-[10.5px] text-ink-faint"
          >
            {new Date(day).toLocaleDateString(i18n.language, { weekday: "narrow" })}
          </div>
        ))}
        {days.map((day, i) => {
          const date = new Date(day);
          const inMonth = date.getMonth() === monthIndex;
          const isToday = day === today;
          const band = inRange(day);
          const col = i % 7;
          const bandStart = band && (col === 0 || !inRange(days[i - 1]));
          const bandEnd = band && (col === 6 || !inRange(days[i + 1]));
          const hasEvents = (byDay.get(day)?.length ?? 0) > 0;
          return (
            <div
              key={day}
              className={`flex h-7 items-center justify-center ${band ? "bg-accent/10" : ""} ${
                bandStart ? "rounded-l-md" : ""
              } ${bandEnd ? "rounded-r-md" : ""}`}
            >
              <button
                type="button"
                onClick={() => useUi.getState().set({ calendarFocusDay: day })}
                aria-label={date.toLocaleDateString(i18n.language, { dateStyle: "full" })}
                aria-current={isToday ? "date" : undefined}
                className={`relative flex h-6 w-6 items-center justify-center rounded-full text-[11.5px] tabular-nums ${
                  isToday
                    ? "bg-accent font-semibold text-white"
                    : `hover:bg-bg2 ${band ? "font-medium text-accent" : inMonth ? "text-ink" : "text-ink-faint"}`
                }`}
              >
                {date.getDate()}
                {hasEvents && (
                  <span
                    className={`absolute bottom-[1px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full ${
                      isToday ? "bg-white" : "bg-ink-faint"
                    }`}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
