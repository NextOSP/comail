import { describe, expect, it } from "vitest";
import {
  addressName,
  firstName,
  formatSize,
  hueOf,
  initials,
  isValidEmail,
  participantSummary,
  relativeTime,
} from "./format";

const addr = (email: string, name: string | null = null) => ({ name, email });

describe("formatSize", () => {
  it("handles null and byte ranges", () => {
    expect(formatSize(null)).toBe("");
    expect(formatSize(512)).toMatch(/512/);
    expect(formatSize(2048)).toMatch(/2/);
    expect(formatSize(5 * 1024 * 1024)).toMatch(/5/);
  });
});

describe("addressName / firstName / initials", () => {
  it("falls back to the email local part without a display name", () => {
    expect(addressName(addr("jane.doe@x.com"))).toContain("jane");
    expect(addressName(addr("x@y.com", "Xavier"))).toBe("Xavier");
  });

  it("firstName takes the leading word", () => {
    expect(firstName(addr("x@y.com", "Ada Lovelace"))).toBe("Ada");
  });

  it("initials are stable and uppercase", () => {
    const i = initials(addr("x@y.com", "Ada Lovelace"));
    expect(i).toBe(i.toUpperCase());
    expect(i.length).toBeGreaterThan(0);
    expect(i.length).toBeLessThanOrEqual(2);
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});

describe("hueOf", () => {
  it("is deterministic and within the hue circle", () => {
    expect(hueOf("alice@x.com")).toBe(hueOf("alice@x.com"));
    const h = hueOf("bob@y.org");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe("relativeTime", () => {
  it("describes past instants relative to now", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 30_000, now)).toBeTruthy();
    // an hour ago should not equal the just-now formatting
    expect(relativeTime(now - 3_600_000, now)).not.toBe(relativeTime(now - 30_000, now));
  });
});

describe("participantSummary", () => {
  it("hides self and joins the rest", () => {
    const out = participantSummary(
      [addr("me@x.com", "Me"), addr("a@x.com", "Alice"), addr("b@x.com", "Bob")],
      new Set(["me@x.com"]),
    );
    expect(out).toContain("Alice");
    expect(out).toContain("Bob");
    expect(out).not.toContain("Me");
  });
});
