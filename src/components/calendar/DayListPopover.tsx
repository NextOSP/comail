import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { DAY_MS, placePopover } from "../../lib/calendarGrid";
import { useVisibleCalendarEvents } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { tint, useEventHex } from "./calendarColor";
import { eventEnd, isCancelled, rsvpKind, timeRange } from "./eventUtils";
import { CalIcon } from "./icons";

const WIDTH = 280;

/** Every event of one month-view day ("+N more"), anchored beside the cell.
 *  Rows open the event-detail popover. Store-driven; Esc handled globally. */
export function DayListPopover() {
  const { t } = useTranslation();
  const state = useUi((s) => s.calendarDayList);
  const set = useUi((s) => s.set);
  const hexFor = useEventHex();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const day = state?.day ?? 0;
  const { data: events } = useVisibleCalendarEvents(day, day + DAY_MS, state != null);
  const list = useMemo(
    () =>
      (events ?? [])
        .filter((ev) => ev.startsAt < day + DAY_MS && eventEnd(ev) > day)
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt),
    [events, day],
  );

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!state || !el) {
      setPos(null);
      return;
    }
    setPos(
      placePopover(
        state.anchor,
        { w: WIDTH, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [state, list.length]);

  if (!state) return null;
  const close = () => set({ calendarDayList: null });
  const date = new Date(day);

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={close} />
      <div
        ref={cardRef}
        role="dialog"
        aria-label={date.toLocaleDateString(i18n.language, { dateStyle: "full" })}
        className="co-pop-in fixed z-40 flex max-h-[70vh] flex-col rounded-xl border border-hairline bg-bg1"
        style={{
          width: WIDTH,
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos ? "visible" : "hidden",
          boxShadow: "var(--elev-2)",
        }}
        data-testid="calendar-day-list"
      >
        <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
              {date.toLocaleDateString(i18n.language, { weekday: "long" })}
            </div>
            <div className="text-[13px] font-semibold text-ink">
              {date.toLocaleDateString(i18n.language, { month: "long", day: "numeric" })}
              <span className="ml-1.5 font-normal text-ink-faint">
                {t("calendar:nEvents", { count: list.length })}
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common:action.close")}
            title={t("common:action.close")}
            className="flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={close}
          >
            <CalIcon name="close" size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {list.map((ev) => {
            const hex = hexFor(ev);
            const cancelled = isCancelled(ev);
            const declined = rsvpKind(ev) === "declined";
            const when = ev.allDay ? t("calendar:allDay") : timeRange(ev.startsAt, eventEnd(ev));
            const title = ev.summary ?? t("calendar:noTitle");
            return (
              <button
                key={`${ev.id}:${ev.startsAt}`}
                type="button"
                aria-label={`${title}, ${when}`}
                className={`flex w-full items-stretch gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-bg2 ${
                  cancelled ? "opacity-60" : declined ? "opacity-50" : ""
                }`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  set({
                    calendarDayList: null,
                    eventDetail: {
                      event: ev,
                      anchor: { x: r.x, y: r.y, w: r.width, h: r.height },
                    },
                  });
                }}
              >
                <span
                  className="w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: tint(hex) }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[12.5px] font-medium text-ink ${
                      cancelled ? "line-through" : ""
                    }`}
                  >
                    {title}
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-faint tabular-nums">
                    {when}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
