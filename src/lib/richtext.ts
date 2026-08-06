/** Conversions between the composer's rich HTML body and the plain-text
 *  fallback that goes out as text/plain (and powers snippets/search). The
 *  converter only needs to be faithful for the markup our own editor emits
 *  (div/p/br, b/i/u/s, blockquote, ul/ol/li, a, img) but stays tolerant of
 *  anything pasted in. */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text -> minimal HTML (escaped, newlines as <br>). */
export function textToHtml(text: string): string {
  if (!text) return "";
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/** Rich HTML -> plain text fallback. Block elements become newlines,
 *  blockquotes become "> " prefixes, list items become "- ", images become
 *  their alt text (or are dropped). */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Links: keep the target when it isn't the same as the text.
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, "");
    return text.trim() === href.trim() || !href ? text : `${text} (${href})`;
  });

  // Images: alt text or nothing.
  s = s.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => (alt ? `[${alt}]` : ""));
  s = s.replace(/<img\b[^>]*>/gi, "");

  // Blockquote boundaries -> control markers handled linewise below.
  s = s.replace(/<blockquote\b[^>]*>/gi, "\n\x01");
  s = s.replace(/<\/blockquote>/gi, "\x02\n");

  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Table cells: tab-separate so a row stays on one readable line.
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  // Opening block tags start a new line; closing ones end it.
  s = s.replace(/<(div|p|h[1-6]|ul|ol|tr|table)\b[^>]*>/gi, "\n");
  // </li> gets no newline of its own - the next <li> (or the list end) adds it.
  // </tr> likewise: the next <tr> supplies the row break, so it doesn't double up.
  s = s.replace(/<\/(div|p|h[1-6]|ul|ol|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Pull close markers up to the previous line so nested closes don't leave
  // orphan quote-prefix lines.
  s = s.replace(/\n+(?=\x02)/g, "");

  // Apply "> " prefixes from the blockquote depth markers.
  // Markers always sit at line boundaries (opens at the start, closes at the
  // end), so opens take effect for their own line, closes after it.
  const out: string[] = [];
  let depth = 0;
  for (const rawLine of s.split("\n")) {
    let line = rawLine;
    let opens = 0;
    let closes = 0;
    line = line.replace(/\x01/g, () => ((opens += 1), ""));
    line = line.replace(/\x02/g, () => ((closes += 1), ""));
    depth += opens;
    const prefix = "> ".repeat(depth);
    out.push(line.trim() === "" ? prefix.trimEnd() : prefix + line);
    depth = Math.max(0, depth - closes);
  }

  return out
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Line-break / cell markers used while flattening. Neither is whitespace, so a
// blanket whitespace collapse can run without eating the structure.
const BR_MARK = "\x01";
const CELL_MARK = "\x02";

const BLOCK_TAGS =
  "div|p|h[1-6]|ul|ol|li|tr|table|thead|tbody|tfoot|blockquote|pre|section|article|aside|header|footer|address|dl|dt|dd|hr|figure|figcaption|form|fieldset";

/** Rebuild an <img> tag with only the attributes that carry content, dropping
 *  inline sizing/styling. */
function plainImg(tag: string): string {
  const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "";
  const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "";
  if (!src) return "";
  const altAttr = alt ? ` alt="${escapeHtml(decodeEntities(alt))}"` : "";
  return `<img src="${escapeHtml(decodeEntities(src))}"${altAttr}>`;
}

/**
 * Strip every formatting construct from `html`, keeping the text and its line
 * structure. Tables, lists, quotes, headings, fonts, colors and inline styles
 * all collapse to plain lines separated by <br>; table cells stay tab-separated
 * on their row's line.
 *
 * Images, "@" mention chips and links survive: they are content, not
 * formatting (a link keeps its href and its text, losing any markup inside).
 */
export function stripFormatting(html: string): string {
  if (!html) return "";

  // Content we hand back untouched, parked behind \x00<n>\x00 placeholders so
  // the tag-stripping pass below can't see it.
  const kept: string[] = [];
  const keep = (s: string) => `\x00${kept.push(s) - 1}\x00`;

  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "");

  s = s.replace(/<img\b[^>]*>/gi, (m) => keep(plainImg(m)));
  s = s.replace(
    /<span\b[^>]*class="[^"]*co-mention[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
    (m) => keep(m),
  );
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
    // Inner markup goes, inner text (and any kept placeholder) stays.
    const text = inner.replace(/<[^>]+>/g, "");
    if (!href || !text.trim()) return text;
    return keep(
      `<a href="${escapeHtml(decodeEntities(href))}">${escapeHtml(decodeEntities(text)).trim()}</a>`,
    );
  });

  s = s.replace(/<br\s*\/?>/gi, BR_MARK);
  s = s.replace(/<\/(td|th)>/gi, CELL_MARK);
  // A whole run of adjacent block boundaries ("</li><li>", "</div><div>") is
  // one line break, not one per tag - only an explicit empty block leaves a
  // blank line, because its <br> already became a marker above.
  s = s.replace(new RegExp(`(?:\\s*</?(?:${BLOCK_TAGS})\\b[^>]*>\\s*)+`, "gi"), BR_MARK);
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Source line breaks and indentation are formatting too.
  s = s.replace(/\s+/g, " ");

  const text = s
    .split(BR_MARK)
    .map((line) => line.split(CELL_MARK).join("\t").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let out = escapeHtml(text).replace(/\n/g, "<br>");
  // Kept links can themselves hold an image/mention placeholder, so restore
  // until nothing is left parked.
  for (let pass = 0; pass < 3 && out.includes("\x00"); pass += 1) {
    out = out.replace(/\x00(\d+)\x00/g, (_, n: string) => kept[Number(n)] ?? "");
  }
  return out;
}

/** True when the HTML has no visible content (text or image). */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  return htmlToText(html).trim() === "";
}
