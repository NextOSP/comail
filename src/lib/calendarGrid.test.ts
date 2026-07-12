import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../ipc/types";
import {
  addMonths,
  DAY_MS,
  HOUR_PX,
  layoutDay,
  monthGridDays,
  msToY,
  placePopover,
  shiftEvent,
  snapMinutes,
  startOfDayMs,
  startOfMonth,
  startOfWeekMs,
  yToMs,
} from "./calendarGrid";

// Fixed reference: Friday 2026-07-10 (local time), matching quickadd tests.
const FRI = new Date(2026, 6, 10, 0, 0, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

describe("snapMinutes", () => {
  it("rounds to the nearest 15-minute step", () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(22)).toBe(15);
    expect(snapMinutes(23)).toBe(30);
    expect(snapMinutes(52)).toBe(45);
    expect(snapMinutes(53)).toBe(60);
  });

  it("honours a custom step", () => {
    expect(snapMinutes(40, 30)).toBe(30);
    expect(snapMinutes(46, 30)).toBe(60);
  });
});

describe("yToMs / msToY", () => {
  it("maps pixels to time and back", () => {
    const nineThirty = FRI + 9.5 * 3_600_000;
    const y = msToY(nineThirty, FRI);
    expect(y).toBe(9.5 * HOUR_PX);
    expect(yToMs(y, FRI)).toBe(nineThirty);
  });

  it("clamps to the day's bounds", () => {
    expect(yToMs(-50, FRI)).toBe(FRI);
    expect(yToMs(25 * HOUR_PX, FRI)).toBe(FRI + DAY_MS);
  });
});

describe("startOfDayMs / startOfWeekMs / startOfMonth", () => {
  it("floors to local midnight", () => {
    expect(startOfDayMs(at(2026, 6, 10, 14, 37))).toBe(FRI);
  });

  it("finds the Monday of the week", () => {
    expect(startOfWeekMs(FRI)).toBe(at(2026, 6, 6)); // Mon Jul 6
    expect(startOfWeekMs(at(2026, 6, 6, 5))).toBe(at(2026, 6, 6)); // Monday stays
    expect(startOfWeekMs(at(2026, 6, 12, 23))).toBe(at(2026, 6, 6)); // Sunday belongs to the same week
  });

  it("finds the first of the month", () => {
    expect(startOfMonth(at(2026, 6, 31, 12))).toBe(at(2026, 6, 1));
    expect(startOfMonth(at(2026, 6, 1))).toBe(at(2026, 6, 1));
  });
});

describe("addMonths", () => {
  it("moves whole months keeping the day", () => {
    expect(addMonths(at(2026, 6, 10), 1)).toBe(at(2026, 7, 10));
    expect(addMonths(at(2026, 6, 10), -1)).toBe(at(2026, 5, 10));
  });

  it("clamps the day-of-month (Jan 31 → Feb 28)", () => {
    expect(addMonths(at(2026, 0, 31), 1)).toBe(at(2026, 1, 28));
    expect(addMonths(at(2024, 0, 31), 1)).toBe(at(2024, 1, 29)); // leap year
    expect(addMonths(at(2026, 2, 31), -1)).toBe(at(2026, 1, 28));
  });

  it("crosses year boundaries", () => {
    expect(addMonths(at(2026, 11, 15), 1)).toBe(at(2027, 0, 15));
    expect(addMonths(at(2026, 0, 15), -1)).toBe(at(2025, 11, 15));
  });
});

describe("monthGridDays", () => {
  it("returns 42 cells starting on a Monday", () => {
    const days = monthGridDays(at(2026, 6, 10));
    expect(days).toHaveLength(42);
    expect(days[0]).toBe(at(2026, 5, 29)); // Mon Jun 29 (Jul 1 2026 is a Wednesday)
    expect(new Date(days[0]).getDay()).toBe(1);
    for (const d of days) expect(new Date(d).getHours()).toBe(0);
  });

  it("covers every day of the month exactly once", () => {
    const days = monthGridDays(at(2026, 6, 10));
    const inJuly = days.filter((d) => new Date(d).getMonth() === 6);
    expect(inJuly).toHaveLength(31);
    expect(inJuly[0]).toBe(at(2026, 6, 1));
    expect(inJuly[30]).toBe(at(2026, 6, 31));
  });

  it("consecutive cells are consecutive days", () => {
    const days = monthGridDays(at(2026, 2, 15)); // March: DST month in many zones
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1]);
      prev.setDate(prev.getDate() + 1);
      expect(days[i]).toBe(prev.getTime());
    }
  });

  it("starts a month whose 1st is a Monday on that day", () => {
    const days = monthGridDays(at(2026, 5, 10)); // June 1 2026 is a Monday
    expect(days[0]).toBe(at(2026, 5, 1));
  });
});

describe("shiftEvent", () => {
  it("shifts by days preserving the wall-clock time", () => {
    const start = at(2026, 6, 10, 9, 0);
    const end = at(2026, 6, 10, 10, 30);
    const r = shiftEvent(start, end, 3, 0);
    expect(new Date(r.startsAt).getHours()).toBe(9);
    expect(new Date(r.startsAt).getDate()).toBe(13);
    expect(new Date(r.endsAt).getHours()).toBe(10);
    expect(new Date(r.endsAt).getMinutes()).toBe(30);
  });

  it("shifts by minutes", () => {
    const start = at(2026, 6, 10, 9, 0);
    const end = at(2026, 6, 10, 9, 45);
    const r = shiftEvent(start, end, 0, 75);
    expect(r.startsAt).toBe(at(2026, 6, 10, 10, 15));
    expect(r.endsAt).toBe(at(2026, 6, 10, 11, 0));
  });

  it("combines day and minute deltas (drag across days)", () => {
    const start = at(2026, 6, 10, 14, 0);
    const end = at(2026, 6, 10, 15, 0);
    const r = shiftEvent(start, end, -2, -30);
    expect(r.startsAt).toBe(at(2026, 6, 8, 13, 30));
    expect(r.endsAt).toBe(at(2026, 6, 8, 14, 30));
  });

  it("keeps wall-clock times across many days (DST-safe by construction)", () => {
    // Whatever the local zone does in between, field-based shifting must land
    // on the same local clock time N days later.
    const start = at(2026, 2, 27, 9, 0); // spans EU/US spring DST windows
    const end = at(2026, 2, 27, 9, 30);
    const r = shiftEvent(start, end, 7, 0);
    const s = new Date(r.startsAt);
    expect([s.getHours(), s.getMinutes(), s.getDate()]).toEqual([9, 0, 3]);
    const e = new Date(r.endsAt);
    expect([e.getHours(), e.getMinutes()]).toEqual([9, 30]);
  });
});

describe("placePopover", () => {
  const viewport = { w: 1000, h: 800 };
  const size = { w: 300, h: 200 };

  it("prefers the anchor's right side, top-aligned", () => {
    const p = placePopover({ x: 100, y: 100, w: 80, h: 40 }, size, viewport);
    expect(p).toEqual({ left: 188, top: 100 });
  });

  it("flips to the left when the right side overflows", () => {
    const p = placePopover({ x: 800, y: 100, w: 80, h: 40 }, size, viewport);
    expect(p.left).toBe(800 - 8 - 300);
    expect(p.top).toBe(100);
  });

  it("clamps vertically to the viewport bottom", () => {
    const p = placePopover({ x: 100, y: 700, w: 80, h: 40 }, size, viewport);
    expect(p.top).toBe(800 - 8 - 200);
  });

  it("never leaves the viewport even for edge anchors", () => {
    const p = placePopover({ x: -50, y: -50, w: 10, h: 10 }, size, viewport);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    const q = placePopover({ x: 990, y: 790, w: 10, h: 10 }, size, viewport);
    expect(q.left + size.w).toBeLessThanOrEqual(1000 - 8);
    expect(q.top + size.h).toBeLessThanOrEqual(800 - 8);
  });
});

describe("layoutDay", () => {
  let seq = 1;
  const mkEvent = (startsAt: number, endsAt: number | null, allDay = false): CalendarEvent => ({
    id: seq++,
    accountId: 1,
    messageId: null,
    summary: "e",
    location: null,
    organizer: null,
    description: null,
    attendees: [],
    joinUrl: null,
    rsvpStatus: null,
    isLocal: true,
    calendarId: null,
    rrule: null,
    startsAt,
    endsAt,
    allDay,
    status: "CONFIRMED",
    method: "REQUEST",
  });

  it("positions a lone event by its times", () => {
    const [p] = layoutDay([mkEvent(FRI + 9 * 3_600_000, FRI + 10 * 3_600_000)], FRI);
    expect(p.top).toBe(9 * HOUR_PX);
    expect(p.height).toBe(HOUR_PX);
    expect(p.lane).toBe(0);
    expect(p.lanes).toBe(1);
  });

  it("packs overlapping events into side-by-side lanes", () => {
    const a = mkEvent(FRI + 9 * 3_600_000, FRI + 11 * 3_600_000);
    const b = mkEvent(FRI + 10 * 3_600_000, FRI + 12 * 3_600_000);
    const [pa, pb] = layoutDay([a, b], FRI);
    expect(pa.lane).not.toBe(pb.lane);
    expect(pa.lanes).toBe(2);
    expect(pb.lanes).toBe(2);
  });

  it("reuses a freed lane for a later event", () => {
    const a = mkEvent(FRI + 9 * 3_600_000, FRI + 10 * 3_600_000);
    const b = mkEvent(FRI + 9.5 * 3_600_000, FRI + 10.5 * 3_600_000);
    const c = mkEvent(FRI + 10 * 3_600_000, FRI + 11 * 3_600_000); // a has ended
    const placed = layoutDay([a, b, c], FRI);
    const pc = placed.find((p) => p.ev.id === c.id)!;
    expect(pc.lane).toBe(0);
  });

  it("skips all-day events and clamps to the day", () => {
    const allDay = mkEvent(FRI, FRI + DAY_MS, true);
    const overnight = mkEvent(FRI - 2 * 3_600_000, FRI + 3_600_000);
    const placed = layoutDay([allDay, overnight], FRI);
    expect(placed).toHaveLength(1);
    expect(placed[0].top).toBe(0);
    expect(placed[0].height).toBe(HOUR_PX);
  });

  it("gives a minimum height to zero-length events", () => {
    const [p] = layoutDay([mkEvent(FRI + 9 * 3_600_000, null)], FRI);
    expect(p.height).toBeGreaterThanOrEqual(18);
  });
});
