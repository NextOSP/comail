import { describe, expect, it } from "vitest";
import { htmlToText, isHtmlEmpty, textToHtml } from "./richtext";

describe("textToHtml", () => {
  it("escapes markup and keeps line breaks", () => {
    expect(textToHtml("a < b\n& done")).toBe("a &lt; b<br>&amp; done");
  });
  it("returns empty for empty", () => {
    expect(textToHtml("")).toBe("");
  });
});

describe("htmlToText", () => {
  it("converts editor markup to plain text", () => {
    expect(htmlToText("Hello<br><b>bold</b> and <i>italic</i>")).toBe(
      "Hello\nbold and italic",
    );
  });

  it("turns divs into line breaks (contenteditable output)", () => {
    expect(htmlToText("first<div>second</div><div><br></div><div>fourth</div>")).toBe(
      "first\nsecond\n\nfourth",
    );
  });

  it("prefixes blockquotes with > and nests", () => {
    expect(htmlToText("reply<blockquote>quoted line<blockquote>deeper</blockquote></blockquote>")).toBe(
      "reply\n> quoted line\n> > deeper",
    );
  });

  it("renders list items as dashes", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("keeps link targets that differ from the text", () => {
    expect(htmlToText('see <a href="https://x.dev">docs</a>')).toBe("see docs (https://x.dev)");
    expect(htmlToText('<a href="https://x.dev">https://x.dev</a>')).toBe("https://x.dev");
  });

  it("replaces images with alt text and drops alt-less ones", () => {
    expect(htmlToText('before <img src="data:image/png;base64,AA" alt="chart"> after')).toBe(
      "before [chart] after",
    );
    expect(htmlToText('x <img src="data:image/png;base64,AA"> y')).toBe("x  y");
  });

  it("decodes entities", () => {
    expect(htmlToText("fish &amp; chips&nbsp;&gt; salad")).toBe("fish & chips > salad");
  });

  it("renders table rows one per line with tab-separated cells", () => {
    const table =
      "<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>";
    expect(htmlToText(table)).toBe("a\tb\nc\td");
  });
});

describe("isHtmlEmpty", () => {
  it("treats whitespace-only markup as empty", () => {
    expect(isHtmlEmpty("")).toBe(true);
    expect(isHtmlEmpty("<div><br></div>")).toBe(true);
    expect(isHtmlEmpty("  <br> ")).toBe(true);
  });
  it("counts images as content", () => {
    expect(isHtmlEmpty('<img src="data:image/png;base64,AA">')).toBe(false);
  });
  it("counts text as content", () => {
    expect(isHtmlEmpty("<div>hi</div>")).toBe(false);
  });
});
