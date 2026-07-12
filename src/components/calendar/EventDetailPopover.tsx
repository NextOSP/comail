import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { CalendarEvent, RsvpResponse } from "../../ipc/types";
import { placePopover } from "../../lib/calendarGrid";
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

/** Anchored event-detail popover (click any event block/chip/row). Shows the
 *  full event and its actions: Join, RSVP for received invites, Edit/Delete
 *  for events we organize. Mounted globally from App; store-driven. */
export function EventDetailPopover() {
  const open = useUi((s) => s.eventDetail);
  if (!open) return null;
  return <DetailCard key={open.event.id} event={open.event} anchor={open.anchor} />;
}

function DetailCard({
  event,
  anchor,
}: {
  event: CalendarEvent;
  anchor?: { x: number; y: number; w: number; h: number };
}) {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const rsvp = useRsvpEvent();
  const del = useDeleteEvent();
  const [confirming, setConfirming] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure, then place next to the anchor (flip/clamp inside the viewport).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const a = anchor ?? {
      x: window.innerWidth / 2 - 40,
      y: window.innerHeight / 2 - 20,
      w: 80,
      h: 40,
    };
    setPos(
      placePopover(a, { w: width, h: height }, { w: window.innerWidth, h: window.innerHeight }),
    );
  }, [anchor]);

  // Keyboard: Esc closes the popover even while it holds focus.
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

  return (
    <div className="fixed inset-0 z-50" onMouseDown={close}>
      <div
        ref={cardRef}
        data-testid="event-detail"
        tabIndex={-1}
        className="co-pop-in fixed w-[340px] rounded-xl border border-hairline bg-bg1 p-4 outline-none"
        style={{
          boxShadow: "var(--elev-2)",
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos ? "visible" : "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 text-[14px] font-semibold text-ink">
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

        <div className="mt-1 text-[12.5px] text-ink-muted">{whenLabel(event)}</div>
        {event.location && !event.location.startsWith("http") && (
          <div className="mt-0.5 truncate text-[12px] text-ink-faint" title={event.location}>
            {event.location}
          </div>
        )}
        {event.description && (
          <p className="mt-2 max-h-28 overflow-y-auto text-[12.5px] whitespace-pre-wrap text-ink-muted">
            {event.description}
          </p>
        )}

        {event.attendees.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {event.attendees.slice(0, 8).map((a) => (
              <span key={a.email} className="co-chip" title={a.email}>
                {a.partstat === "ACCEPTED" ? "✓ " : a.partstat === "DECLINED" ? "✗ " : ""}
                {a.name ?? a.email}
              </span>
            ))}
            {event.attendees.length > 8 && (
              <span className="co-chip">+{event.attendees.length - 8}</span>
            )}
          </div>
        )}
        {event.organizer && !event.isLocal && (
          <div className="mt-2 text-[11.5px] text-ink-faint">
            {canRsvp
              ? t("calendar:detail.organizerHint", { organizer: event.organizer })
              : t("calendar:byOrganizer", { organizer: event.organizer })}
          </div>
        )}

        {canRsvp && (
          <div className="mt-3 flex items-center gap-1.5">
            <span className="mr-1 text-[11.5px] text-ink-faint">{t("calendar:going")}</span>
            {options.map((o) => (
              <button
                key={o.response}
                type="button"
                disabled={rsvp.isPending}
                className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
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
          <div className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-2.5">
            <p className="text-[12px] text-ink">
              {event.attendees.length > 0
                ? t("calendar:detail.confirmCancel", { count: event.attendees.length })
                : t("calendar:detail.confirmDelete")}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-[12px] text-ink-muted hover:bg-bg2 hover:text-ink"
                onClick={() => setConfirming(false)}
              >
                {t("common:action.cancel")}
              </button>
              <button
                type="button"
                disabled={del.isPending}
                className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                onClick={confirmDelete}
              >
                {t("calendar:detail.delete")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-1.5">
            {event.joinUrl && !cancelled && (
              <button
                type="button"
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90"
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
                  className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:bg-bg2 hover:text-ink"
                  onClick={edit}
                >
                  {t("calendar:detail.edit")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-danger hover:bg-danger/10"
                  onClick={() => setConfirming(true)}
                >
                  {t("calendar:detail.delete")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
