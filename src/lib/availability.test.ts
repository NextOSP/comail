import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../ipc/types";
import { computeFreeSlots, formatSlotsHtml, formatSlotsText, hasConflict } from "./availability";

// Monday 2026-07-13 08:00 local.
const NOW = new Date(2026, 6, 13, 8, 0).getTime();
const H = 3_600_000;

function day(offset: number): number {
  const d = new Date(2026, 6, 13 + offset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 1,
    accountId: 1,
    messageId: null,
    summary: "busy",
    location: null,
    organizer: null,
    description: null,
    attendees: [],
    joinUrl: null,
    rsvpStatus: null,
    isLocal: false,
    calendarId: null,
    rrule: null,
    startsAt: day(0) + 9 * H,
    endsAt: day(0) + 10 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
    ...partial,
  };
}

const OPTS = {
  now: NOW,
  days: 2,
  dayStartHour: 9,
  dayEndHour: 12,
  durationMin: 30,
  maxPerDay: 2,
  skipWeekends: true,
};

describe("hasConflict", () => {
  it("detects overlap and ignores cancelled/declined/all-day", () => {
    const busy = ev({});
    expect(hasConflict([busy], day(0) + 9.5 * H, day(0) + 10 * H)).toBe(true);
    expect(hasConflict([busy], day(0) + 10 * H, day(0) + 10.5 * H)).toBe(false);
    expect(hasConflict([ev({ status: "CANCELLED" })], day(0) + 9 * H, day(0) + 10 * H)).toBe(false);
    expect(hasConflict([ev({ rsvpStatus: "DECLINED" })], day(0) + 9 * H, day(0) + 10 * H)).toBe(false);
    expect(hasConflict([ev({ allDay: true, startsAt: day(0), endsAt: day(1) })], day(0) + 9 * H, day(0) + 10 * H)).toBe(false);
  });
});

describe("computeFreeSlots", () => {
  it("skips busy time and caps per day", () => {
    const slots = computeFreeSlots([ev({})], OPTS); // busy Mon 9-10
    expect(slots.length).toBe(4); // 2 per day x 2 days
    expect(slots[0].start).toBe(day(0) + 10 * H); // first free after the meeting
    expect(slots.every((s) => s.end - s.start === 30 * 60_000)).toBe(true);
    // no two suggested slots overlap
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start >= slots[i - 1].end).toBe(true);
    }
  });

  it("only offers future slots", () => {
    const slots = computeFreeSlots([], { ...OPTS, now: day(0) + 10 * H });
    expect(slots[0].start).toBeGreaterThan(day(0) + 10 * H);
  });

  it("skips weekends", () => {
    // Friday start; 3 scanned days = Fri, Sat, Sun -> only Friday yields slots.
    const friday = new Date(2026, 6, 17, 8, 0).getTime();
    const slots = computeFreeSlots([], { ...OPTS, now: friday, days: 3 });
    const days = new Set(slots.map((s) => new Date(s.start).getDay()));
    expect(days).toEqual(new Set([5]));
  });
});

describe("formatting", () => {
  const slots = [
    { start: day(0) + 10 * H, end: day(0) + 10.5 * H },
    { start: day(0) + 11 * H, end: day(0) + 11.5 * H },
    { start: day(1) + 9 * H, end: day(1) + 9.5 * H },
  ];

  it("renders grouped HTML with escaped lead-in", () => {
    const html = formatSlotsHtml(slots, "en-US", "Would any of these <times> work?");
    expect(html).toContain("&lt;times&gt;");
    expect(html).toContain("<ul>");
    expect((html.match(/<li>/g) ?? []).length).toBe(2); // one li per day
  });

  it("renders plain text with one line per day", () => {
    const text = formatSlotsText(slots, "en-US", "Would any of these work?");
    expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(2);
  });
});
