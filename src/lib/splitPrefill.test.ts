import { describe, expect, it } from "vitest";
import { domainSplitPrefill } from "./splitPrefill";

describe("domainSplitPrefill", () => {
  it("normalizes a sender and suggests the existing short domain name", () => {
    expect(domainSplitPrefill(" Alerts@GitHub.COM ")).toEqual({
      domain: "github.com",
      name: "github",
      sender: "@github.com",
    });
  });

  it("uses the last at-sign and keeps uncommon suffixes intact", () => {
    expect(domainSplitPrefill('"alerts@system"@updates.example.co.uk')).toEqual({
      domain: "updates.example.co.uk",
      name: "updates.example.co.uk",
      sender: "@updates.example.co.uk",
    });
  });

  it.each([
    "",
    "missing-at-sign",
    "@example.com",
    "sender@",
    "sender@bad domain.com",
    "sender@.example.com",
    "sender@example..com",
    "sender@example.com.",
  ])("rejects an address without a usable domain: %s", (email) => {
    expect(domainSplitPrefill(email)).toBeNull();
  });
});
