import { describe, expect, it } from "vitest";
import { hasNewMail, reconcileSeen } from "./tabSeen";

describe("tab seen tracking", () => {
  it("starts quiet on first load", () => {
    const seen = reconcileSeen(
      undefined,
      { important: 3, other: 40 },
      "important",
    );
    expect(seen).toEqual({ important: 3, other: 40 });
    expect(hasNewMail(seen, "other", 40)).toBe(false);
  });

  it("flags an inactive tab whose unread count grew until it is viewed", () => {
    let seen = reconcileSeen(undefined, { important: 3, l5: 10 }, "important");
    expect(hasNewMail(seen, "l5", 11)).toBe(true);

    // Still inactive: the seen count holds, so the dot stays.
    seen = reconcileSeen(seen, { important: 3, l5: 11 }, "important");
    expect(hasNewMail(seen, "l5", 11)).toBe(true);

    // Viewing the tab catches it up.
    seen = reconcileSeen(seen, { important: 3, l5: 11 }, "l5");
    expect(hasNewMail(seen, "l5", 11)).toBe(false);
  });

  it("never flags the active tab and tracks reads on inactive tabs", () => {
    let seen = reconcileSeen(
      undefined,
      { important: 3, other: 10 },
      "important",
    );
    seen = reconcileSeen(seen, { important: 4, other: 10 }, "important");
    expect(hasNewMail(seen, "important", 4)).toBe(false);

    // Mail read elsewhere lowers the baseline, so the next arrival still shows.
    seen = reconcileSeen(seen, { important: 4, other: 8 }, "important");
    expect(hasNewMail(seen, "other", 9)).toBe(true);
  });
});
