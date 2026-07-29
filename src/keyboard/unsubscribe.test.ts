import { describe, expect, it } from "vitest";
import { parseMailtoFromHeader, toastForUnsubscribe } from "./unsubscribe";

describe("toastForUnsubscribe", () => {
  it("claims unsubscribed only on one_click ok", () => {
    const t = toastForUnsubscribe({ ok: true, method: "one_click", status: 200 });
    expect(t.unsubscribed).toBe(true);
    expect(t.key).toBe("unsubscribed");
  });

  it("does NOT claim unsubscribed when ok:false", () => {
    const t = toastForUnsubscribe({
      ok: false,
      method: "one_click",
      status: 500,
      error: "unsubscribe POST returned 500",
    });
    expect(t.unsubscribed).toBe(false);
    expect(t.key).toBe("unsubscribeFailed");
  });

  it("needs_browser never claims unsubscribed", () => {
    const t = toastForUnsubscribe({
      ok: false,
      method: "needs_browser",
      url: "https://example.com/u",
    } as Parameters<typeof toastForUnsubscribe>[0]);
    expect(t.unsubscribed).toBe(false);
    expect(t.key).toBe("unsubscribeOpenedConfirm");
  });

  it("mailto requires mailtoSent for success", () => {
    expect(
      toastForUnsubscribe({ ok: false, method: "mailto", mailtoSent: false }).unsubscribed,
    ).toBe(false);
    expect(
      toastForUnsubscribe({ ok: false, method: "mailto", mailtoSent: true }).key,
    ).toBe("unsubscribeEmailSent");
  });
});

describe("parseMailtoFromHeader", () => {
  it("parses subject from mailto query (not hardcoded)", () => {
    const m = parseMailtoFromHeader(
      "<mailto:leave@list.example?subject=Please%20remove%20me&body=bye>, <https://x.example/u>",
    );
    expect(m?.to).toBe("leave@list.example");
    expect(m?.subject).toBe("Please remove me");
    expect(m?.body).toBe("bye");
  });
});
