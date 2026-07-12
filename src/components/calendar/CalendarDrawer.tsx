import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import { useCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

const DAY_MS = 86_400_000;

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dayHeading(dayStart: number, todayStart: number): string {
  if (dayStart === todayStart) return i18n.t("calendar:today");
  if (dayStart === todayStart + DAY_MS) return i18n.t("calendar:tomorrow");
  return new Date(dayStart).toLocaleDateString(i18n.language, { weekday: "long", month: "short", day: "numeric" });
}

function isCancelled(ev: CalendarEvent): boolean {
  return ev.status?.toUpperCase() === "CANCELLED" || ev.method?.toUpperCase() === "CANCEL";
}

/** Right-side calendar peek: `0` = today, `2` = next 7 days. */
export function CalendarDrawer() {
  const { t } = useTranslation();
  const mode = useUi((s) => s.calendarDrawer);
  const set = useUi((s) => s.set);

  const dayStart = startOfToday();
  const rangeEnd = mode === "week" ? dayStart + 7 * DAY_MS : dayStart + DAY_MS;
  const { data: events, isLoading } = useCalendarEvents(dayStart, rangeEnd, mode != null);

  const byDay = useMemo(() => {
    const groups = new Map<number, CalendarEvent[]>();
    for (const ev of events ?? []) {
      const d = new Date(ev.startsAt);
      d.setHours(0, 0, 0, 0);
      const key = Math.max(d.getTime(), dayStart);
      const list = groups.get(key) ?? [];
      list.push(ev);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [events, dayStart]);

  if (!mode) return null;

  return (
    <aside
      data-testid="calendar-drawer"
      className="co-fade-in fixed inset-y-0 right-0 z-30 flex w-[360px] flex-col border-l border-hairline bg-bg1 pt-10"
      style={{ boxShadow: "var(--elev-2)" }}
    >
      <header className="co-hairline-b flex shrink-0 items-center justify-between px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink">
          {mode === "day" ? t("calendar:today") : t("calendar:thisWeek")}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-ink-faint">
            {mode === "day" ? t("calendar:hintWeek") : t("calendar:hintToday")} · {t("calendar:escCloses")}
          </span>
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => set({ calendarDrawer: null })}
            aria-label={t("calendar:closeAria")}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <p className="py-6 text-center text-[12.5px] text-ink-faint">{t("common:loading")}</p>
        ) : byDay.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-faint">
            {mode === "day" ? t("calendar:noEventsToday") : t("calendar:noEventsWeek")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {byDay.map(([day, list]) => (
              <section key={day}>
                {mode === "week" && (
                  <h3 className="mb-1.5 text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                    {dayHeading(day, dayStart)}
                  </h3>
                )}
                <div className="flex flex-col gap-1.5">
                  {list.map((ev) => (
                    <EventRow key={ev.id} event={ev} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const cancelled = isCancelled(event);
  return (
    <div
      className={`flex gap-3 rounded-lg border border-hairline bg-bg0 px-3 py-2 ${
        cancelled ? "opacity-60" : ""
      }`}
    >
      <div className="w-[52px] shrink-0 pt-px text-right">
        {event.allDay ? (
          <span className="text-[11px] font-medium text-accent">{t("calendar:allDay")}</span>
        ) : (
          <>
            <div className="text-[12px] font-medium text-ink tabular-nums">
              {timeLabel(event.startsAt)}
            </div>
            {event.endsAt != null && (
              <div className="text-[11px] text-ink-faint tabular-nums">{timeLabel(event.endsAt)}</div>
            )}
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">
          <span className={cancelled ? "line-through" : ""}>{event.summary ?? t("calendar:noTitle")}</span>
          {cancelled && (
            <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-danger uppercase">
              {t("calendar:cancelled")}
            </span>
          )}
        </div>
        {event.location && (
          <div className="truncate text-[11.5px] text-ink-faint">{event.location}</div>
        )}
        {event.organizer && (
          <div className="truncate text-[11.5px] text-ink-faint">{t("calendar:byOrganizer", { organizer: event.organizer })}</div>
        )}
      </div>
    </div>
  );
}
