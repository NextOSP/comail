import { describe, expect, it } from "vitest";
import { replaceSignature, sanitizeSignatureHtml, stripSignature, wrapSignature } from "./signatures";

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

/** A ready-made signature as generators emit it: an indented layout table with
 *  presentational attributes, inline styles, an image by URL and links. */
const HTML_SIG = `<table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, sans-serif; font-size: 12px;">
  <tr>
    <td valign="top" width="76" style="padding-right: 12px; border-right: 2px solid #0a66c2;">
      <img src="https://example.com/logo.png" alt="Acme" width="64" height="64" style="display:block;">
    </td>
    <td valign="top" style="padding-left: 12px;">
      <strong style="font-size:14px;color:#111">Jane Doe</strong><br>
      Head of Sales &middot; Acme<br>
      <a href="mailto:jane@acme.com" style="color:#0a66c2;text-decoration:none">jane@acme.com</a>
      | <a href="https://acme.com" target="_blank">acme.com</a>
    </td>
  </tr>
</table>`;

describe("sanitizeSignatureHtml", () => {
  it("keeps a table signature byte for byte", () => {
    expect(sanitizeSignatureHtml(HTML_SIG)).toBe(HTML_SIG);
  });

  it("unwraps a full HTML document and drops what renders nothing", () => {
    const doc = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>My signature</title>
<style>td { color: red }</style><link rel="stylesheet" href="https://x.dev/a.css"></head>
<body><!--[if mso]><table><tr><td><![endif]-->${HTML_SIG}<!--[if mso]></td></tr></table><![endif]--></body></html>`;
    expect(sanitizeSignatureHtml(doc).trim()).toBe(HTML_SIG);
  });

  it("keeps rich-editor output as is", () => {
    const rich =
      '<div>Jane <b>Doe</b></div><div><span style="color: rgb(10, 102, 194);">Acme</span></div>' +
      '<div><a href="https://acme.com">acme.com</a><br></div><div><img src="data:image/png;base64,iVBORw0KGgo="></div>';
    expect(sanitizeSignatureHtml(rich)).toBe(rich);
  });

  it("removes scripts, frames, forms, SVG and event handlers", () => {
    expect(sanitizeSignatureHtml("<b>Jane</b><script>alert(1)</script>")).toBe("<b>Jane</b>");
    expect(sanitizeSignatureHtml('<script>"</script><b>x</b>"')).toBe('<b>x</b>"');
    expect(sanitizeSignatureHtml('<SCRIPT src="https://x.dev/a.js"></SCRIPT >ok')).toBe("ok");
    expect(sanitizeSignatureHtml('<iframe src="https://x.dev"><b>no</b></iframe>ok')).toBe("ok");
    expect(sanitizeSignatureHtml('<svg onload="alert(1)"><svg><text>no</text></svg></svg>ok')).toBe("ok");
    expect(
      sanitizeSignatureHtml('<form action="https://x.dev"><input name="q">Jane<button>Go</button></form>'),
    ).toBe("JaneGo");
    expect(sanitizeSignatureHtml('<div onclick="alert(1)" onmouseover=alert(1)>Jane</div>')).toBe(
      "<div>Jane</div>",
    );
    expect(sanitizeSignatureHtml('<img src="https://x.dev/a.png" onerror="alert(1)">')).toBe(
      '<img src="https://x.dev/a.png">',
    );
    // No usable source: the image would show nothing (and its handler would run).
    expect(sanitizeSignatureHtml("<img src=x onerror=alert(1)>Jane")).toBe("Jane");
  });

  it("drops script and other non-web URLs, however they are spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "java\tscript:alert(1)",
      "jav&#x61;script:alert(1)",
      "jav&#97script:alert(1)",
      "javascript&colon;alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "/relative/path",
    ]) {
      expect(sanitizeSignatureHtml(`<a href="${href}">x</a>`), href).toBe("<a>x</a>");
    }
    expect(sanitizeSignatureHtml('<a href="tel:+15550100">call</a>')).toBe('<a href="tel:+15550100">call</a>');
    const svgImg = '<img src="data:image/svg+xml;base64,PHN2Zz4=">';
    expect(sanitizeSignatureHtml(svgImg)).toBe(svgImg);
    expect(sanitizeSignatureHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe("");
    expect(sanitizeSignatureHtml('<img src="cid:logo@acme">')).toBe('<img src="cid:logo@acme">');
    expect(sanitizeSignatureHtml('<td background="javascript:x">a</td>')).toBe("<td>a</td>");
  });

  it("removes classes, ids and data attributes (and so any spoofed signature block)", () => {
    expect(sanitizeSignatureHtml('<div class="co-signature" id="x" data-x="1" dir="ltr">Jane</div>')).toBe(
      '<div dir="ltr">Jane</div>',
    );
  });

  it("filters inline styles declaration by declaration", () => {
    expect(sanitizeSignatureHtml('<div style="position:fixed;top:0;color:red">x</div>')).toBe(
      '<div style="top:0;color:red">x</div>',
    );
    expect(sanitizeSignatureHtml('<div style="color:red;width:expression(alert(1))">x</div>')).toBe(
      '<div style="color:red">x</div>',
    );
    expect(sanitizeSignatureHtml('<div style="background:url(javascript:alert(1))">x</div>')).toBe(
      "<div>x</div>",
    );
    const bgImage = `<td style="background-image:url('https://x.dev/bg.png');color:red">a</td>`;
    expect(sanitizeSignatureHtml(bgImage)).toBe(bgImage);
    // The ";" inside a data URI doesn't split the declaration.
    const dataBg = '<td style="background:url(data:image/png;base64,AAAA) no-repeat">a</td>';
    expect(sanitizeSignatureHtml(dataBg)).toBe(dataBg);
  });

  it("re-quotes attributes and escapes stray brackets", () => {
    expect(sanitizeSignatureHtml(`<img src='https://x.dev/a.png' alt='say "hi"'>`)).toBe(
      '<img src="https://x.dev/a.png" alt="say &quot;hi&quot;">',
    );
    expect(sanitizeSignatureHtml("<td width=120 nowrap>a</td>")).toBe('<td width="120" nowrap="">a</td>');
    expect(sanitizeSignatureHtml(`<span style='font-family:"Segoe UI",sans-serif'>a</span>`)).toBe(
      '<span style="font-family:&quot;Segoe UI&quot;,sans-serif">a</span>',
    );
    expect(sanitizeSignatureHtml("a < b & c > d")).toBe("a &lt; b & c &gt; d");
    expect(sanitizeSignatureHtml('Jane <a href="x')).toBe('Jane &lt;a href="x');
    expect(sanitizeSignatureHtml('<a href="https://a.dev" href="javascript:x">a</a>')).toBe(
      '<a href="https://a.dev">a</a>',
    );
  });

  it("unwraps Outlook markup", () => {
    expect(
      sanitizeSignatureHtml(
        "<p class=MsoNormal><span style='color:#1F497D'>Jane<o:p></o:p></span></p><![if !mso]>web<![endif]>",
      ),
    ).toBe('<p><span style="color:#1F497D">Jane</span></p>web');
  });

  it("balances unclosed and stray tags the way a browser nests them", () => {
    expect(sanitizeSignatureHtml("<table><tr><td>Jane")).toBe("<table><tr><td>Jane</td></tr></table>");
    expect(sanitizeSignatureHtml("<div><b>x</div></table></div>y")).toBe("<div><b>x</b></div>y");
    expect(sanitizeSignatureHtml("<ul><li>a<li>b</ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(sanitizeSignatureHtml("<table><tr><td>a<td>b<tr><td>c</table>")).toBe(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>",
    );
    expect(sanitizeSignatureHtml("<p>a<div>b</div></p>")).toBe("<p>a</p><div>b</div>");
    // An end tag never reaches out of the cell it sits in.
    expect(sanitizeSignatureHtml("<div><table><tr><td></div>x</td></tr></table></div>")).toBe(
      "<div><table><tr><td>x</td></tr></table></div>",
    );
  });

  it("is idempotent", () => {
    for (const html of [
      HTML_SIG,
      `<span style='font-family:"Segoe UI"'>a &amp; b</span>`,
      "<table><tr><td>a<td>b",
      "a < b",
      '<img src="https://x.dev/a.png?a=1&amp;b=2" alt="A &amp; B">',
    ]) {
      const once = sanitizeSignatureHtml(html);
      expect(sanitizeSignatureHtml(once)).toBe(once);
    }
  });

  it("returns empty for empty input", () => {
    expect(sanitizeSignatureHtml("")).toBe("");
  });
});

describe("replaceSignature with HTML signatures", () => {
  it("inserts a table signature intact and swaps it later", () => {
    const body = replaceSignature("Hi", HTML_SIG);
    expect(body).toBe(`Hi<br><br>${wrapSignature(HTML_SIG)}`);
    expect(replaceSignature(`${body}<div>P.S.</div>`, "Jane")).toBe(
      `Hi<br><br>${wrapSignature("Jane")}<div>P.S.</div>`,
    );
  });

  it("sanitizes the signature on the way into the draft", () => {
    expect(replaceSignature("Hi", '<img src=x onerror="alert(1)"><b>Jane</b><script>x()</script>')).toBe(
      `Hi<br><br>${wrapSignature("<b>Jane</b>")}`,
    );
  });

  it("keeps the block closed when the signature's markup is not", () => {
    const body = replaceSignature("Hi", "<div><table><tr><td>Jane");
    expect(body).toBe(`Hi<br><br>${wrapSignature("<div><table><tr><td>Jane</td></tr></table></div>")}`);
    // Text after the block stays outside it.
    expect(stripSignature(`${body}<div>tail</div>`)).toBe("Hi<div>tail</div>");
  });
});
