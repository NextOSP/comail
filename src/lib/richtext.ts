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

/** True when the HTML has no visible content (text or image). */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  return htmlToText(html).trim() === "";
}
