import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../ipc/types";
import { DAY_MS } from "../../lib/calendarGrid";
import { groupByDay, isDraggable, rsvpKind, withoutShadowedCancels } from "./eventUtils";

const DAY = new Date(2026, 6, 10).getTime();
const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 1,
  accountId: 1,
  messageId: null,
  summary: "e",
  location: null,
  organizer: null,
  description: null,
  attendees: [],
  joinUrl: null,
  rsvpStatus: null,
  isLocal: false,
  calendarId: null,
  rrule: null,
  startsAt: DAY + 9 * 3_600_000,
  endsAt: DAY + 10 * 3_600_000,
  allDay: false,
  status: "CONFIRMED",
  method: "REQUEST",
  ...over,
});

describe("rsvpKind", () => {
  it("is null for events we organize", () => {
    expect(rsvpKind(ev({ isLocal: true, rsvpStatus: "ACCEPTED" }))).toBeNull();
  });
  it("maps partstat case-insensitively and defaults to needs", () => {
    expect(rsvpKind(ev({ rsvpStatus: "accepted" }))).toBe("accepted");
    expect(rsvpKind(ev({ rsvpStatus: "TENTATIVE" }))).toBe("tentative");
    expect(rsvpKind(ev({ rsvpStatus: "DECLINED" }))).toBe("declined");
    expect(rsvpKind(ev({ rsvpStatus: null }))).toBe("needs");
  });
});

describe("isDraggable", () => {
  it("only allows timed, live, local events", () => {
    expect(isDraggable(ev({ isLocal: true }))).toBe(true);
    expect(isDraggable(ev({ isLocal: false }))).toBe(false);
    expect(isDraggable(ev({ isLocal: true, allDay: true }))).toBe(false);
    expect(isDraggable(ev({ isLocal: true, status: "CANCELLED" }))).toBe(false);
  });
});

describe("groupByDay", () => {
  it("puts a multi-day event in every day it touches", () => {
    const days = [DAY, DAY + DAY_MS, DAY + 2 * DAY_MS];
    const long = ev({ startsAt: DAY + 20 * 3_600_000, endsAt: DAY + DAY_MS + 3_600_000 });
    const map = groupByDay([long], days);
    expect(map.get(DAY)).toHaveLength(1);
    expect(map.get(DAY + DAY_MS)).toHaveLength(1);
    expect(map.get(DAY + 2 * DAY_MS)).toHaveLength(0);
  });
});

describe("withoutShadowedCancels", () => {
  it("drops a cancelled event only when a live one overlaps it", () => {
    const live = ev({ id: 1 });
    const replaced = ev({ id: 2, status: "CANCELLED" });
    const alone = ev({
      id: 3,
      status: "CANCELLED",
      startsAt: DAY + 15 * 3_600_000,
      endsAt: DAY + 16 * 3_600_000,
    });
    expect(withoutShadowedCancels([live, replaced, alone]).map((e) => e.id)).toEqual([1, 3]);
  });
});
