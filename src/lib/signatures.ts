import type { ComposeMode, Settings, Signature } from "../ipc/types";

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
 *  there is none, and removes the block when `sigHtml` is empty. */
export function replaceSignature(bodyHtml: string, sigHtml: string): string {
  const sig = sigHtml.trim();
  if (!sig) return stripSignature(bodyHtml);
  const block = findSignatureBlock(bodyHtml);
  if (block) {
    return bodyHtml.slice(0, block[0]) + wrapSignature(sig) + bodyHtml.slice(block[1]);
  }
  return `${bodyHtml}${SIGNATURE_SPACER}${wrapSignature(sig)}`;
}
