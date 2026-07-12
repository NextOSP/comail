/**
 * Natural-language time parsing for snooze / send-later popovers.
 *
 * NOTE: the keyword parsing below ("tomorrow", "next week", "9am", …) is
 * English-only. A future locale would add its own keyword table; only the
 * display labels (via i18n) and preset button names are localized today.
 */

import i18n from "../i18n";

export interface ParsedTime {
  at: number; // ms epoch
  label: string;
}

const DAY = 86_400_000;

function at(base: Date, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function fmt(d: Date): string {
  const now = new Date();
  const time = d.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });
  const startToday = at(now, 0).getTime();
  const dayDiff = Math.floor((at(d, 0).getTime() - startToday) / DAY);
  if (dayDiff === 0) return i18n.t("common:snoozeFmt.today", { time });
  if (dayDiff === 1) return i18n.t("common:snoozeFmt.tomorrow", { time });
  const date = d.toLocaleDateString(i18n.language, { weekday: "short", month: "short", day: "numeric" });
  return i18n.t("common:snoozeFmt.dateAt", { date, time });
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseClock(s: string | undefined): { hour: number; minute: number } | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * Parse simple natural inputs: "tomorrow", "tonight", "next week", "2h",
 * "30m", "3d", "monday 9am", "tomorrow 2pm", "in 2 hours", "9am".
 */
export function parseNaturalTime(input: string, now = new Date()): ParsedTime | null {
  const q = input.trim().toLowerCase().replace(/^in\s+/, "");
  if (!q) return null;

  // Relative durations: 2h, 30m, 3d, 1w, "2 hours", "45 minutes", "3 days"
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(q);
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2][0];
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? DAY : 7 * DAY;
    const d = new Date(now.getTime() + n * mult);
    return { at: d.getTime(), label: fmt(d) };
  }

  const withTime = /^(.+?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/.exec(q);
  const word = (withTime ? withTime[1] : q).trim();
  const clock = withTime ? parseClock(withTime[2]) : null;
  if (withTime && !clock) return null;

  const apply = (d: Date, defH: number, defM = 0) => {
    const t = at(d, clock?.hour ?? defH, clock?.minute ?? defM);
    return { at: t.getTime(), label: fmt(t) };
  };

  switch (word) {
    case "later":
    case "later today": {
      const d = new Date(now.getTime() + 3 * 3_600_000);
      return { at: d.getTime(), label: fmt(d) };
    }
    case "tonight": {
      const t = at(now, clock?.hour ?? 19, clock?.minute ?? 0);
      if (t.getTime() <= now.getTime()) t.setTime(t.getTime() + DAY);
      return { at: t.getTime(), label: fmt(t) };
    }
    case "tomorrow":
      return apply(new Date(now.getTime() + DAY), 9);
    case "weekend":
    case "this weekend":
    case "saturday": {
      const d = new Date(now);
      do d.setTime(d.getTime() + DAY);
      while (d.getDay() !== 6);
      return apply(d, 9);
    }
    case "next week":
    case "monday": {
      const d = new Date(now);
      do d.setTime(d.getTime() + DAY);
      while (d.getDay() !== 1);
      return apply(d, 9);
    }
    case "next month": {
      const d = new Date(now);
      d.setMonth(d.getMonth() + 1, 1);
      return apply(d, 9);
    }
    case "today":
      return clock ? apply(now, 9) : null;
  }

  const wd = WEEKDAYS.indexOf(word.replace(/^next\s+/, ""));
  if (wd >= 0) {
    const d = new Date(now);
    do d.setTime(d.getTime() + DAY);
    while (d.getDay() !== wd);
    return apply(d, 9);
  }

  // Bare clock time: "9am", "14:30" -> next occurrence
  const bare = parseClock(q);
  if (bare) {
    const t = at(now, bare.hour, bare.minute);
    if (t.getTime() <= now.getTime()) t.setTime(t.getTime() + DAY);
    return { at: t.getTime(), label: fmt(t) };
  }

  return null;
}

export interface SnoozePreset extends ParsedTime {
  name: string;
}

/** Preset options shown as buttons in the snooze / send-later popover. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const presets = ["later today", "tonight", "tomorrow", "this weekend", "next week"];
  const seen = new Set<number>();
  const out: SnoozePreset[] = [];
  for (const p of presets) {
    const t = parseNaturalTime(p, now);
    if (t && !seen.has(t.at)) {
      seen.add(t.at);
      out.push({ ...t, name: i18n.t(`common:snoozePreset.${p}`) });
    }
  }
  return out;
}
