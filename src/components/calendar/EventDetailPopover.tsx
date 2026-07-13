import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { CalendarEvent, RsvpResponse } from "../../ipc/types";
import { useDeleteEvent, useRsvpEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

function isCancelled(ev: CalendarEvent): boolean {
  return ev.status?.toUpperCase() === "CANCELLED" || ev.method?.toUpperCase() === "CANCEL";
}

function whenLabel(ev: CalendarEvent): string {
  const day = new Date(ev.startsAt).toLocaleDateString(i18n.language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (ev.allDay) return day;
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hour12: false });
  return ev.endsAt != null
    ? `${day} · ${time(ev.startsAt)} – ${time(ev.endsAt)}`
    : `${day} · ${time(ev.startsAt)}`;
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
    <div className="mt-1 text-[13px] break-words text-ink-faint">
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

/** Centered event-detail modal (click any event block/chip/row). Shows the full
 *  event and its actions: Join, RSVP for received invites, Edit/Delete for
 *  events we organize. Mounted globally from App; store-driven. */
export function EventDetailPopover() {
  const open = useUi((s) => s.eventDetail);
  if (!open) return null;
  return <DetailCard key={open.event.id} event={open.event} />;
}

function DetailCard({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const rsvp = useRsvpEvent();
  const del = useDeleteEvent();
  const [confirming, setConfirming] = useState(false);
  const [showAllAttendees, setShowAllAttendees] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);

  // Focus the modal so Esc works immediately.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const close = () => set({ eventDetail: null });

  const cancelled = isCancelled(event);
  const canRsvp = !event.isLocal && !cancelled && event.method?.toUpperCase() !== "REPLY";

  const answer = (response: RsvpResponse) => {
    if (rsvp.isPending) return;
    rsvp.mutate(
      { eventId: event.id, response },
      {
        onSuccess: (updated) => {
          pushToast({ kind: "info", message: t(`calendar:rsvpSent.${response}`) });
          // Keep the open modal in sync with the fresh partstat.
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
          endsAt: event.endsAt ?? event.startsAt + 30 * 60_000,
          description: event.description ?? undefined,
          location: event.location ?? undefined,
          joinUrl: event.joinUrl ?? undefined,
          allDay: event.allDay,
          accountId: event.accountId,
        },
      },
    });
  };

  const confirmDelete = () => {
    if (del.isPending) return;
    const n = event.attendees.length;
    del.mutate(
      { eventId: event.id, notify: true },
      {
        onSuccess: () => {
          close();
          pushToast({
            kind: "info",
            message:
              n > 0
                ? t("calendar:deleted.withInvites", { count: n })
                : t("calendar:deleted.plain"),
          });
        },
        onError: (e) => pushToast({ kind: "error", message: errorMessage(e) }),
      },
    );
  };

  const current = event.rsvpStatus?.toUpperCase() ?? null;
  const options: { response: RsvpResponse; status: string; labelKey: string }[] = [
    { response: "accepted", status: "ACCEPTED", labelKey: "calendar:rsvp.yes" },
    { response: "tentative", status: "TENTATIVE", labelKey: "calendar:rsvp.maybe" },
    { response: "declined", status: "DECLINED", labelKey: "calendar:rsvp.no" },
  ];

  const ATTENDEE_CAP = 12;
  const shownAttendees =
    showAllAttendees ? event.attendees : event.attendees.slice(0, ATTENDEE_CAP);
  const hiddenAttendees = event.attendees.length - shownAttendees.length;

  const hasFooter = canRsvp || event.joinUrl != null || event.isLocal;

  return (
    <div
      className="co-overlay flex items-center justify-center p-[4vh]"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        ref={cardRef}
        data-testid="event-detail"
        tabIndex={-1}
        className="co-fade-in flex max-h-full w-full max-w-[520px] flex-col rounded-xl border border-hairline bg-bg1 outline-none"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header (pinned) */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <h2 className="min-w-0 text-[17px] leading-snug font-semibold text-ink">
            <span className={cancelled ? "line-through" : ""}>
              {event.summary ?? t("calendar:noTitle")}
            </span>
            {cancelled && (
              <span className="ml-2 align-middle text-[10px] font-semibold tracking-wide text-danger uppercase">
                {t("calendar:cancelled")}
              </span>
            )}
          </h2>
          <button
            type="button"
            className="-mt-1 -mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            aria-label={t("calendar:closeAria")}
            onClick={close}
          >
            ✕
          </button>
        </div>

        {/* Body (scrolls when the event is long, so nothing gets clipped) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-2">
          <div className="text-[13px] text-ink-muted">{whenLabel(event)}</div>
          {event.location && !event.location.startsWith("http") && (
            <LocationLine location={event.location} />
          )}
          {event.description && (
            <p className="mt-3 text-[13px] leading-[1.55] whitespace-pre-wrap text-ink-muted select-text">
              {event.description}
            </p>
          )}

          {event.attendees.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("calendar:create.attendees")} · {event.attendees.length}
              </div>
              <div className="flex flex-wrap gap-1">
                {shownAttendees.map((a) => (
                  <span key={a.email} className="co-chip" title={a.email}>
                    {a.partstat === "ACCEPTED" ? "✓ " : a.partstat === "DECLINED" ? "✗ " : ""}
                    {a.name ?? a.email}
                  </span>
                ))}
                {hiddenAttendees > 0 && (
                  <button
                    type="button"
                    className="co-chip cursor-pointer hover:!border-accent/50"
                    onClick={() => setShowAllAttendees(true)}
                  >
                    +{hiddenAttendees}
                  </button>
                )}
                {showAllAttendees && event.attendees.length > ATTENDEE_CAP && (
                  <button
                    type="button"
                    className="co-chip cursor-pointer text-ink-faint hover:!border-accent/50"
                    onClick={() => setShowAllAttendees(false)}
                  >
                    {t("calendar:hideDetails")}
                  </button>
                )}
              </div>
            </div>
          )}
          {event.organizer && !event.isLocal && (
            <div className="mt-3 text-[12px] text-ink-faint">
              {canRsvp
                ? t("calendar:detail.organizerHint", { organizer: event.organizer })
                : t("calendar:byOrganizer", { organizer: event.organizer })}
            </div>
          )}
        </div>

        {/* Footer (pinned): RSVP + actions stay reachable however tall the body */}
        {(hasFooter || confirming) && (
          <div className="border-t border-hairline px-5 pt-3 pb-5">
            {canRsvp && (
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[12px] text-ink-faint">{t("calendar:going")}</span>
                {options.map((o) => (
                  <button
                    key={o.response}
                    type="button"
                    disabled={rsvp.isPending}
                    className={`rounded-md border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                      current === o.status
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-hairline text-ink-muted hover:bg-bg2 hover:text-ink"
                    }`}
                    onClick={() => answer(o.response)}
                  >
                    {t(o.labelKey)}
                  </button>
                ))}
              </div>
            )}

            {confirming ? (
              <div className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-3">
                <p className="text-[12.5px] text-ink">
                  {event.attendees.length > 0
                    ? t("calendar:detail.confirmCancel", { count: event.attendees.length })
                    : t("calendar:detail.confirmDelete")}
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
              (event.joinUrl != null || event.isLocal) && (
                <div className="mt-3 flex items-center gap-1.5">
                  {event.joinUrl && !cancelled && (
                    <button
                      type="button"
                      className="rounded-md bg-accent px-3 py-1 text-[12.5px] font-semibold text-white hover:opacity-90"
                      onClick={() => void openUrl(event.joinUrl!)}
                    >
                      {t("calendar:join")}
                    </button>
                  )}
                  <div className="grow" />
                  {event.isLocal && (
                    <>
                      <button
                        type="button"
                        className="rounded-md border border-hairline px-3 py-1 text-[12.5px] font-medium text-ink-muted hover:bg-bg2 hover:text-ink"
                        onClick={edit}
                      >
                        {t("calendar:detail.edit")}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-hairline px-3 py-1 text-[12.5px] font-medium text-danger hover:bg-danger/10"
                        onClick={() => setConfirming(true)}
                      >
                        {t("calendar:detail.delete")}
                      </button>
                    </>
                  )}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
