import type { CSSProperties } from "react";
import { useMemo } from "react";
import { useCalendars } from "../../queries/hooks";

/** "#RRGGBB" or "#RRGGBBAA" (CalDAV servers send both) -> "#RRGGBB"; anything
 *  else -> null so callers fall back to the theme accent. */
export function normalizeHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const m = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(color.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** calendarId -> normalized hex, for coloring rendered events. */
export function useCalendarColorMap(): Map<number, string> {
  const { data: calendars } = useCalendars();
  return useMemo(() => {
    const map = new Map<number, string>();
    for (const c of calendars ?? []) {
      const hex = normalizeHex(c.color);
      if (hex) map.set(c.id, hex);
    }
    return map;
  }, [calendars]);
}

export interface EventColorStyles {
  /** Timed event block (matches bg-accent/10 border-accent/30). */
  block: CSSProperties;
  /** Locally-created event block (matches bg-accent/20 border-accent/50). */
  localBlock: CSSProperties;
  /** All-day / month chip (matches bg-accent/15 text-accent). */
  chip: CSSProperties;
  dot: CSSProperties;
}

/** Inline styles reproducing the accent alpha looks with a calendar's hex.
 *  Null when the event has no (known) calendar: keep the accent classes. */
export function eventColorStyles(hex: string | null): EventColorStyles | null {
  if (!hex) return null;
  return {
    block: { backgroundColor: `${hex}1a`, borderColor: `${hex}4d` },
    localBlock: { backgroundColor: `${hex}33`, borderColor: `${hex}80` },
    chip: { backgroundColor: `${hex}26`, color: hex },
    dot: { backgroundColor: hex },
  };
}
