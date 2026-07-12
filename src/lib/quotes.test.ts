import { describe, expect, it } from "vitest";
import { splitQuotedTail } from "./quotes";

describe("splitQuotedTail", () => {
  it("returns the whole text when there is no quote", () => {
    const [visible, quoted] = splitQuotedTail("Hello\n\nJust checking in.");
    expect(visible).toBe("Hello\n\nJust checking in.");
    expect(quoted).toBeNull();
  });

  it("splits a reply with an attribution line", () => {
    const body = [
      "Sounds good, see you then!",
      "",
      "On Mon, Jul 7, 2026, Alice <a@x.com> wrote:",
      "> Are we still on for Friday?",
      "> Let me know.",
    ].join("\n");
    const [visible, quoted] = splitQuotedTail(body);
    expect(visible).toBe("Sounds good, see you then!");
    expect(quoted).toContain("wrote:");
    expect(quoted).toContain("> Are we still on for Friday?");
  });

  it("collapses nested >> trails as one tail", () => {
    const body = [
      "Final answer: yes.",
      "",
      "> earlier reply",
      ">",
      ">> original question",
    ].join("\n");
    const [visible, quoted] = splitQuotedTail(body);
    expect(visible).toBe("Final answer: yes.");
    expect(quoted).toBe("> earlier reply\n>\n>> original question");
  });

  it("keeps inline quotes that are not a trailing block", () => {
    const body = ["> quoted at top", "", "My reply comes after the quote."].join("\n");
    const [visible, quoted] = splitQuotedTail(body);
    expect(visible).toBe(body);
    expect(quoted).toBeNull();
  });

  it("handles a body that is entirely quote", () => {
    const body = "> only a quote\n> nothing else";
    const [visible, quoted] = splitQuotedTail(body);
    expect(visible).toBe("");
    expect(quoted).toBe(body);
  });

  it("includes the forwarded-message marker in the tail", () => {
    const body = [
      "FYI",
      "",
      "---------- Forwarded message ----------",
      "> From: someone",
      "> Body line",
    ].join("\n");
    const [visible, quoted] = splitQuotedTail(body);
    expect(visible).toBe("FYI");
    expect(quoted).toContain("Forwarded message");
  });
});
