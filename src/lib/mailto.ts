import type { Address } from "../ipc/types";

export interface MailtoFields {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject?: string;
  body?: string;
}

/** Parse one recipient token, honoring "Display Name <addr@host>" form. */
function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const angled = s.match(/^(.*?)<([^>]+)>$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, "").trim();
    return { name: name || null, email: angled[2].trim() };
  }
  return { name: null, email: s };
}

/** Split a comma-separated, percent-encoded address list into Addresses. */
function parseAddressList(raw: string): Address[] {
  if (!raw) return [];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* leave as-is if it isn't valid percent-encoding */
  }
  return decoded
    .split(",")
    .map(parseAddress)
    .filter((a): a is Address => a !== null && a.email.length > 0);
}

/**
 * Parse a `mailto:` URL (RFC 6068) into composer fields. Handles the address in
 * the path plus `to`, `cc`, `bcc`, `subject`, and `body` query params. Returns
 * null for anything that isn't a mailto URL.
 */
export function parseMailto(url: string): MailtoFields | null {
  if (!/^mailto:/i.test(url.trim())) return null;
  const rest = url.trim().slice(url.trim().indexOf(":") + 1);
  const qIndex = rest.indexOf("?");
  const pathPart = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const queryPart = qIndex >= 0 ? rest.slice(qIndex + 1) : "";
  const params = new URLSearchParams(queryPart);

  const to = [...parseAddressList(pathPart), ...parseAddressList(params.get("to") ?? "")];
  const cc = parseAddressList(params.get("cc") ?? "");
  const bcc = parseAddressList(params.get("bcc") ?? "");
  const subject = params.get("subject") ?? undefined;
  const body = params.get("body") ?? undefined;

  return { to, cc, bcc, subject, body };
}
