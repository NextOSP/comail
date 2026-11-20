// Helpers for the CardDAV (contacts) settings. `sameServer` mirrors
// carddav::same_server in comail-core, which re-checks the match before a
// calendar password is reused.

import type { CalendarLogin } from "../ipc/types";

/** Lowercased host of a typed server URL (https:// assumed); null if unusable. */
export function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

const isDomain = (d: string) => d.includes(".") && !/^[\d.]+$/.test(d);
const parent = (h: string) => {
  const dot = h.indexOf(".");
  return dot === -1 ? null : h.slice(dot + 1);
};

/** Whether a login that works on `known` may be offered for `host`: the same
 *  host, one inside the other, or siblings under one parent domain
 *  (caldav./carddav. on Fastmail, p42-caldav./contacts. on iCloud). */
export function sameServer(host: string, known: string): boolean {
  const a = host.toLowerCase();
  const b = known.toLowerCase();
  if (a === b) return true;
  if ((isDomain(b) && a.endsWith(`.${b}`)) || (isDomain(a) && b.endsWith(`.${a}`))) return true;
  const pa = parent(a);
  return pa !== null && pa === parent(b) && isDomain(pa);
}

/** The calendar login a CardDAV connection to `url` could reuse, preferring
 *  the one configured on the same mail account. */
export function reusableLogin(
  url: string,
  logins: CalendarLogin[],
  accountId: number,
): CalendarLogin | null {
  const host = hostOf(url);
  if (!host) return null;
  const matching = logins.filter((l) => l.hosts.some((h) => sameServer(host, h)));
  return matching.find((l) => l.accountId === accountId) ?? matching[0] ?? null;
}
