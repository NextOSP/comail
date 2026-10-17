import type { AiCalendarSuggestion } from "../ipc/types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Turn an AI calendar suggestion (ISO strings from the model) into the
 *  event-create form's prefill, or null when the start date doesn't parse. */
export function calendarPrefill(suggestion: AiCalendarSuggestion) {
  const startText =
    suggestion.allDay && DATE_ONLY.test(suggestion.start)
      ? `${suggestion.start}T00:00:00`
      : suggestion.start;
  const startsAt = Date.parse(startText);
  if (!Number.isFinite(startsAt)) return null;
  const endText = suggestion.end
    ? suggestion.allDay && DATE_ONLY.test(suggestion.end)
      ? `${suggestion.end}T00:00:00`
      : suggestion.end
    : null;
  const parsedEnd = endText ? Date.parse(endText) : Number.NaN;
  const endsAt = Number.isFinite(parsedEnd)
    ? parsedEnd
    : startsAt + (suggestion.allDay ? 86_400_000 : 30 * 60_000);
  return {
    summary: suggestion.title,
    startsAt,
    endsAt,
    allDay: suggestion.allDay,
    location: suggestion.location ?? undefined,
    description: suggestion.description ?? undefined,
  };
}
