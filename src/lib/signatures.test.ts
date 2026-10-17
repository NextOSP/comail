import { describe, expect, it } from "vitest";
import { replaceSignature, stripSignature, wrapSignature } from "./signatures";

const SIG = "<div>Jane Doe</div><div><b>Acme</b></div>";

describe("wrapSignature", () => {
  it("wraps in a co-signature block", () => {
    expect(wrapSignature("Jane")).toBe('<div class="co-signature">Jane</div>');
  });
});

describe("replaceSignature", () => {
  it("appends the block after a spacer when absent", () => {
    expect(replaceSignature("Hi", "Jane")).toBe('Hi<br><br><div class="co-signature">Jane</div>');
    expect(replaceSignature("", "Jane")).toBe('<br><br><div class="co-signature">Jane</div>');
  });

  it("swaps an existing block in place, keeping text typed around it", () => {
    const body = `Hello there<br><br>${wrapSignature(SIG)}<div>P.S. later</div>`;
    expect(replaceSignature(body, "Work")).toBe(
      `Hello there<br><br>${wrapSignature("Work")}<div>P.S. later</div>`,
    );
  });

  it("matches the block's own closing tag across nested divs", () => {
    const body = `x${wrapSignature("<div><div>deep</div></div><div>more</div>")}<div>after</div>`;
    expect(replaceSignature(body, "S")).toBe(`x${wrapSignature("S")}<div>after</div>`);
  });

  it("finds the block with extra attributes and other classes", () => {
    const body = `a<br><br><div style="color:red" class='foo co-signature'>old</div>`;
    expect(replaceSignature(body, "new")).toBe(`a<br><br>${wrapSignature("new")}`);
  });

  it("does not match look-alike class names", () => {
    const body = `<div class="co-signature-preview">x</div>`;
    expect(replaceSignature(body, "S")).toBe(`${body}<br><br>${wrapSignature("S")}`);
  });

  it("removes the block (and its spacer) for an empty signature", () => {
    const body = `Hi<br><br>${wrapSignature(SIG)}`;
    expect(replaceSignature(body, "  ")).toBe("Hi");
  });

  it("is idempotent", () => {
    const once = replaceSignature("Hi", SIG);
    expect(replaceSignature(once, SIG)).toBe(once);
  });
});

describe("stripSignature", () => {
  it("leaves bodies without a block untouched", () => {
    expect(stripSignature("<div>Hi</div><br>")).toBe("<div>Hi</div><br>");
  });

  it("drops the block and spacer but keeps what follows", () => {
    expect(stripSignature(`Hi<br><br>${wrapSignature(SIG)}<div>tail</div>`)).toBe(
      "Hi<div>tail</div>",
    );
  });

  it("strips an unclosed block to the end", () => {
    expect(stripSignature('Hi<br><div class="co-signature"><div>Jane')).toBe("Hi");
  });
});
