import type { ComposeMode, Settings, Signature } from "../ipc/types";
import { escapeHtml } from "./richtext";

export type { ComposeMode };

/** The signature to pre-fill for a given account and compose mode, honoring the
 *  Gmail-style defaults: `newId` for fresh mail, `replyId` for replies/forwards.
 *  Returns null when the account has no matching default configured. */
export function pickSignature(
  settings: Pick<Settings, "signatureList" | "signatureDefaults">,
  accountId: number,
  mode: ComposeMode,
): Signature | null {
  const defs = settings.signatureDefaults[String(accountId)];
  if (!defs) return null;
  const id = mode === "new" ? defs.newId : defs.replyId;
  if (!id) return null;
  return (
    settings.signatureList.find((s) => s.id === id && s.accountId === accountId) ?? null
  );
}

/** All signatures belonging to one account, in list order. */
export function signaturesForAccount(
  settings: Pick<Settings, "signatureList">,
  accountId: number,
): Signature[] {
  return settings.signatureList.filter((s) => s.accountId === accountId);
}

/** Class marking the signature block in a composed body. A class rather than a
 *  `data-` attribute: neither survives the receive-side ammonia sanitizer, but
 *  the outgoing path sends composer HTML untouched, and a class is what other
 *  clients use for the same job (Gmail's `gmail_signature`). */
export const SIGNATURE_CLASS = "co-signature";

/** Blank lines between the body text and the signature block. */
const SIGNATURE_SPACER = "<br><br>";

const SIG_OPEN_RE = new RegExp(
  `<div\\b[^>]*\\bclass\\s*=\\s*(["'])(?:(?!\\1).)*(?<=["'\\s])${SIGNATURE_CLASS}(?=["'\\s])(?:(?!\\1).)*\\1[^>]*>`,
  "i",
);

/** Wrap signature HTML in the block the composer can later find and swap. */
export function wrapSignature(sigHtml: string): string {
  return `<div class="${SIGNATURE_CLASS}">${sigHtml}</div>`;
}

/** [start, end) of the first signature block, matching nested <div>s by depth. */
function findSignatureBlock(html: string): [number, number] | null {
  const open = SIG_OPEN_RE.exec(html);
  if (!open) return null;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return [open.index, m.index + m[0].length];
  }
  // Unclosed (truncated markup): the block runs to the end.
  return [open.index, html.length];
}

/** The body with its signature block removed, along with the blank lines that
 *  separated it from the text above. */
export function stripSignature(bodyHtml: string): string {
  const block = findSignatureBlock(bodyHtml);
  if (!block) return bodyHtml;
  const before = bodyHtml.slice(0, block[0]).replace(/(?:<br\s*\/?>\s*)+$/i, "");
  return before + bodyHtml.slice(block[1]);
}

/** Put `sigHtml` in as the body's signature: swaps an existing block in place
 *  (so it works after the user has typed), appends one after a spacer when
 *  there is none, and removes the block when `sigHtml` is empty. The signature
 *  is sanitized on the way in: it lands in the live composer DOM, and balanced
 *  markup keeps the block findable (an unclosed <table> would swallow the
 *  quote appended after it). */
export function replaceSignature(bodyHtml: string, sigHtml: string): string {
  const sig = sanitizeSignatureHtml(sigHtml).trim();
  if (!sig) return stripSignature(bodyHtml);
  const block = findSignatureBlock(bodyHtml);
  if (block) {
    return bodyHtml.slice(0, block[0]) + wrapSignature(sig) + bodyHtml.slice(block[1]);
  }
  return `${bodyHtml}${SIGNATURE_SPACER}${wrapSignature(sig)}`;
}

// --- Sanitizing ------------------------------------------------------------
//
// Signature HTML is user supplied (pasted from a signature generator, written
// in the editor's HTML mode, or saved by an older version) and is rendered
// live in Settings and the composer, where an `onerror` would run with the
// app's privileges. So it goes through an allowlist before it is shown, saved
// or put in a draft. The input is tokenized and the output rebuilt from
// scratch: only allowlisted tags with allowlisted, re-quoted attributes, and
// text with `<`/`>` escaped. A tokenizer that reads odd markup differently from
// a browser can therefore only drop content, never let markup through. Tags are
// balanced on output so the signature block can't leak into the body around it.

/** Attributes kept on any allowed element: email HTML lays signatures out with
 *  tables and presentational attributes rather than stylesheets. */
const GLOBAL_ATTRS = new Set([
  "style", "align", "valign", "width", "height", "border", "bgcolor", "color", "dir", "lang", "title",
]);

const NO_EXTRA: readonly string[] = [];

/** Elements kept, with the attributes they add to GLOBAL_ATTRS. Any other tag is
 *  unwrapped: the tag goes, its content stays (`<html>`, `<body>`, `<o:p>`). */
const ALLOWED = new Map<string, readonly string[]>([
  ...(
    "thead tbody tfoot tr caption div p span center blockquote pre address h1 h2 h3 h4 h5 h6 " +
    "br b strong i em u s strike del ins sub sup small big code tt abbr cite q mark"
  )
    .split(" ")
    .map((tag): [string, readonly string[]] => [tag, NO_EXTRA]),
  ["a", ["href", "target"]],
  ["img", ["src", "alt"]],
  ["table", ["cellpadding", "cellspacing", "background"]],
  ["td", ["colspan", "rowspan", "nowrap", "background"]],
  ["th", ["colspan", "rowspan", "nowrap", "background", "scope"]],
  ["col", ["span"]],
  ["colgroup", ["span"]],
  ["ol", ["start", "type"]],
  ["ul", ["type"]],
  ["li", ["value"]],
  ["hr", ["size", "noshade"]],
  ["font", ["face", "size"]],
]);

const VOID = new Set(["br", "hr", "img", "col"]);

/** Dropped with their content, which is not markup ("<" in a script is not a
 *  tag), so they are skipped straight to their end tag. */
const RAW_TEXT = new Set([
  "script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext",
]);

/** Dropped with everything inside them. */
const DROPPED = new Set(["template", "object", "applet", "svg", "math", "select", "audio", "video", "canvas"]);

/** Start tags that close an open <p>, as in a browser. */
const CLOSES_P = new Set([
  "address", "blockquote", "center", "div", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre",
  "table", "ul",
]);

const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup"]);
const CELL_SCOPE = new Set(["table", "td", "th", "caption"]);

/** One token: a comment, a doctype / CDATA / `<?xml?>` (all dropped), or a
 *  start or end tag with its raw attribute text. */
const TOKEN_RE =
  /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*(?:>|$)|<(\/?)([a-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

const SAFE_LINK = /^(?:https?|mailto|tel):/;
/** Image sources. An image (SVG included) runs no script, and the send path
 *  turns base64 `data:` images into inline parts. */
const SAFE_IMAGE = /^(?:https?:|cid:|data:image\/)/;

/** Inline-style properties dropped: `position` would let a signature cover the
 *  app around the editor; the others are legacy script hooks. */
const BLOCKED_CSS = new Set(["position", "behavior", "-moz-binding"]);

/** Character references, enough to read a URL or style the way the browser
 *  will: numeric ones, plus the named ones that spell URL and CSS punctuation
 *  (`javascript&colon;`). Any other named reference stays literal, which can
 *  only make a value fail the checks, not pass them. */
const NAMED_REFS = new Map(
  Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xa0", Tab: "\t", NewLine: "\n",
    colon: ":", semi: ";", comma: ",", period: ".", sol: "/", bsol: "\\", lpar: "(", rpar: ")",
    excl: "!", quest: "?", num: "#", percnt: "%", plus: "+", equals: "=", commat: "@",
  }),
);

function decodeCharRefs(s: string): string {
  return s.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi,
    (ref: string, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return ref.endsWith(";") ? (NAMED_REFS.get(name) ?? ref) : ref;
      const cp = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
      return String.fromCodePoint(cp > 0 && cp <= 0x10ffff ? cp : 0xfffd);
    },
  );
}

function isSafeUrl(attr: string, raw: string): boolean {
  // As the URL parser reads it: references decoded, controls and spaces gone.
  const url = decodeCharRefs(raw).replace(/[\x00-\x20\x7f-\x9f]/g, "").toLowerCase();
  return (attr === "href" ? SAFE_LINK : SAFE_IMAGE).test(url);
}

/** Split a style attribute on the `;`s between declarations (not those inside
 *  `url(data:...;base64,...)` or a quoted font name). */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/** The style's declarations minus the unsafe ones (same text otherwise). */
function cleanStyle(raw: string): string {
  return splitDeclarations(decodeCharRefs(raw))
    .filter((decl) => {
      if (!decl.trim()) return true;
      const colon = decl.indexOf(":");
      if (colon < 0) return false;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).toLowerCase();
      if (!/^-?[a-z][a-z0-9-]*$/.test(prop) || BLOCKED_CSS.has(prop)) return false;
      if (/expression\s*\(|(?:java|vb)script:/.test(value)) return false;
      // Every url() must parse and point at an image source we allow.
      const urls = [...value.matchAll(/url\(([^)]*)\)/g)];
      if (urls.length !== value.split("url(").length - 1) return false;
      return urls.every((u) => SAFE_IMAGE.test(u[1].trim().replace(/^["']|["']$/g, "").trim()));
    })
    .join(";");
}

/** Allowed attributes, re-quoted. Values keep their character references
 *  (only a quote or angle bracket is escaped), except style, rebuilt above. */
function cleanAttrs(raw: string, extra: readonly string[]): { attrs: string; src: boolean } {
  const seen = new Set<string>();
  let attrs = "";
  let src = false;
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    // A browser keeps the first of a repeated attribute.
    if (seen.has(name)) continue;
    seen.add(name);
    if (!GLOBAL_ATTRS.has(name) && !extra.includes(name)) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (name === "style") {
      const css = cleanStyle(value);
      if (css.trim()) attrs += ` style="${escapeHtml(css)}"`;
      continue;
    }
    if ((name === "href" || name === "src" || name === "background") && !isSafeUrl(name, value)) continue;
    if (name === "src") src = true;
    attrs += ` ${name}="${value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`;
  }
  return { attrs, src };
}

/**
 * Signature HTML reduced to what is safe to render in the app and send:
 * tables and their layout attributes, inline styles, links (http, mailto, tel)
 * and images (http, cid, data:image) survive; scripts, `<style>` blocks,
 * forms, frames, SVG, comments, event handlers, classes and ids go. Source
 * formatting (line breaks, indentation) is kept, so the HTML editor shows the
 * user's own markup back. Idempotent.
 */
export function sanitizeSignatureHtml(html: string): string {
  const src = html.replace(/\0/g, "");
  const re = new RegExp(TOKEN_RE.source, "gi");
  const open: string[] = [];
  let out = "";
  let pos = 0;
  /** Inside a dropped element: its tag and nesting depth. */
  let skip: { tag: string; depth: number } | null = null;

  const text = (s: string) => {
    if (!skip) out += s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  const closeTo = (i: number) => {
    while (open.length > i) out += `</${open.pop()}>`;
  };
  /** Close the nearest open `targets` element unless a `stops` one comes first. */
  const closeNearest = (targets: readonly string[], stops: readonly string[]) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (targets.includes(open[i])) return closeTo(i);
      if (stops.includes(open[i])) return;
    }
  };
  /** The open element an end tag closes, or -1 to ignore it. As in a browser,
   *  an end tag doesn't reach out of the cell (table parts: the table) it is in. */
  const findOpen = (tag: string): number => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i] === tag) return i;
      if (tag !== "table" && (TABLE_PARTS.has(tag) ? open[i] === "table" : CELL_SCOPE.has(open[i]))) {
        return -1;
      }
    }
    return -1;
  };

  for (let m = re.exec(src); m; m = re.exec(src)) {
    text(src.slice(pos, m.index));
    pos = re.lastIndex;
    const [token, slash, rawTag, rawAttrs] = m;
    if (rawTag === undefined) continue;
    const tag = rawTag.toLowerCase();
    const closing = slash === "/";
    if (skip) {
      if (tag === skip.tag) skip.depth += closing ? -1 : 1;
      if (skip.depth === 0) skip = null;
      continue;
    }
    if (closing) {
      const i = VOID.has(tag) ? -1 : findOpen(tag);
      if (i >= 0) closeTo(i);
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      const end = src.slice(pos).search(new RegExp(`</${tag}[\\s/>]`, "i"));
      pos = end < 0 ? src.length : pos + end;
      re.lastIndex = pos;
      continue;
    }
    if (DROPPED.has(tag)) {
      if (!token.endsWith("/>")) skip = { tag, depth: 1 };
      continue;
    }
    const extra = ALLOWED.get(tag);
    if (!extra) continue;
    const { attrs, src: hasSrc } = cleanAttrs(rawAttrs, extra);
    // An image whose source didn't survive shows nothing.
    if (tag === "img" && !hasSrc) continue;
    if (CLOSES_P.has(tag)) closeNearest(["p"], ["table", "td", "th", "caption"]);
    if (tag === "li") closeNearest(["li"], ["ul", "ol", "table", "td", "th"]);
    else if (tag === "td" || tag === "th") closeNearest(["td", "th"], ["tr", "table"]);
    else if (tag === "tr") closeNearest(["tr"], ["thead", "tbody", "tfoot", "table"]);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      closeNearest(["thead", "tbody", "tfoot"], ["table"]);
    }
    out += `<${tag}${attrs}>`;
    if (!VOID.has(tag)) open.push(tag);
  }
  text(src.slice(pos));
  closeTo(0);
  return out;
}
