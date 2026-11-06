import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { CalendarEvent, EventAttendee, RsvpResponse } from "../../ipc/types";
import { placePopover } from "../../lib/calendarGrid";
import { useAccounts, useCalendars, useDeleteEvent, useRsvpEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { tint, useEventHex } from "./calendarColor";
import { eventEnd, isCancelled, recurrenceKey, rsvpKind, timeRange } from "./eventUtils";
import { CalIcon, type CalIconName } from "./icons";

const CARD_W = 360;

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(i18n.language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function urlHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function initials(a: EventAttendee): string {
  const src = (a.name ?? a.email.split("@")[0]).trim();
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2);
  return s.toUpperCase();
}

/** One icon-led detail row: icon in a fixed 20px column, content beside it. */
function Row({ icon, children }: { icon: CalIconName; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1.5 text-[12.5px] text-ink-muted">
      <span className="flex h-[18px] w-5 shrink-0 items-center justify-center text-ink-faint">
        <CalIcon name={icon} size={15} />
      </span>
      <div className="min-w-0 flex-1 leading-[18px]">{children}</div>
    </div>
  );
}

/** Location line: URLs (a Meet/Zoom link embedded in LOCATION) open directly;
 *  the remaining street address opens in Google Maps. Both are otherwise dead
 *  plain text you can't click. */
function LocationLine({ location }: { location: string }) {
  const urlRe = /https?:\/\/[^\s,;]+/g;
  const urls = location.match(urlRe) ?? [];
  const address = location
    .replace(urlRe, "")
    .replace(/[;,\s]+$/, "")
    .trim();
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return (
    <div className="break-words">
      {address && (
        <button
          type="button"
          className="cursor-pointer text-left hover:text-ink hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(mapsUrl);
          }}
        >
          {address}
        </button>
      )}
      {urls.map((u, i) => (
        <div key={i} className="mt-0.5">
          <button
            type="button"
            className="cursor-pointer break-all text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(u);
            }}
          >
            {u}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Which calendar (and account) the event lives on. */
function CalendarLine({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const { data: calendars } = useCalendars();
  const { data: accounts } = useAccounts();
  const cal = event.calendarId != null ? calendars?.find((c) => c.id === event.calendarId) : null;
  const account = accounts?.find((a) => a.id === event.accountId);
  const name = cal ? (cal.displayName ?? cal.url) : t("calendar:localCalendar");
  return (
    <div className="truncate">
      {name}
      {account && <span className="text-ink-faint"> · {account.email}</span>}
    </div>
  );
}

function partstatClass(partstat: string | null): string {
  switch (partstat?.toUpperCase()) {
    case "ACCEPTED":
      return "bg-accent";
    case "DECLINED":
      return "bg-danger";
    default:
      return "bg-ink-faint";
  }
}

const ATTENDEE_CAP = 6;

function AttendeeList({ attendees, hex }: { attendees: EventAttendee[]; hex: string | null }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? attendees : attendees.slice(0, ATTENDEE_CAP);
  const hidden = attendees.length - shown.length;
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((a) => (
        <div key={a.email} className="flex min-w-0 items-center gap-2" title={a.email}>
          <span className="relative shrink-0">
            <span
              className="flex size-5 items-center justify-center rounded-full text-[9px] font-semibold text-ink"
              style={{ backgroundColor: tint(hex, 22) }}
            >
              {initials(a)}
            </span>
            <span
              className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-bg1 ${partstatClass(a.partstat)}`}
              title={a.partstat ?? undefined}
            />
          </span>
          <span className="truncate text-ink">{a.name ?? a.email}</span>
          {a.name && <span className="truncate text-ink-faint">{a.email}</span>}
        </div>
      ))}
      {(hidden > 0 || (showAll && attendees.length > ATTENDEE_CAP)) && (
        <button
          type="button"
          className="self-start text-[12px] text-ink-faint hover:text-ink hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {hidden > 0 ? t("calendar:moreEvents", { count: hidden }) : t("calendar:showLess")}
        </button>
      )}
    </div>
  );
}

function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);
  return (
    <div>
      <p
        ref={ref}
        className={`leading-[1.55] break-words whitespace-pre-wrap select-text ${expanded ? "" : "line-clamp-4"}`}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          className="mt-0.5 text-[12px] text-ink-faint hover:text-ink hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("calendar:showLess") : t("calendar:showMore")}
        </button>
      )}
    </div>
  );
}

function IconButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: CalIconName;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`flex size-8 items-center justify-center rounded-md text-ink-faint hover:bg-bg2 ${
        danger ? "hover:text-danger" : "hover:text-ink"
      }`}
      onClick={onClick}
    >
      <CalIcon name={icon} size={15} />
    </button>
  );
}

/** Event-detail popover (click any event block/chip/row), anchored beside the
 *  clicked element when the opener passes its rect, centered otherwise. Shows
 *  the full event and its actions: Join, RSVP for received invites,
 *  Edit/Delete. Mounted globally from App; store-driven. */
export function EventDetailPopover() {
  const open = useUi((s) => s.eventDetail);
  if (!open) return null;
  return <DetailCard key={open.event.id} event={open.event} anchor={open.anchor} />;
}

type Anchor = { x: number; y: number; w: number; h: number };

function DetailCard({ event, anchor }: { event: CalendarEvent; anchor?: Anchor }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const rsvp = useRsvpEvent();
  const del = useDeleteEvent();
  const hexFor = useEventHex();
  const [confirming, setConfirming] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);

  // Measure the (hidden) card, then place it beside the anchor or centered.
  useLayoutEffect(() => {
    const place = () => {
      const el = cardRef.current;
      if (!el) return;
      const size = { w: el.offsetWidth, h: el.offsetHeight };
      const vp = { w: window.innerWidth, h: window.innerHeight };
      setPos(
        anchor
          ? placePopover(anchor, size, vp)
          : {
              left: Math.max(8, (vp.w - size.w) / 2),
              top: Math.max(8, (vp.h - size.h) / 2),
            },
      );
    };
    place();
    window.addEventListener("resize", place);
    // Re-place when content height changes (confirm step, show more, RSVP).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (cardRef.current) ro?.observe(cardRef.current);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [anchor]);

  // Focus the card so Esc works immediately.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const close = () => set({ eventDetail: null });

  const cancelled = isCancelled(event);
  // Only real invites have someone to answer: an organizer and a REQUEST.
  const canRsvp =
    !event.isLocal &&
    !cancelled &&
    event.organizer != null &&
    event.method?.toUpperCase() !== "REPLY";
  const hex = hexFor(event);
  const recurrence = recurrenceKey(event.rrule);

  const answer = (response: RsvpResponse) => {
    if (rsvp.isPending) return;
    rsvp.mutate(
      { eventId: event.id, response },
      {
        onSuccess: (updated) => {
          pushToast({ kind: "info", message: t(`calendar:rsvpSent.${response}`) });
          // Keep the open popover in sync with the fresh partstat.
          const cur = useUi.getState().eventDetail;
          if (cur?.event.id === updated.id) set({ eventDetail: { ...cur, event: updated } });
        },
        onError: (e) => pushToast({ kind: "error", message: errorMessage(e) }),
      },
    );
  };

  const edit = () => {
    set({
      eventDetail: null,
      eventCreate: {
        eventId: event.id,
        prefill: {
          summary: event.summary ?? "",
          attendees: event.attendees.map((a) => ({ name: a.name, email: a.email })),
          startsAt: event.startsAt,
          endsAt: eventEnd(event),
          description: event.description ?? undefined,
          location: event.location ?? undefined,
          joinUrl: event.joinUrl ?? undefined,
          allDay: event.allDay,
          accountId: event.accountId,
          calendarId: event.calendarId,
        },
      },
    });
  };

  const confirmDelete = () => {
    if (del.isPending) return;
    const n = event.attendees.length;
    // Only an event we organize sends METHOD:CANCEL; deleting one we don't
    // organize (a received invite, or a server-side item we merely pulled
    // in) just removes our own copy - the server sees a plain DELETE.
    del.mutate(
      { eventId: event.id, notify: event.isLocal },
      {
        onSuccess: () => {
          close();
          pushToast({
            kind: "info",
            message:
              event.isLocal && n > 0
                ? t("calendar:deleted.withInvites", { count: n })
                : t("calendar:deleted.plain"),
          });
        },
        onError: (e) => pushToast({ kind: "error", message: errorMessage(e) }),
      },
    );
  };

  const current = rsvpKind(event);
  const options: { response: RsvpResponse; labelKey: string }[] = [
    { response: "accepted", labelKey: "calendar:rsvp.yes" },
    { response: "tentative", labelKey: "calendar:rsvp.maybe" },
    { response: "declined", labelKey: "calendar:rsvp.no" },
  ];

  const end = eventEnd(event);
  const multiDay = dayLabel(event.startsAt) !== dayLabel(end - (event.allDay ? 1 : 0));

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      {/* Transparent click-catcher: any press outside the card dismisses. */}
      <div className="co-no-drag fixed inset-0 z-40" onMouseDown={close} />
      <div
        ref={cardRef}
        data-testid="event-detail"
        tabIndex={-1}
        className={`fixed z-40 flex flex-col rounded-xl border border-hairline bg-bg1 outline-none ${pos ? "co-pop-in" : ""}`}
        style={{
          width: CARD_W,
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "calc(100vh - 16px)",
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos ? "visible" : "hidden",
          boxShadow: "var(--elev-2)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Title + actions */}
        <div className="flex items-start gap-2.5 py-3 pr-2 pl-4">
          <span
            className="mt-[7px] size-3 shrink-0 rounded-[3px]"
            style={{ backgroundColor: tint(hex) }}
          />
          <h2 className="min-w-0 flex-1 pt-0.5 text-[16px] leading-snug font-semibold break-words text-ink">
            <span className={cancelled ? "line-through" : ""}>
              {event.summary ?? t("calendar:noTitle")}
            </span>
            {cancelled && (
              <span className="ml-2 align-middle text-[10px] font-semibold tracking-wide text-danger uppercase">
                {t("calendar:cancelled")}
              </span>
            )}
          </h2>
          <div className="flex shrink-0 items-center">
            {event.isLocal && (
              <IconButton icon="edit" label={t("calendar:detail.edit")} onClick={edit} />
            )}
            <IconButton
              icon="trash"
              label={t("calendar:detail.delete")}
              danger
              onClick={() => setConfirming(true)}
            />
            <IconButton icon="close" label={t("calendar:closeAria")} onClick={close} />
          </div>
        </div>

        {/* Body (scrolls when the event is long, so nothing gets clipped) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <Row icon="clock">
            <div className="text-ink">
              {dayLabel(event.startsAt)}
              {multiDay && ` – ${dayLabel(end - (event.allDay ? 1 : 0))}`}
            </div>
            <div>{event.allDay ? t("calendar:allDay") : timeRange(event.startsAt, end)}</div>
            {recurrence && <div className="text-ink-faint">{t(recurrence)}</div>}
          </Row>
          {event.location && !event.location.startsWith("http") && (
            <Row icon="pin">
              <LocationLine location={event.location} />
            </Row>
          )}
          {event.joinUrl && (
            <Row icon="video">
              <div className="flex items-center gap-2.5">
                {!cancelled && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12.5px] font-semibold text-white hover:brightness-110"
                    onClick={() => void openUrl(event.joinUrl!)}
                  >
                    {t("calendar:join")}
                  </button>
                )}
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate text-ink-faint hover:text-accent hover:underline"
                  title={event.joinUrl}
                  onClick={() => void openUrl(event.joinUrl!)}
                >
                  {urlHost(event.joinUrl)}
                </button>
              </div>
            </Row>
          )}
          <Row icon="calendar">
            <CalendarLine event={event} />
          </Row>
          {(event.attendees.length > 0 || (event.organizer && !event.isLocal)) && (
            <Row icon="users">
              {event.organizer && !event.isLocal && (
                <div className={`text-ink-faint ${event.attendees.length > 0 ? "mb-1.5" : ""}`}>
                  {t("calendar:byOrganizer", { organizer: event.organizer })}
                </div>
              )}
              {event.attendees.length > 0 && <AttendeeList attendees={event.attendees} hex={hex} />}
            </Row>
          )}
          {event.description && (
            <Row icon="notes">
              <Description text={event.description} />
            </Row>
          )}
        </div>

        {/* Footer: RSVP for invites, or the inline delete confirm step */}
        {confirming ? (
          <div className="border-t border-hairline px-4 py-3">
            <p className="text-[12.5px] text-ink">
              {event.isLocal
                ? event.attendees.length > 0
                  ? t("calendar:detail.confirmCancel", { count: event.attendees.length })
                  : t("calendar:detail.confirmDelete")
                : t("calendar:detail.confirmRemove")}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1 text-[12.5px] text-ink-muted hover:bg-bg2 hover:text-ink"
                onClick={() => setConfirming(false)}
              >
                {t("common:action.cancel")}
              </button>
              <button
                type="button"
                disabled={del.isPending}
                className="rounded-md bg-danger px-3 py-1 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                onClick={confirmDelete}
              >
                {t("calendar:detail.delete")}
              </button>
            </div>
          </div>
        ) : (
          canRsvp && (
            <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2.5">
              <span className="text-[12.5px] text-ink-muted">{t("calendar:going")}</span>
              <div className="flex overflow-hidden rounded-md border border-hairline">
                {options.map((o, i) => {
                  const active = current === o.response;
                  return (
                    <button
                      key={o.response}
                      type="button"
                      disabled={rsvp.isPending}
                      aria-pressed={active}
                      className={`px-3 py-1 text-[12.5px] font-medium transition-colors disabled:opacity-60 ${
                        i > 0 ? "border-l border-hairline" : ""
                      } ${
                        active
                          ? "bg-accent/15 text-accent"
                          : "text-ink-muted hover:bg-bg2 hover:text-ink"
                      }`}
                      onClick={() => answer(o.response)}
                    >
                      {t(o.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
