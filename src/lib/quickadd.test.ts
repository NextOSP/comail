import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "./quickadd";

// Fixed reference: Friday 2026-07-10 14:00 local.
const NOW = new Date(2026, 6, 10, 14, 0, 0, 0);

function dayStart(offsetDays: number): number {
  const d = new Date(2026, 6, 10 + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

describe("parseQuickAdd", () => {
  it("parses 'lunch with bob tomorrow 1pm 45m'", () => {
    const r = parseQuickAdd("lunch with bob tomorrow 1pm 45m", NOW)!;
    expect(r.summary).toBe("lunch with bob");
    expect(r.startsAt).toBe(dayStart(1) + 13 * 3_600_000);
    expect(r.endsAt - r.startsAt).toBe(45 * 60_000);
    expect(r.allDay).toBe(false);
  });

  it("parses 24h times and 'at'", () => {
    const r = parseQuickAdd("design review today at 15:30", NOW)!;
    expect(r.summary).toBe("design review");
    expect(r.startsAt).toBe(dayStart(0) + 15.5 * 3_600_000);
    expect(r.endsAt - r.startsAt).toBe(30 * 60_000); // default 30m
  });

  it("rolls a past time to tomorrow when no day given", () => {
    const r = parseQuickAdd("standup 9am", NOW)!; // 9am already passed at 14:00
    expect(r.startsAt).toBe(dayStart(1) + 9 * 3_600_000);
  });

  it("parses weekday names as the next occurrence", () => {
    const r = parseQuickAdd("sync mon 9:30", NOW)!; // Fri -> next Monday
    expect(r.startsAt).toBe(dayStart(3) + 9.5 * 3_600_000);
    const next = parseQuickAdd("sync next friday 10am", NOW)!;
    expect(next.startsAt).toBe(dayStart(7) + 10 * 3_600_000);
  });

  it("parses month-day and 'for' durations", () => {
    const r = parseQuickAdd("offsite planning jul 20 10am for 2h", NOW)!;
    expect(r.summary).toBe("offsite planning");
    expect(new Date(r.startsAt).getDate()).toBe(20);
    expect(r.endsAt - r.startsAt).toBe(2 * 3_600_000);
  });

  it("parses all-day events", () => {
    const r = parseQuickAdd("conference tomorrow all day", NOW)!;
    expect(r.allDay).toBe(true);
    expect(r.startsAt).toBe(dayStart(1));
    expect(r.endsAt).toBe(dayStart(2));
  });

  it("defaults to 9:00 on a future day with no time", () => {
    const r = parseQuickAdd("dentist tomorrow", NOW)!;
    expect(r.startsAt).toBe(dayStart(1) + 9 * 3_600_000);
  });

  it("returns null without a title or any schedulable token", () => {
    expect(parseQuickAdd("tomorrow 3pm", NOW)).toBeNull();
    expect(parseQuickAdd("just some words", NOW)).toBeNull();
    expect(parseQuickAdd("", NOW)).toBeNull();
  });

  it("keeps bare numbers in the title (not times)", () => {
    const r = parseQuickAdd("review PR 42 tomorrow 3pm", NOW)!;
    expect(r.summary).toBe("review PR 42");
  });

  it("parses '3 PM' split across tokens", () => {
    const r = parseQuickAdd("board sync tomorrow at 3 PM", NOW)!;
    expect(r.summary).toBe("board sync");
    expect(r.startsAt).toBe(dayStart(1) + 15 * 3_600_000);
  });

  it("converts a city timezone ('3pm london' = 14:00 UTC in July, BST)", () => {
    const r = parseQuickAdd("meeting xxx tomorrow at 3 PM london", NOW)!;
    expect(r.summary).toBe("meeting xxx");
    expect(r.startsAt).toBe(Date.UTC(2026, 6, 11, 14, 0)); // absolute, zone-independent
  });

  it("handles 'london time' and multi-word cities", () => {
    const r = parseQuickAdd("intro call tomorrow 9am new york time", NOW)!;
    expect(r.summary).toBe("intro call");
    expect(r.startsAt).toBe(Date.UTC(2026, 6, 11, 13, 0)); // EDT = UTC-4
  });

  it("winter date uses standard time (DST-aware)", () => {
    const r = parseQuickAdd("meeting jan 15 3pm london", NOW)!;
    expect(r.startsAt).toBe(Date.UTC(2027, 0, 15, 15, 0)); // GMT in winter
  });

  it("keeps ambiguous short words in the title unless a time precedes", () => {
    const r = parseQuickAdd("dinner at la brasserie tomorrow 7pm", NOW)!;
    expect(r.summary).toBe("dinner at la brasserie");
    const r2 = parseQuickAdd("standup tomorrow 7am pt", NOW)!;
    expect(r2.startsAt).toBe(Date.UTC(2026, 6, 11, 14, 0)); // PDT = UTC-7
  });

  it("utc keyword works without a preceding time constraint", () => {
    const r = parseQuickAdd("release call tomorrow 12:00 utc", NOW)!;
    expect(r.startsAt).toBe(Date.UTC(2026, 6, 11, 12, 0));
  });
});
