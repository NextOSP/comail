import { describe, expect, it, vi } from "vitest";
import type { TabTotals, UnreadCounts } from "../ipc/types";
import { formatTabCount, tabCount } from "./hooks";

vi.mock("../ipc/commands", () => ({ call: vi.fn() }));

const counts: UnreadCounts = {
  inbox: 3,
  important: 2,
  other: 1,
  splits: { "7": 4 },
  labels: { "9": 5 },
  views: {},
};
const totals: TabTotals = {
  inbox: 172,
  important: 120,
  other: 40,
  splits: { "7": 12 },
  labels: { "9": 0 },
};

describe("tab counts", () => {
  it("unread mode reads the unread badges", () => {
    expect(tabCount("unread", { splitId: -1 }, counts, totals)).toBe(2);
    expect(tabCount("unread", { splitId: 7 }, counts, totals)).toBe(4);
    expect(tabCount("unread", { labelId: 9 }, counts, totals)).toBe(5);
  });

  it("all mode reads every conversation the tab holds", () => {
    expect(tabCount("all", { splitId: -1 }, counts, totals)).toBe(120);
    expect(tabCount("all", { splitId: -2 }, counts, totals)).toBe(40);
    expect(tabCount("all", { splitId: 7 }, counts, totals)).toBe(12);
    expect(tabCount("all", { labelId: 9 }, counts, totals)).toBe(0);
    // A split the totals don't know yet (just created) counts as empty.
    expect(tabCount("all", { splitId: 8 }, counts, totals)).toBe(0);
  });

  it("shows nothing while totals load, or when turned off", () => {
    expect(tabCount("all", { splitId: -1 }, counts, undefined)).toBeUndefined();
    expect(tabCount("off", { splitId: -1 }, counts, totals)).toBeUndefined();
  });

  it("caps the number at 99+", () => {
    expect(formatTabCount(7)).toBe("7");
    expect(formatTabCount(99)).toBe("99");
    expect(formatTabCount(100)).toBe("99+");
    expect(formatTabCount(23000)).toBe("99+");
  });
});
