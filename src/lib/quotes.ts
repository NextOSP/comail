/** Split a plain-text body into [visible, quoted-tail]. The tail is the
 *  trailing run of "> " lines plus the "On ... wrote:" attribution line
 *  above it. Used to collapse quote trails in the thread view. */
export function splitQuotedTail(text: string): [string, string | null] {
  const lines = text.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0 || !lines[i].startsWith(">")) return [text, null];

  let start = i;
  for (let j = i; j >= 0; j--) {
    const l = lines[j];
    if (l.startsWith(">") || l.trim() === "") {
      start = j;
      continue;
    }
    // include the attribution line directly above the quote
    if (/wrote:\s*$/.test(l.trim()) || /forwarded message/i.test(l.trim())) start = j;
    break;
  }
  const visible = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const quoted = lines.slice(start).join("\n").trim();
  if (!quoted) return [text, null];
  return [visible, quoted];
}

/** Attribute markers that begin the quoted tail in an HTML reply. These only
 *  survive if the body still carries class/id (our sanitizer strips them, so
 *  in practice the blockquote + reply-header heuristics below do the work) -  *  kept as a cheap best-effort for bodies that do keep them. */
const HTML_QUOTE_MARKERS = [
  'class="gmail_quote', // Gmail
  "class='gmail_quote",
  'class="yahoo_quoted', // Yahoo
  'id="divRplyFwdMsg', // Outlook desktop / OWA reply-forward header
  'id="appendonsend', // Outlook (new) separator before the quote
];

// "From:" and "To:"/"Subject:" reply-header labels in the languages the app
// ships. Outlook and similar clients top-post and prepend this header block
// above the quoted message; the labels survive sanitization even when the
// wrapping div's id/class does not.
const FROM_LABEL = /(?:From|De|Von|Từ|发件人|寄件者|差出人)\s*:/i;
const TO_OR_SUBJECT_LABEL =
  /(?:To|Sent|Date|À|Envoyé|An|Gesendet|Betreff|Objet|Subject|Sujet|Đến|Chủ đề|收件人|主题|件名|宛先)\s*:/i;

/** Does this HTML fragment carry anything the reader would see (text or an
 *  image), rather than just empty wrapper tags/whitespace? */
function hasVisibleContent(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").trim().length > 0 || /<img\b/i.test(html);
}

/** Index where a top-posted reply-header block ("From: … To: … Subject: …")
 *  begins, or -1. Requires a From label with a To/Subject label close after it
 *  so a stray "From:" in prose doesn't trip it. Cuts at the start of the tag
 *  enclosing the header so the visible part stays renderable. */
// Nested block wrappers + inline tags that typically sit between a container
// and the "From:" label (the reply divider line, its wrapping <div>, the <p>,
// the <b>). Absorbing them means the visible part isn't left with empty shells
// or a dangling horizontal rule.
const HEADER_WRAPPER =
  /(?:<(?:div|p|table|tbody|tr|td|blockquote|section|hr)\b[^>]*>\s*)+(?:<(?:b|strong|i|em|span|font|u|o:p)\b[^>]*>\s*)*$/i;

function replyHeaderCut(html: string): number {
  // Scan every "From:" (a stray one in prose has no To/Subject beside it), and
  // cut at the first that looks like a real reply header.
  const re = new RegExp(FROM_LABEL.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const near = html.slice(m.index, m.index + 800).replace(/<[^>]*>/g, " ");
    if (!TO_OR_SUBJECT_LABEL.test(near)) continue;
    let cut = html.lastIndexOf("<", m.index);
    if (cut === -1) cut = m.index;
    const bm = html.slice(0, cut).match(HEADER_WRAPPER);
    if (bm?.index !== undefined) cut = bm.index;
    return cut;
  }
  return -1;
}

/** Split an HTML body into [visible, quoted-tail]. The tail is the trailing
 *  quoted/forwarded reply that clients like Gmail and Outlook append inline;
 *  collapsing it keeps the thread view to just the new message. Returns
 *  [html, null] when no quote boundary is found, or when everything before the
 *  boundary is empty (a bare forward with no new text stays fully shown). */
export function splitQuotedHtml(html: string): [string, string | null] {
  // Outlook (esp. from macOS/iOS) sends Vietnamese and other accented text in
  // decomposed form (NFD: "Từ" as U+0054 U+0075 + combining marks), while our
  // reply-header labels ("Từ", "Đến", "Chủ đề") are precomposed (NFC) literals.
  // Without normalizing, the labels never match and the quoted history is left
  // fully expanded. NFC is idempotent for already-composed bodies and renders
  // identically, so normalize once up front and slice from the composed string.
  html = html.normalize("NFC");
  const lower = html.toLowerCase();
  let cut = -1;
  const take = (idx: number) => {
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
  };

  for (const marker of HTML_QUOTE_MARKERS) {
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx !== -1) take(html.lastIndexOf("<", idx));
  }
  take(lower.indexOf("<blockquote"));
  take(replyHeaderCut(html));

  if (cut <= 0) return [html, null];
  const visible = html.slice(0, cut);
  if (!hasVisibleContent(visible)) return [html, null];
  return [visible, html.slice(cut)];
}

/** Drop trailing empty markup - blank `<div>`/`<p>` spacers, `<br>` runs and
 *  `&nbsp;` - that many mail clients leave at the end of a body (and that a
 *  quote split can expose). Rendered in an auto-height iframe those reserve
 *  real vertical space, so a one-line reply can otherwise show a huge blank
 *  gap. Loops so nested empties (`<div><div><br></div></div>`) fully unwind. */
export function trimTrailingEmptyHtml(html: string): string {
  const TAGS = "div|p|span|o:p|font|center|b|i|u|em|strong|table|tbody|tr|td";
  // "Empty" inner content: whitespace, &nbsp;, <br>, and nested open/close of
  // the same structural tags (but no text and no <img>), so wrappers nested a
  // level deep still count as empty.
  const inner = `(?:\\s|&nbsp;|&#160;|\\u00a0|<br\\s*/?>|</?(?:${TAGS})\\b[^>]*>)*`;
  const emptyEl = new RegExp(`<(${TAGS})\\b[^>]*>${inner}</\\1>\\s*$`, "i");
  const trailingBreak = new RegExp("(?:<br\\s*/?>|&nbsp;|&#160;|\\u00a0)\\s*$", "i");
  let s = html.replace(/\s+$/, "");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(emptyEl, "").replace(trailingBreak, "").replace(/\s+$/, "");
  }
  return s;
}

/** Strip leading ">"/">>" markers for display. The wire format keeps
 *  standard quoting; the UI shows the earlier message as clean text. */
export function stripQuoteMarkers(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*>+\s?/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
