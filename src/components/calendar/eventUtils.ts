// Event predicates and labels shared by every calendar surface (week/day grid,
// month view, drawer, detail popover, invite card).

import i18n from "../../i18n";
import type { CalendarEvent } from "../../ipc/types";
import { DAY_MS } from "../../lib/calendarGrid";

/** Default length of an event without an end time. */
export const DEFAULT_EVENT_MS = 30 * 60_000;

export function isCancelled(ev: CalendarEvent): boolean {
  return ev.status?.toUpperCase() === "CANCELLED" || ev.method?.toUpperCase() === "CANCEL";
}

/** Local events we organize can be dragged/resized; invites are read-only. */
export function isDraggable(ev: CalendarEvent): boolean {
  return ev.isLocal && !isCancelled(ev) && !ev.allDay;
}

export function eventEnd(ev: CalendarEvent): number {
  return ev.endsAt ?? ev.startsAt + DEFAULT_EVENT_MS;
}

export type RsvpKind = "accepted" | "tentative" | "declined" | "needs";

/** Our response to an invite; null for events we organize (nothing to answer). */
export function rsvpKind(ev: CalendarEvent): RsvpKind | null {
  if (ev.isLocal) return null;
  switch (ev.rsvpStatus?.toUpperCase()) {
    case "ACCEPTED":
      return "accepted";
    case "TENTATIVE":
      return "tentative";
    case "DECLINED":
      return "declined";
    default:
      return "needs";
  }
}

export const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const timeRange = (start: number, end: number) =>
  `${timeLabel(start)} – ${timeLabel(end)}`;

/** Bucket events into each day they overlap (multi-day events land in every
 *  day they touch). Days with no events map to []. */
export function groupByDay(
  events: readonly CalendarEvent[],
  days: readonly number[],
): Map<number, CalendarEvent[]> {
  const map = new Map<number, CalendarEvent[]>();
  for (const day of days) map.set(day, []);
  for (const ev of events) {
    const end = eventEnd(ev);
    for (const day of days) {
      if (ev.startsAt < day + DAY_MS && end > day) map.get(day)!.push(ev);
    }
  }
  return map;
}

/** Drop cancelled events that overlap a live one: a rescheduled or replaced
 *  meeting shouldn't squeeze its replacement into half a column. Cancelled
 *  events with the slot to themselves stay visible (struck through). */
export function withoutShadowedCancels(events: readonly CalendarEvent[]): CalendarEvent[] {
  const live = events.filter((e) => !isCancelled(e));
  return events.filter(
    (e) =>
      !isCancelled(e) ||
      !live.some((l) => l.startsAt < eventEnd(e) && eventEnd(l) > e.startsAt),
  );
}

/** i18n key for a short recurrence label from an RRULE's FREQ (generic for
 *  rules we don't spell out, so any repeat is still surfaced). */
export function recurrenceKey(rrule: string | null): string | null {
  if (!rrule) return null;
  switch (/FREQ=([A-Z]+)/i.exec(rrule)?.[1]?.toUpperCase()) {
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
