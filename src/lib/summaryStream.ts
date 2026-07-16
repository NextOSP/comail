import type {
  AiCalendarSuggestion,
  AiThreadSummary,
  TimelineEntry,
} from "../ipc/types";

function valueStart(raw: string, key: string): number | null {
  const marker = `"${key}"`;
  const keyAt = raw.indexOf(marker);
  if (keyAt < 0) return null;
  const colon = raw.indexOf(":", keyAt + marker.length);
  if (colon < 0) return null;
  let at = colon + 1;
  while (/\s/.test(raw[at] ?? "")) at += 1;
  return at;
}

function readString(
  raw: string,
  start: number,
): { value: string; end: number } | null {
  if (raw[start] !== '"') return null;
  let escaped = false;
  for (let i = start + 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch !== '"') continue;
    try {
      return { value: JSON.parse(raw.slice(start, i + 1)) as string, end: i + 1 };
    } catch {
      return null;
    }
  }
  return null;
}

function readObject<T>(raw: string, start: number): T | null {
  if (raw[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function objectArray<T>(raw: string, key: string): T[] {
  const start = valueStart(raw, key);
  if (start == null || raw[start] !== "[") return [];
  const values: T[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectAt = -1;
  for (let i = start + 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) objectAt = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objectAt >= 0) {
        const value = readObject<T>(raw, objectAt);
        if (value) values.push(value);
        objectAt = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return values;
}

function stringArray(raw: string, key: string): string[] {
  const start = valueStart(raw, key);
  if (start == null || raw[start] !== "[") return [];
  const values: string[] = [];
  let at = start + 1;
  while (at < raw.length) {
    while (/\s|,/.test(raw[at] ?? "")) at += 1;
    if (raw[at] === "]") break;
    const item = readString(raw, at);
    if (!item) break;
    values.push(item.value);
    at = item.end;
  }
  return values;
}

function optionalString(
  raw: string,
  key: string,
): string | null | undefined {
  const start = valueStart(raw, key);
  if (start == null) return undefined;
  if (raw.startsWith("null", start)) return null;
  return readString(raw, start)?.value;
}

function calendarSuggestion(raw: string): AiCalendarSuggestion | null | undefined {
  const start = valueStart(raw, "calendarSuggestion");
  if (start == null) return undefined;
  if (raw.startsWith("null", start)) return null;
  const value = readObject<AiCalendarSuggestion>(raw, start);
  if (!value) return undefined;
  if (!value.title?.trim() || !value.start?.trim()) return null;
  return {
    title: value.title.trim(),
    start: value.start.trim(),
    end: value.end?.trim() || null,
    allDay: Boolean(value.allDay),
    location: value.location?.trim() || null,
    description: value.description?.trim() || null,
  };
}

/** Recover every complete field available in an unfinished JSON summary.
 * Incomplete strings/objects are held back until their closing token arrives,
 * so the sidebar never flashes broken JSON while streaming. */
export function parsePartialAiSummary(raw: string): AiThreadSummary | null {
  const timeline = objectArray<TimelineEntry>(raw, "timeline").filter(
    (item) => item.actor?.trim() || item.event?.trim(),
  );
  const keyPoints = stringArray(raw, "keyPoints").filter((item) => item.trim());
  const nextAction = optionalString(raw, "nextAction");
  const proposedReply = optionalString(raw, "proposedReply");
  const suggestion = calendarSuggestion(raw);

  const hasVisibleContent =
    timeline.length > 0 ||
    keyPoints.length > 0 ||
    (nextAction != null && nextAction.trim() !== "") ||
    (proposedReply != null && proposedReply.trim() !== "") ||
    suggestion != null;
  if (!hasVisibleContent) return null;

  return {
    timeline,
    keyPoints,
    nextAction: nextAction ?? null,
    proposedReply: proposedReply ?? null,
    calendarSuggestion: suggestion ?? null,
  };
}
