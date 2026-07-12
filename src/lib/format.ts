import i18n from "../i18n";
import type { Address } from "../ipc/types";

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform ?? (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "");

/** Display string for the platform primary modifier. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/** Relative time for list rows: "09:42", "Tue", "Jun 30", "Jan 2 '25". */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const nowD = new Date(now);
  const startOfToday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime();
  if (ms >= startOfToday) {
    return d.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const days = Math.floor((startOfToday - ms) / 86_400_000) + 1;
  if (days <= 6) {
    return d.toLocaleDateString(i18n.language, { weekday: "short" });
  }
  if (d.getFullYear() === nowD.getFullYear()) {
    return d.toLocaleDateString(i18n.language, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "2-digit" });
}

/** Long-form timestamp for message headers. */
export function longTime(ms: number): string {
  return new Date(ms).toLocaleString(i18n.language, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function friendlyDate(ms: number): string {
  return new Date(ms).toLocaleDateString(i18n.language, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function addressName(a: Address): string {
  if (a.name && a.name.trim()) return a.name.trim();
  return a.email.split("@")[0] ?? a.email;
}

export function firstName(a: Address): string {
  return addressName(a).split(/\s+/)[0] ?? addressName(a);
}

/** "Ana, Priya, Tom" style participant summary for a thread row. */
export function participantSummary(participants: Address[], selfEmails: Set<string>): string {
  const others = participants.filter((p) => !selfEmails.has(p.email.toLowerCase()));
  const shown = (others.length > 0 ? others : participants).slice(0, 3);
  const names = shown.map((p, i) => (shown.length > 1 || i > 0 ? firstName(p) : addressName(p)));
  const extra = Math.max(0, (others.length || participants.length) - shown.length);
  return names.join(", ") + (extra > 0 ? ` +${extra}` : "");
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  const num = (n: number, digits: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
  if (bytes < 1024) return `${num(bytes, 0)} ${i18n.t("common:unit.bytes")}`;
  if (bytes < 1024 * 1024) return `${num(bytes / 1024, 0)} ${i18n.t("common:unit.kilobytes")}`;
  return `${num(bytes / (1024 * 1024), 1)} ${i18n.t("common:unit.megabytes")}`;
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function initials(a: Address): string {
  const name = addressName(a);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Stable soft hue from a string, for avatar tinting. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
