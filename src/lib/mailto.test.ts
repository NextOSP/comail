import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailto";

describe("parseMailto", () => {
  it("returns null for non-mailto urls", () => {
    expect(parseMailto("https://x.com")).toBeNull();
    expect(parseMailto("tel:123")).toBeNull();
  });

  it("parses a bare address", () => {
    expect(parseMailto("mailto:a@b.com")).toEqual({
      to: [{ name: null, email: "a@b.com" }],
      cc: [],
      bcc: [],
      subject: undefined,
      body: undefined,
    });
  });

  it("parses multiple recipients, cc, bcc, subject and body", () => {
    const r = parseMailto(
      "mailto:a@b.com,c@d.com?cc=e@f.com&bcc=g@h.com&subject=Hi%20there&body=Line%201",
    );
    expect(r?.to.map((a) => a.email)).toEqual(["a@b.com", "c@d.com"]);
    expect(r?.cc.map((a) => a.email)).toEqual(["e@f.com"]);
    expect(r?.bcc.map((a) => a.email)).toEqual(["g@h.com"]);
    expect(r?.subject).toBe("Hi there");
    expect(r?.body).toBe("Line 1");
  });

  it("honors display-name form and the to= query param", () => {
    const r = parseMailto('mailto:?to=%22Ana%20M%22%20%3Cana@x.com%3E');
    expect(r?.to).toEqual([{ name: "Ana M", email: "ana@x.com" }]);
  });

  it("handles an empty mailto", () => {
    expect(parseMailto("mailto:")).toEqual({
      to: [],
      cc: [],
      bcc: [],
      subject: undefined,
      body: undefined,
    });
  });
});
