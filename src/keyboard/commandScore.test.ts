import { describe, expect, it } from "vitest";
import { commandScore } from "./commandScore";

describe("commandScore", () => {
  it("scores exact matches highest", () => {
    expect(commandScore("archive", "archive")).toBe(1);
  });

  it("prefers word-boundary abbreviations over scattered characters", () => {
    const boundary = commandScore("Mark as spam", "mas");
    const scattered = commandScore("miscellaneous", "mas");
    expect(boundary).toBeGreaterThan(scattered);
  });

  it("matches case-insensitively", () => {
    expect(commandScore("Snooze", "snO")).toBeGreaterThan(0);
  });

  it("returns 0 when characters are missing", () => {
    expect(commandScore("inbox", "xyz")).toBe(0);
  });

  it("ranks prefix matches above mid-word continuations", () => {
    const prefix = commandScore("settings", "set");
    const mid = commandScore("unsettling", "set");
    expect(prefix).toBeGreaterThan(mid);
  });

  it("tolerates a space-separated query hitting word starts", () => {
    expect(commandScore("Go to Starred", "go st")).toBeGreaterThan(0);
  });
});
