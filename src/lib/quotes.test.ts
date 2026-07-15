import { describe, expect, it } from "vitest";
import {
  splitQuotedHtml,
  splitQuotedTail,
  stripQuoteMarkers,
  trimTrailingEmptyHtml,
} from "./quotes";

describe("trimTrailingEmptyHtml", () => {
  it("drops trailing empty blocks, brs and nbsp", () => {
    const html =
      "<p>RFID band. Xem thử.</p><div><br></div><p>&nbsp;</p><div>&nbsp;<br></div>";
    expect(trimTrailingEmptyHtml(html)).toBe("<p>RFID band. Xem thử.</p>");
  });

  it("unwinds nested empty wrappers", () => {
    expect(trimTrailingEmptyHtml("<p>Hi</p><div><div><br></div></div>")).toBe("<p>Hi</p>");
  });

  it("keeps trailing content intact", () => {
    const html = "<p>Line one</p><p>Line two</p>";
    expect(trimTrailingEmptyHtml(html)).toBe(html);
  });

  it("does not strip a trailing image", () => {
    const html = '<p>See logo</p><div><img src="cid:x"></div>';
    expect(trimTrailingEmptyHtml(html)).toBe(html);
  });
});

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

describe("splitQuotedHtml", () => {
  it("returns the whole html when there is no quote", () => {
    const html = "<p>Hi there</p><p>All good.</p>";
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe(html);
    expect(quoted).toBeNull();
  });

  it("splits off a Gmail quote", () => {
    const html =
      '<div dir="ltr">Thanks!</div><div class="gmail_quote"><blockquote>old stuff</blockquote></div>';
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe('<div dir="ltr">Thanks!</div>');
    expect(quoted).toContain("gmail_quote");
  });

  it("splits off a top-posted Outlook reply header (id/class stripped)", () => {
    // What our sanitizer leaves: no id/class, just the visible header labels.
    const html =
      "<p>See below.</p><div><b>From:</b> Alice &lt;a@x.com&gt;<br>" +
      "<b>Sent:</b> Friday<br><b>To:</b> Bob<br><b>Subject:</b> Re: hi</div>" +
      "<div>Original message text.</div>";
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe("<p>See below.</p>");
    expect(quoted).toContain("Subject:");
  });

  it("splits a Vietnamese Outlook header sent in decomposed (NFD) form", () => {
    // Outlook (macOS/iOS) sends accented labels decomposed: "Từ"/"Đến"/"Chủ đề"
    // as base letters + combining marks, which don't match our precomposed
    // regex literals until the body is NFC-normalized.
    const header =
      "<p>Thanks.</p><hr>" +
      "<div><font><b>Từ:</b> Alice &lt;a@x.com&gt;<br>" +
      "<b>Đã gửi:</b> 09 July 2026<br>" +
      "<b>Đến:</b> Bob &lt;b@x.com&gt;<br>" +
      "<b>Chủ đề:</b> Re: hi</font></div>" +
      "<div>Old message.</div>";
    const html = header.normalize("NFD");
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe("<p>Thanks.</p>");
    expect(quoted).toContain("Chủ đề:");
  });

  it("ignores a stray 'From:' with no To/Subject header nearby", () => {
    const html = "<p>Quote from: the book, chapter two. My thoughts follow.</p>";
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe(html);
    expect(quoted).toBeNull();
  });

  it("splits at a bare blockquote", () => {
    const html = "<p>My reply.</p><blockquote>earlier</blockquote>";
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe("<p>My reply.</p>");
    expect(quoted).toBe("<blockquote>earlier</blockquote>");
  });

  it("keeps everything when the pre-quote part is empty (bare forward)", () => {
    const html = '<div class="gmail_quote"><blockquote>only a quote</blockquote></div>';
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe(html);
    expect(quoted).toBeNull();
  });

  it("does not split when only empty wrappers precede the quote", () => {
    const html = '<div><br></div><blockquote>quote</blockquote>';
    const [visible, quoted] = splitQuotedHtml(html);
    expect(visible).toBe(html);
    expect(quoted).toBeNull();
  });
});

describe("stripQuoteMarkers", () => {
  it("removes single-level markers but keeps the attribution line", () => {
    const quoted = [
      "On Mon, Jul 7, 2026, Alice <a@x.com> wrote:",
      "> Are we still on for Friday?",
      "> Let me know.",
    ].join("\n");
    expect(stripQuoteMarkers(quoted)).toBe(
      "On Mon, Jul 7, 2026, Alice <a@x.com> wrote:\nAre we still on for Friday?\nLet me know.",
    );
  });

  it("flattens nested >> markers", () => {
    expect(stripQuoteMarkers("> earlier reply\n>\n>> original question")).toBe(
      "earlier reply\n\noriginal question",
    );
  });

  it("collapses runs of blank quote lines", () => {
    expect(stripQuoteMarkers("> a\n>\n>\n>\n> b")).toBe("a\n\nb");
  });

  it("leaves unquoted text untouched", () => {
    expect(stripQuoteMarkers("plain text\nsecond line")).toBe("plain text\nsecond line");
  });
});
