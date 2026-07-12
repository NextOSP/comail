/** Natural-language quick-add for events: "lunch with bob tomorrow 1pm 45m",
 *  "standup mon 9:30 15min", "offsite friday all day", "call sam 3pm london".
 *  Whatever isn't a recognized date/time/duration/timezone token becomes the
 *  title. City/zone names convert the given wall-clock time to local time. */

export interface QuickAddResult {
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
}

const DAY_MS = 86_400_000;
const DEFAULT_DURATION_MIN = 30;
/** When no time is given, events start at the next full hour. */

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** City / zone keywords -> IANA zones (multi-word keys use spaces). DST is
 *  handled by Intl, so "3pm london" is BST in summer, GMT in winter. */
const TIMEZONES: Record<string, string> = {
  utc: "UTC", gmt: "UTC",
  london: "Europe/London", bst: "Europe/London",
  paris: "Europe/Paris", berlin: "Europe/Berlin", madrid: "Europe/Madrid",
  rome: "Europe/Rome", amsterdam: "Europe/Amsterdam", zurich: "Europe/Zurich",
  cet: "Europe/Berlin", cest: "Europe/Berlin",
  "new york": "America/New_York", nyc: "America/New_York",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York",
  chicago: "America/Chicago", ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  denver: "America/Denver", mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  tokyo: "Asia/Tokyo", jst: "Asia/Tokyo",
  seoul: "Asia/Seoul", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong", singapore: "Asia/Singapore",
  sydney: "Australia/Sydney", dubai: "Asia/Dubai",
  mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata", ist: "Asia/Kolkata",
  hanoi: "Asia/Ho_Chi_Minh", saigon: "Asia/Ho_Chi_Minh", hcmc: "Asia/Ho_Chi_Minh",
};

/** Wall-clock time in `zone` at instant `epoch`, as a pseudo-UTC epoch. */
function wallClockIn(epoch: number, zone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
  }).formatToParts(epoch);
  const get = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? "0", 10);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
}

/** Epoch ms for the given wall-clock components in an IANA zone. */
export function zonedTimeToEpoch(
  y: number, mo: number, d: number, h: number, min: number, zone: string,
): number {
  const desired = Date.UTC(y, mo, d, h, min);
  let epoch = desired;
  // Two iterations converge across DST transitions.
  for (let i = 0; i < 2; i++) {
    epoch = epoch - (wallClockIn(epoch, zone) - epoch);
    epoch = desired - (wallClockIn(epoch, zone) - epoch);
  }
  return epoch;
}

interface Parts {
  dayStart: number | null;
  hour: number | null;
  minute: number;
  durationMin: number | null;
  allDay: boolean;
  /** IANA zone the given time is expressed in ("3pm london"). */
  zone: string | null;
  titleWords: string[];
}

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** "3pm" | "3:30pm" | "15:00" | "9.30" -> [hour, minute] */
function parseTimeToken(tok: string): [number, number] | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/i.exec(tok);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  // A bare number with no suffix/colon is too ambiguous to be a time.
  if (!suffix && !m[2]) return null;
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return [hour, minute];
}

/** "30m" | "45min" | "1h" | "1.5h" | "90 minutes" (already split) */
function parseDurationToken(tok: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m|min|mins|minutes|h|hr|hrs|hours)$/i.exec(tok);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const minutes = unit.startsWith("h") ? n * 60 : n;
  return minutes > 0 && minutes <= 24 * 60 ? Math.round(minutes) : null;
}

export function parseQuickAdd(input: string, now: Date = new Date()): QuickAddResult | null {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const p: Parts = {
    dayStart: null,
    hour: null,
    minute: 0,
    durationMin: null,
    allDay: false,
    zone: null,
    titleWords: [],
  };
  const today = startOfDay(now);
  const clean = (w: string | undefined) => (w ?? "").toLowerCase().replace(/[,]$/, "");

  let i = 0;
  while (i < words.length) {
    const raw = words[i];
    const word = clean(raw);

    // Timezone: two-word city first ("new york"), then one word; an optional
    // trailing "time" is swallowed ("london time"). Only after a time/at, or
    // when unambiguous (not also a plausible title word we can't judge - we
    // accept the token whenever it maps to a zone).
    const two = `${word} ${clean(words[i + 1])}`;
    if (p.zone == null && TIMEZONES[two]) {
      p.zone = TIMEZONES[two];
      i += 2;
      if (clean(words[i]) === "time") i++;
      continue;
    }
    // Short tokens that double as ordinary words ("la", "et"…) only count as
    // zones once a time has been parsed ("3pm et"), never inside the title.
    const ambiguousZone = word.length <= 3 && !["utc", "gmt", "pst", "pdt", "est", "edt", "cst", "cdt", "mst", "mdt", "cet", "bst", "jst"].includes(word);
    if (p.zone == null && TIMEZONES[word] && (p.hour != null || !ambiguousZone)) {
      p.zone = TIMEZONES[word];
      i++;
      if (clean(words[i]) === "time") i++;
      continue;
    }

    // "all day"
    if (word === "all" && words[i + 1]?.toLowerCase().replace(/[,]$/, "") === "day") {
      p.allDay = true;
      i += 2;
      continue;
    }
    // "next monday"
    if (word === "next" && words[i + 1] && WEEKDAYS[words[i + 1].toLowerCase()] != null) {
      const target = WEEKDAYS[words[i + 1].toLowerCase()];
      const cur = new Date(today).getDay();
      const delta = ((target - cur + 7) % 7) + 7;
      p.dayStart = today + delta * DAY_MS;
      i += 2;
      continue;
    }
    if (word === "today") {
      p.dayStart = today;
      i++;
      continue;
    }
    if (word === "tomorrow" || word === "tmrw") {
      p.dayStart = today + DAY_MS;
      i++;
      continue;
    }
    if (WEEKDAYS[word] != null && p.dayStart == null) {
      const cur = new Date(today).getDay();
      const delta = (WEEKDAYS[word] - cur + 7) % 7 || 7; // next occurrence
      p.dayStart = today + delta * DAY_MS;
      i++;
      continue;
    }
    // "jul 15" / "15 jul"
    if (MONTHS[word] != null && /^\d{1,2}$/.test(words[i + 1] ?? "")) {
      p.dayStart = monthDay(now, MONTHS[word], parseInt(words[i + 1], 10));
      i += 2;
      continue;
    }
    if (/^\d{1,2}$/.test(word) && MONTHS[(words[i + 1] ?? "").toLowerCase()] != null) {
      p.dayStart = monthDay(now, MONTHS[words[i + 1].toLowerCase()], parseInt(word, 10));
      i += 2;
      continue;
    }
    // "at 3pm" / "at 3 pm" — consume the "at" when a time follows
    if (
      word === "at" &&
      words[i + 1] &&
      (parseTimeToken(clean(words[i + 1])) != null ||
        (/^\d{1,2}$/.test(clean(words[i + 1])) && /^[ap]m$/.test(clean(words[i + 2]))))
    ) {
      i++;
      continue;
    }
    // "for 30m"
    if (word === "for" && words[i + 1] && parseDurationToken(words[i + 1].toLowerCase()) != null) {
      i++;
      continue;
    }
    const time = parseTimeToken(word);
    if (time && p.hour == null) {
      [p.hour, p.minute] = time;
      i++;
      continue;
    }
    // "3 pm" split across two tokens
    if (p.hour == null && /^\d{1,2}$/.test(word) && /^[ap]m$/.test(clean(words[i + 1]))) {
      const merged = parseTimeToken(word + clean(words[i + 1]));
      if (merged) {
        [p.hour, p.minute] = merged;
        i += 2;
        continue;
      }
    }
    const dur = parseDurationToken(word);
    if (dur != null && p.durationMin == null) {
      p.durationMin = dur;
      i++;
      continue;
    }
    p.titleWords.push(raw);
    i++;
  }

  const summary = p.titleWords.join(" ").trim();
  if (!summary) return null;
  // Nothing schedulable recognized -> not a quick-add.
  if (p.dayStart == null && p.hour == null && !p.allDay) return null;

  let dayStart = p.dayStart ?? today;
  if (p.allDay) {
    return { summary, startsAt: dayStart, endsAt: dayStart + DAY_MS, allDay: true };
  }

  let startsAt: number;
  if (p.hour != null) {
    if (p.zone) {
      // "3pm london": that wall-clock time in the named zone, converted.
      const d = new Date(dayStart);
      startsAt = zonedTimeToEpoch(d.getFullYear(), d.getMonth(), d.getDate(), p.hour, p.minute, p.zone);
      if (p.dayStart == null && startsAt <= now.getTime()) {
        const nx = new Date(dayStart + DAY_MS);
        startsAt = zonedTimeToEpoch(nx.getFullYear(), nx.getMonth(), nx.getDate(), p.hour, p.minute, p.zone);
      }
    } else {
      startsAt = dayStart + (p.hour * 60 + p.minute) * 60_000;
      // A time today that already passed (and no explicit day) means tomorrow.
      if (p.dayStart == null && startsAt <= now.getTime()) startsAt += DAY_MS;
    }
  } else {
    // No time: next full hour (or 9:00 on a future day).
    if (dayStart === today) {
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      startsAt = next.getTime();
    } else {
      startsAt = dayStart + 9 * 3_600_000;
    }
  }
  const endsAt = startsAt + (p.durationMin ?? DEFAULT_DURATION_MIN) * 60_000;
  return { summary, startsAt, endsAt, allDay: false };
}

/** Day-start for month/day, using next year if the date already passed. */
function monthDay(now: Date, month: number, day: number): number {
  const d = new Date(now.getFullYear(), month, day);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}
