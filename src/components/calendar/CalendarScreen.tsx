import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  addDays,
  addMonths,
  startOfDayMs,
  startOfMonth,
  startOfWeekMs,
} from "../../lib/calendarGrid";
import { useSettings } from "../../queries/hooks";
import { useUi, type CalendarView } from "../../stores/ui";
import { CalendarSidebar } from "./CalendarSidebar";
import { CalIcon } from "./icons";
import { MonthView } from "./MonthView";
import { TimeGrid } from "./TimeGrid";

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
      // Only a clearly sideways swipe pages; the drift in an ordinary vertical
      // trackpad scroll must never flip the week.
      const horizontal = Math.abs(e.deltaX) > 2 * Math.abs(e.deltaY) || e.shiftKey;
      if (!horizontal) {
        acc = 0;
        return;
      }
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
      if (Math.abs(acc) >= 180) {
        pageRef.current(acc > 0 ? 1 : -1);
        acc = 0;
        latchedAt = now;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

/** Full-screen calendar (`2`): sidebar (mini month + calendar list, `\`),
 *  day / week time grid with drag create/move/resize, and a month layout
 *  (`d` / `w` / `m`). `-`/`=` page, `t` = today, Esc/1 returns to the inbox. */
export function CalendarScreen() {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const focusDay = useUi((s) => s.calendarFocusDay);
  const view = useUi((s) => s.calendarView);
  const sidebar = useUi((s) => s.calendarSidebar);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data: settings } = useSettings();
  const weekStartsOn = settings?.calendarWeekStart ?? "monday";

  const anchor = startOfDayMs(focusDay ?? Date.now());
  const weekStart = startOfWeekMs(anchor, weekStartsOn);
  const days = useMemo(
    () =>
      view === "day"
        ? [anchor]
        : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [view, anchor, weekStart],
  );

  const heading = headingFor(view, anchor, days);

  const page = (dir: 1 | -1) =>
    set({
      calendarFocusDay:
        view === "month"
          ? addMonths(startOfMonth(anchor), dir)
          : addDays(view === "day" ? anchor : weekStart, dir * days.length),
    });
  usePageWheel(rootRef, page);

  const iconBtn =
    "inline-flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-bg2 hover:text-ink";

  return (
    <div
      ref={rootRef}
      className="co-fade-in flex min-h-0 flex-1 flex-col"
      data-testid="calendar-screen"
    >
      <header className="co-hairline-b flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          type="button"
          className={iconBtn}
          title={t("calendar:toggleSidebar")}
          aria-label={t("calendar:toggleSidebar")}
          aria-pressed={sidebar}
          onClick={() => set({ calendarSidebar: !sidebar })}
        >
          <CalIcon name="sidebar" size={16} />
        </button>
        <button
          type="button"
          className="h-7 rounded-md border border-hairline px-2.5 text-[12.5px] font-medium text-ink hover:bg-bg2"
          title={t("calendar:todayTitle")}
          onClick={() => set({ calendarFocusDay: null })}
        >
          {t("calendar:today")}
        </button>
        <div className="flex items-center">
          <button
            type="button"
            className={iconBtn}
            title={t("calendar:prevTitle")}
            aria-label={t("calendar:prevAria")}
            onClick={() => page(-1)}
          >
            <CalIcon name="chevronLeft" size={16} />
          </button>
          <button
            type="button"
            className={iconBtn}
            title={t("calendar:nextTitle")}
            aria-label={t("calendar:nextAria")}
            onClick={() => page(1)}
          >
            <CalIcon name="chevronRight" size={16} />
          </button>
        </div>
        <h1 className="truncate text-[17px] font-semibold text-ink">{heading}</h1>
        <div className="grow" />
        {/* Day | Week | Month (`d` / `w` / `m`) */}
        <div className="flex items-center rounded-lg bg-bg2 p-0.5" role="tablist">
          {(["day", "week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              title={t(`calendar:${v}Title`)}
              className={`h-6 rounded-md px-3 text-[12px] font-medium ${
                view === v
                  ? "bg-bg1 text-ink shadow-[var(--elev-1)]"
                  : "text-ink-muted hover:text-ink"
              }`}
              onClick={() => set({ calendarView: v })}
            >
              {t(`calendar:${v}`)}
            </button>
          ))}
        </div>
        {!sidebar && (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-white hover:brightness-110"
            onClick={() => set({ eventCreate: {} })}
          >
            <CalIcon name="plus" size={14} />
            {t("calendar:newEvent")}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebar && <CalendarSidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg1">
          {view === "month" ? (
            <MonthView anchor={anchor} weekStartsOn={weekStartsOn} />
          ) : (
            <TimeGrid days={days} />
          )}
        </div>
      </div>
    </div>
  );
}

function headingFor(view: CalendarView, anchor: number, days: number[]): string {
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) =>
    new Date(ms).toLocaleDateString(i18n.language, o);
  if (view === "day") {
    return fmt(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  if (view === "month") return fmt(startOfMonth(anchor), { month: "long", year: "numeric" });
  const first = days[0];
  const last = days[days.length - 1];
  if (new Date(first).getMonth() === new Date(last).getMonth()) {
    return fmt(first, { month: "long", year: "numeric" });
  }
  const sameYear = new Date(first).getFullYear() === new Date(last).getFullYear();
  return `${fmt(first, sameYear ? { month: "short" } : { month: "short", year: "numeric" })} – ${fmt(last, { month: "short", year: "numeric" })}`;
}
