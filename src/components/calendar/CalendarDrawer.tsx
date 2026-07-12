import { openUrl } from "@tauri-apps/plugin-opener";
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

/** Right-side calendar peek: `0` = today, `2` = next 7 days. `-`/`=` page
 *  through days/weeks, `t` snaps back to today, `+` creates an event. */
export function CalendarDrawer() {
  const { t } = useTranslation();
  const mode = useUi((s) => s.calendarDrawer);
  const focusDay = useUi((s) => s.calendarFocusDay);
  const set = useUi((s) => s.set);

  const todayStart = startOfToday();
  const anchor = focusDay ?? todayStart;
  const spanDays = mode === "week" ? 7 : 1;
  const rangeEnd = anchor + spanDays * DAY_MS;
  const { data: events, isLoading } = useCalendarEvents(anchor, rangeEnd, mode != null);

  const byDay = useMemo(() => {
    const groups = new Map<number, CalendarEvent[]>();
    for (const ev of events ?? []) {
      const d = new Date(ev.startsAt);
      d.setHours(0, 0, 0, 0);
      const key = Math.max(d.getTime(), anchor);
      const list = groups.get(key) ?? [];
      list.push(ev);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [events, anchor]);

  if (!mode) return null;

  const shift = (dir: 1 | -1) =>
    set({ calendarFocusDay: anchor + dir * spanDays * DAY_MS });

  const heading =
    mode === "day"
      ? dayHeading(anchor, todayStart)
      : anchor === todayStart
        ? t("calendar:thisWeek")
        : `${new Date(anchor).toLocaleDateString(i18n.language, { month: "short", day: "numeric" })} – ${new Date(rangeEnd - DAY_MS).toLocaleDateString(i18n.language, { month: "short", day: "numeric" })}`;

  return (
    <aside
      data-testid="calendar-drawer"
      className="co-fade-in fixed top-10 right-0 bottom-0 z-30 flex w-[360px] flex-col border-l border-hairline bg-bg1"
      style={{ boxShadow: "var(--elev-2)" }}
    >
      <header className="co-hairline-b flex shrink-0 items-center justify-between px-4 py-3">
        <div className="flex min-w-0 items-center gap-1">
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => shift(-1)}
            aria-label={t("calendar:prevAria")}
            title="-"
          >
            ‹
          </button>
          <h2 className="truncate text-[14px] font-semibold text-ink">{heading}</h2>
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => shift(1)}
            aria-label={t("calendar:nextAria")}
            title="="
          >
            ›
          </button>
          {anchor !== todayStart && (
            <button
              className="ml-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent hover:bg-bg2"
              onClick={() => set({ calendarFocusDay: null })}
              title="t"
            >
              {t("calendar:today")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => set({ eventCreate: {} })}
            aria-label={t("calendar:createAria")}
            title={t("calendar:createAria")}
          >
            +
          </button>
          <span className="text-[11.5px] text-ink-faint">
            {mode === "day" ? t("calendar:hintWeek") : t("calendar:hintToday")} · {t("calendar:escCloses")}
          </span>
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => set({ calendarDrawer: null, calendarFocusDay: null })}
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
                    {dayHeading(day, todayStart)}
                  </h3>
                )}
                <div className="flex flex-col gap-1.5">
                  {list.map((ev) => (
                    <EventRow key={`${ev.id}:${ev.startsAt}`} event={ev} />
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

function rsvpBadge(ev: CalendarEvent): { label: string; cls: string } | null {
  switch (ev.rsvpStatus?.toUpperCase()) {
    case "ACCEPTED":
      return { label: i18n.t("calendar:rsvp.yes"), cls: "text-accent" };
    case "TENTATIVE":
      return { label: i18n.t("calendar:rsvp.maybe"), cls: "text-ink-faint" };
    case "DECLINED":
      return { label: i18n.t("calendar:rsvp.no"), cls: "text-danger" };
    default:
      return null;
  }
}

function EventRow({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const cancelled = isCancelled(event);
  const badge = rsvpBadge(event);
  const openDetail = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    set({
      eventDetail: { event, anchor: { x: r.x, y: r.y, w: r.width, h: r.height } },
    });
  };
  return (
    <div
      className={`flex cursor-pointer gap-3 rounded-lg border border-hairline bg-bg0 px-3 py-2 hover:bg-bg2/60 ${
        cancelled ? "opacity-60" : ""
      }`}
      onClick={openDetail}
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
          {!cancelled && badge && (
            <span className={`ml-1.5 align-middle text-[10px] font-semibold tracking-wide uppercase ${badge.cls}`}>
              {badge.label}
            </span>
          )}
        </div>
        {event.location && !event.location.startsWith("http") && (
          <div className="truncate text-[11.5px] text-ink-faint">{event.location}</div>
        )}
        {event.organizer && (
          <div className="truncate text-[11.5px] text-ink-faint">{t("calendar:byOrganizer", { organizer: event.organizer })}</div>
        )}
      </div>
      {event.joinUrl && !cancelled && (
        <button
          type="button"
          className="h-fit shrink-0 self-center rounded-md border border-accent/50 px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent/10"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(event.joinUrl!);
          }}
        >
          {t("calendar:join")}
        </button>
      )}
    </div>
  );
}
