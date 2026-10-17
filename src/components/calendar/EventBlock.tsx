import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEvent } from "../../ipc/types";
import { tint } from "./calendarColor";
import { eventEnd, isCancelled, rsvpKind, timeLabel, timeRange } from "./eventUtils";

/** Below this height a block is one line: "Title 09:00". */
const COMPACT_PX = 36;

/** Opaque wash of the calendar color over the surface, so overlapping blocks
 *  and grid lines never show through. */
const wash = (hex: string | null, pct: number) =>
  `color-mix(in srgb, ${tint(hex)} ${pct}%, var(--bg1))`;
/** Readable text in the calendar's hue: the color pulled toward the ink. */
const inkIn = (hex: string | null) =>
  `color-mix(in srgb, ${tint(hex)} 58%, rgb(var(--ink)))`;

/** Fill / bar / text for an event block, all-day bar or chip, by state:
 *  accepted/own events washed in their color, unanswered ones lighter,
 *  tentative lightly striped, declined and cancelled muted. */
export function eventLook(
  ev: CalendarEvent,
  hex: string | null,
): { className: string; style: CSSProperties } {
  if (isCancelled(ev)) {
    return {
      className: "bg-bg2 text-ink-faint line-through",
      style: { borderLeftColor: "var(--hairline-strong)" },
    };
  }
  switch (rsvpKind(ev)) {
    case "declined":
      return {
        className: "bg-bg1 text-ink-faint",
        style: { borderLeftColor: tint(hex, 40) },
      };
    case "tentative":
      return {
        className: "co-hatch",
        style: { backgroundColor: wash(hex, 9), borderLeftColor: tint(hex), color: inkIn(hex) },
      };
    case "needs":
      return {
        className: "",
        style: { backgroundColor: wash(hex, 9), borderLeftColor: tint(hex, 70), color: inkIn(hex) },
      };
    default:
      return {
        className: "",
        style: { backgroundColor: wash(hex, 17), borderLeftColor: tint(hex), color: inkIn(hex) },
      };
  }
}

/** One timed event in the day/week grid. */
export function EventBlock({
  ev,
  hex,
  height,
  now,
  draggable,
  dimmed,
  showResize,
  style,
  onMouseDown,
  onOpen,
  onResizeMouseDown,
}: {
  ev: CalendarEvent;
  hex: string | null;
  height: number;
  now: number;
  draggable: boolean;
  /** the original while its drag ghost is shown */
  dimmed: boolean;
  showResize: boolean;
  style: CSSProperties;
  onMouseDown: (e: React.MouseEvent) => void;
  onOpen: (target: HTMLElement) => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const cancelled = isCancelled(ev);
  const look = eventLook(ev, hex);
  const end = eventEnd(ev);
  const title = ev.summary ?? t("calendar:noTitle");
  const compact = height < COMPACT_PX;
  const place = ev.location && !ev.location.startsWith("http") ? ev.location : null;

  return (
    <button
      type="button"
      aria-label={`${title}, ${timeRange(ev.startsAt, end)}`}
      className={`absolute flex flex-col items-stretch justify-start overflow-hidden rounded-[5px] border-l-[3px] px-1.5 text-left leading-[1.25] outline-offset-1 hover:brightness-[0.98] ${
        compact ? "py-px" : "py-1"
      } ${look.className} ${draggable ? "cursor-grab" : "cursor-pointer"} ${
        dimmed ? "opacity-40" : end < now && !cancelled ? "opacity-55" : ""
      }`}
      // 1px surface ring separates touching / side-by-side blocks.
      style={{ boxShadow: "0 0 0 1px var(--bg1)", ...look.style, ...style }}
      title={`${title}${place ? ` · ${place}` : ""}`}
      onMouseDown={(e) => {
        if (draggable) onMouseDown(e);
        else e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Draggable blocks open from the no-move mouseup path.
        if (!draggable) onOpen(e.currentTarget);
      }}
    >
      {compact ? (
        <div className="flex items-baseline gap-1.5 text-[11.5px]">
          <span className="truncate font-medium">{title}</span>
          <span className="shrink-0 tabular-nums opacity-70">{timeLabel(ev.startsAt)}</span>
        </div>
      ) : (
        <>
          <div
            className="text-[12px] font-medium"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: Math.max(1, Math.floor((height - 22) / 15)),
              overflow: "hidden",
            }}
          >
            {title}
          </div>
          <div className="truncate text-[11px] tabular-nums opacity-70">
            {timeRange(ev.startsAt, end)}
          </div>
        </>
      )}
      {showResize && (
        <span
          aria-hidden
          className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize"
          onMouseDown={onResizeMouseDown}
        />
      )}
    </button>
  );
}
