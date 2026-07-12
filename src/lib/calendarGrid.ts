// Pure date/geometry helpers for the calendar surfaces (week grid, month
// view, drag interactions, anchored popovers). No React, no stores — all of
// this is unit-tested in calendarGrid.test.ts.

import type { CalendarEvent } from "../ipc/types";

export const DAY_MS = 86_400_000;
/** Pixel height of one hour in the week grid. */
export const HOUR_PX = 48;
/** Width of the hour-label gutter left of the day columns. */
export const GUTTER_PX = 56;

/** Round minutes to the nearest `step` (default 15-minute grid). */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

/** Grid-content y (px from 00:00) → ms epoch within `dayStart`'s day. */
export function yToMs(y: number, dayStart: number, hourPx = HOUR_PX): number {
  const minutes = Math.max(0, Math.min((y / hourPx) * 60, 24 * 60));
  return dayStart + minutes * 60_000;
}

/** ms epoch → grid-content y (px from 00:00 of `dayStart`). */
export function msToY(ms: number, dayStart: number, hourPx = HOUR_PX): number {
  return ((ms - dayStart) / 3_600_000) * hourPx;
}

export function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday-based week start (00:00 of the week's Monday). */
export function startOfWeekMs(ms: number): number {
  const d = new Date(startOfDayMs(ms));
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 00:00 on the first of the month containing `ms`. */
export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Same day-of-month `delta` months away, clamped (Jan 31 +1mo → Feb 28/29). */
export function addMonths(ms: number, delta: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  const daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTarget));
  return d.getTime();
}

/** The 42 day-start timestamps (6 Monday-based weeks) covering `ms`'s month. */
export function monthGridDays(ms: number): number[] {
  const first = startOfMonth(ms);
  const gridStart = startOfWeekMs(first);
  const days: number[] = [];
  const d = new Date(gridStart);
  for (let i = 0; i < 42; i++) {
    days.push(d.getTime());
    d.setDate(d.getDate() + 1); // Date-field steps survive DST transitions
  }
  return days;
}

/**
 * Shift an event by whole days and/or minutes, preserving wall-clock times
 * across DST transitions (a 09:00 meeting moved +1 day is still 09:00 even if
 * the clocks changed that night). Start and end shift independently so the
 * wall-clock duration is preserved too.
 */
export function shiftEvent(
  startsAt: number,
  endsAt: number,
  dayDelta: number,
  minuteDelta: number,
): { startsAt: number; endsAt: number } {
  const shift = (ms: number) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + dayDelta);
    d.setMinutes(d.getMinutes() + minuteDelta);
    return d.getTime();
  };
  return { startsAt: shift(startsAt), endsAt: shift(endsAt) };
}

// ---------------------------------------------------------------- popover

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Position a popover of `size` next to `anchor` inside `viewport`: prefer the
 * anchor's right side, flip to the left when it would overflow, and clamp both
 * axes to stay `margin` px inside the viewport.
 */
export function placePopover(
  anchor: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 8,
): { left: number; top: number } {
  let left = anchor.x + anchor.w + margin;
  if (left + size.w > viewport.w - margin) left = anchor.x - margin - size.w;
  left = Math.max(margin, Math.min(left, viewport.w - margin - size.w));

  let top = anchor.y;
  if (top + size.h > viewport.h - margin) top = viewport.h - margin - size.h;
  top = Math.max(margin, top);

  return { left, top };
}

// ---------------------------------------------------------------- layout

export interface Positioned {
  ev: CalendarEvent;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/** Assign overlapping events to side-by-side lanes within one day column. */
export function layoutDay(events: CalendarEvent[], dayStart: number): Positioned[] {
  const timed = events
    .filter((e) => !e.allDay)
    .map((e) => {
      const start = Math.max(e.startsAt, dayStart);
      const end = Math.min(e.endsAt ?? e.startsAt + 30 * 60_000, dayStart + DAY_MS);
      return { e, start, end: Math.max(end, start + 15 * 60_000) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const laneEnds: number[] = [];
  const placed = timed.map(({ e, start, end }) => {
    let lane = laneEnds.findIndex((le) => le <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = end;
    return { e, start, end, lane };
  });

  return placed.map(({ e, start, end, lane }) => {
    // Width divisor = max lanes among events this one overlaps.
    const lanes = placed
      .filter((o) => o.start < end && o.end > start)
      .reduce((m, o) => Math.max(m, o.lane + 1), 1);
    const minutes = (ms: number) => (ms - dayStart) / 60_000;
    return {
      ev: e,
      top: (minutes(start) / 60) * HOUR_PX,
      height: Math.max(((end - start) / 3_600_000) * HOUR_PX, 18),
      lane,
      lanes,
    };
  });
}
