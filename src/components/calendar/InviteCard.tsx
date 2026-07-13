import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { CalendarEvent, RsvpResponse } from "../../ipc/types";
import { hasConflict } from "../../lib/availability";
import { useCalendarEvents, useMessageEvents, useRsvpEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short, human recurrence label from an RRULE's FREQ (falls back to generic
 *  for rules we don't spell out, so any repeat is still surfaced). */
function recurrenceKey(rrule: string | null): string | null {
  if (!rrule) return null;
  const freq = /FREQ=([A-Z]+)/i.exec(rrule)?.[1]?.toUpperCase();
  switch (freq) {
    case "DAILY":
      return "calendar:recurrence.daily";
    case "WEEKLY":
      return "calendar:recurrence.weekly";
    case "MONTHLY":
      return "calendar:recurrence.monthly";
    case "YEARLY":
      return "calendar:recurrence.yearly";
    default:
      return "calendar:recurrence.generic";
  }
}

function whenLabel(ev: CalendarEvent): string {
  const day = new Date(ev.startsAt).toLocaleDateString(i18n.language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (ev.allDay) return day;
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hour12: false });
  return ev.endsAt != null
    ? `${day} · ${time(ev.startsAt)} – ${time(ev.endsAt)}`
    : `${day} · ${time(ev.startsAt)}`;
}

/** Native invite card rendered above the message body for messages carrying
 *  a text/calendar part: event details, conflict warning, join link, and
 *  one-keypress RSVP that emails an ICS reply to the organizer. */
export function InviteCard({ messageId }: { messageId: number }) {
  const { data: events } = useMessageEvents(messageId);
  if (!events || events.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      {events.map((ev) => (
        <InviteEvent key={ev.id} event={ev} />
      ))}
    </div>
  );
}

function InviteEvent({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const rsvp = useRsvpEvent();
  const [expanded, setExpanded] = useState(false);

  const recurrence = recurrenceKey(event.rrule);
  const description = event.description?.trim() || null;
  // The card normally shows the first six attendees; expanding reveals the rest
  // alongside the full description, so a long invite stays compact by default.
  const hasMoreAttendees = event.attendees.length > 6;
  const hasDetails = Boolean(description) || hasMoreAttendees;
  const shownAttendees = expanded ? event.attendees : event.attendees.slice(0, 6);

  const cancelled =
    event.status?.toUpperCase() === "CANCELLED" || event.method?.toUpperCase() === "CANCEL";
  const isReply = event.method?.toUpperCase() === "REPLY";

  // Superhuman-style auto-peek: seeing an invite opens that day's schedule
  // alongside, so conflicts are visible while deciding.
  useEffect(() => {
    if (cancelled || isReply) return;
    useUi.getState().set({ calendarDrawer: "day", calendarFocusDay: startOfDay(event.startsAt) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // Conflict check against everything else on the calendar that day.
  const dayStart = startOfDay(event.startsAt);
  const { data: dayEvents } = useCalendarEvents(dayStart, dayStart + DAY_MS, !event.allDay);
  const others = (dayEvents ?? []).filter((e) => e.id !== event.id);
  const conflict =
    !event.allDay &&
    hasConflict(others, event.startsAt, event.endsAt ?? event.startsAt + 30 * 60_000);

  const answer = (response: RsvpResponse) => {
    rsvp.mutate(
      { eventId: event.id, response },
      {
        onSuccess: () => pushToast({ message: t(`calendar:rsvpSent.${response}`), kind: "info" }),
        onError: (e) => pushToast({ message: errorMessage(e), kind: "error" }),
      },
    );
  };

  const current = event.rsvpStatus?.toUpperCase() ?? null;
  const options: { response: RsvpResponse; status: string; labelKey: string }[] = [
    { response: "accepted", status: "ACCEPTED", labelKey: "calendar:rsvp.yes" },
    { response: "tentative", status: "TENTATIVE", labelKey: "calendar:rsvp.maybe" },
    { response: "declined", status: "DECLINED", labelKey: "calendar:rsvp.no" },
  ];

  return (
    <div
      data-testid="invite-card"
      className={`rounded-lg border border-accent/30 bg-bg0 px-4 py-3 ${cancelled ? "opacity-70" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 flex-col items-center justify-center rounded-md border border-hairline bg-bg1">
          <span className="text-[8px] font-semibold tracking-wide text-danger uppercase">
            {new Date(event.startsAt).toLocaleDateString(i18n.language, { month: "short" })}
          </span>
          <span className="text-[14px] leading-none font-bold text-ink tabular-nums">
            {new Date(event.startsAt).getDate()}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">
            <span className={cancelled ? "line-through" : ""}>
              {event.summary ?? t("calendar:noTitle")}
            </span>
            {cancelled && (
              <span className="ml-2 text-[10px] font-semibold tracking-wide text-danger uppercase">
                {t("calendar:cancelled")}
              </span>
            )}
          </div>
          <div className="text-[12px] text-ink-muted">{whenLabel(event)}</div>
          {event.location && !event.location.startsWith("http") && (
            <div className="truncate text-[12px] text-ink-faint">{event.location}</div>
          )}
          {event.organizer && (
            <div className="truncate text-[12px] text-ink-faint">
              {t("calendar:byOrganizer", { organizer: event.organizer })}
            </div>
          )}
          {recurrence && (
            <div className="text-[12px] text-ink-faint">{t(recurrence)}</div>
          )}
          {event.attendees.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {shownAttendees.map((a) => (
                <span key={a.email} className="co-chip" title={a.email}>
                  {a.partstat === "ACCEPTED" ? "✓ " : a.partstat === "DECLINED" ? "✗ " : ""}
                  {a.name ?? a.email}
                </span>
              ))}
              {!expanded && hasMoreAttendees && (
                <span className="co-chip">+{event.attendees.length - 6}</span>
              )}
            </div>
          )}
          {expanded && description && (
            <div className="mt-2">
              <div className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("calendar:descriptionLabel")}
              </div>
              <p className="mt-0.5 max-h-40 overflow-auto text-[12px] leading-[1.5] whitespace-pre-wrap text-ink-muted select-text">
                {description}
              </p>
            </div>
          )}
          {hasDetails && (
            <button
              type="button"
              className="mt-1 text-[11.5px] font-medium text-accent hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {t(expanded ? "calendar:hideDetails" : "calendar:showDetails")}
            </button>
          )}
          {conflict && !cancelled && (
            <div className="mt-1 text-[11.5px] font-medium text-danger">
              {t("calendar:conflict")}
            </div>
          )}
        </div>
        {event.joinUrl && !cancelled && (
          <button
            type="button"
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90"
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(event.joinUrl!);
            }}
          >
            {t("calendar:join")}
          </button>
        )}
      </div>

      {!cancelled && !isReply && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className="mr-1 text-[11.5px] text-ink-faint">{t("calendar:going")}</span>
          {options.map((o) => (
            <button
              key={o.response}
              type="button"
              disabled={rsvp.isPending}
              className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                current === o.status
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-hairline text-ink-muted hover:bg-bg2 hover:text-ink"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                answer(o.response);
              }}
            >
              {t(o.labelKey)}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto text-[11.5px] text-ink-faint hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              set({
                calendarDrawer: "day",
                calendarFocusDay: startOfDay(event.startsAt),
              });
            }}
          >
            {t("calendar:viewDay")}
          </button>
        </div>
      )}
    </div>
  );
}
