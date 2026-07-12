/** Free-slot computation for "Share availability": intersect working hours
 *  with the local calendar and emit insertable HTML/text. */

import type { CalendarEvent } from "../ipc/types";

export interface Slot {
  start: number;
  end: number;
}

export interface SlotOptions {
  /** ms epoch to search from (slots strictly in the future of this). */
  now: number;
  /** how many days ahead to scan */
  days: number;
  /** working window, local hours */
  dayStartHour: number;
  dayEndHour: number;
  /** slot length, minutes */
  durationMin: number;
  /** cap per day so the email stays short */
  maxPerDay: number;
  /** skip Saturday/Sunday */
  skipWeekends: boolean;
}

export const DEFAULT_SLOT_OPTIONS: Omit<SlotOptions, "now"> = {
  days: 5,
  dayStartHour: 9,
  dayEndHour: 17,
  durationMin: 30,
  maxPerDay: 3,
  skipWeekends: true,
};

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** True when [start,end) collides with any busy (non-cancelled, non-declined,
 *  non-all-day) event. */
export function hasConflict(events: CalendarEvent[], start: number, end: number): boolean {
  return events.some((ev) => {
    if (ev.allDay) return false;
    if (ev.status?.toUpperCase() === "CANCELLED") return false;
    if (ev.rsvpStatus?.toUpperCase() === "DECLINED") return false;
    const evEnd = ev.endsAt ?? ev.startsAt + 30 * 60_000;
    return ev.startsAt < end && evEnd > start;
  });
}

/** Free slots over the coming days, aligned to :00/:30 boundaries. */
export function computeFreeSlots(events: CalendarEvent[], opts: SlotOptions): Slot[] {
  const { now, days, dayStartHour, dayEndHour, durationMin, maxPerDay, skipWeekends } = opts;
  const out: Slot[] = [];
  const stepMs = 30 * 60_000;
  const durMs = durationMin * 60_000;

  for (let d = 0; d < days; d++) {
    const dayStart = startOfDay(now) + d * DAY_MS;
    const weekday = new Date(dayStart).getDay();
    if (skipWeekends && (weekday === 0 || weekday === 6)) continue;

    const windowStart = dayStart + dayStartHour * 3_600_000;
    const windowEnd = dayStart + dayEndHour * 3_600_000;
    let taken = 0;
    for (let t = windowStart; t + durMs <= windowEnd && taken < maxPerDay; t += stepMs) {
      if (t <= now) continue;
      if (hasConflict(events, t, t + durMs)) continue;
      // Keep suggestions spread out: skip slots overlapping one already chosen.
      const last = out[out.length - 1];
      if (last && last.end > t) continue;
      out.push({ start: t, end: t + durMs });
      taken++;
    }
  }
  return out;
}

function groupByDay(slots: Slot[]): Map<number, Slot[]> {
  const groups = new Map<number, Slot[]>();
  for (const s of slots) {
    const key = startOfDay(s.start);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return groups;
}

function fmtDay(ms: number, locale: string): string {
  return new Date(ms).toLocaleDateString(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

function tzName(locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts();
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** "Would any of these times work? (all times CET)" + a per-day list, as
 *  email-safe HTML (inline tags only). */
export function formatSlotsHtml(slots: Slot[], locale: string, leadIn: string): string {
  const tz = tzName(locale);
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = `<div>${esc(leadIn)}${tz ? ` <span style="color:#888">(${esc(tz)})</span>` : ""}</div><ul>`;
  for (const [day, list] of groupByDay(slots)) {
    const times = list
      .map((s) => `${fmtTime(s.start, locale)} – ${fmtTime(s.end, locale)}`)
      .join(", ");
    html += `<li><b>${esc(fmtDay(day, locale))}</b>: ${esc(times)}</li>`;
  }
  html += "</ul>";
  return html;
}

/** Plain-text rendering of the same list (text/plain fallback). */
export function formatSlotsText(slots: Slot[], locale: string, leadIn: string): string {
  const tz = tzName(locale);
  const lines = [`${leadIn}${tz ? ` (${tz})` : ""}`, ""];
  for (const [day, list] of groupByDay(slots)) {
    const times = list
      .map((s) => `${fmtTime(s.start, locale)} – ${fmtTime(s.end, locale)}`)
      .join(", ");
    lines.push(`- ${fmtDay(day, locale)}: ${times}`);
  }
  return lines.join("\n");
}
