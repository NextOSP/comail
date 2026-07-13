import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { Address } from "../../ipc/types";
import { call } from "../../ipc/commands";
import { parseQuickAdd } from "../../lib/quickadd";
import { useAccounts, useCreateEvent, useUpdateEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

const H_MS = 3_600_000;

function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromInputs(date: string, time: string): number {
  return new Date(`${date}T${time || "09:00"}`).getTime();
}

function parseAttendees(raw: string): Address[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"))
    .map((email) => ({ name: null, email }));
}

/** Create-or-edit meeting modal (`B` / palette "Create event" / popover Edit).
 *  The top field takes natural language ("lunch with bob tomorrow 1pm 45m")
 *  and fills the form; attendees get an emailed ICS invite (or update) through
 *  the normal send pipeline. `eventCreate.eventId` switches it to edit mode. */
export function EventCreate() {
  const { t } = useTranslation();
  const open = useUi((s) => s.eventCreate);
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const { data: accounts } = useAccounts();
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const quickRef = useRef<HTMLInputElement>(null);

  const defaultStart = useMemo(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime() + H_MS;
  }, []);

  const [summary, setSummary] = useState("");
  const [date, setDate] = useState(toDateInput(defaultStart));
  const [time, setTime] = useState(toTimeInput(defaultStart));
  const [durationMin, setDurationMin] = useState(30);
  const [allDay, setAllDay] = useState(false);
  const [attendeesRaw, setAttendeesRaw] = useState("");
  const [location, setLocation] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [description, setDescription] = useState("");
  const [quick, setQuick] = useState("");
  const [quickAiPending, setQuickAiPending] = useState(false);
  const [teamsPending, setTeamsPending] = useState(false);

  // Seed from prefill (create-from-email) each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const p = open.prefill;
    setSummary(p?.summary ?? "");
    const start = p?.startsAt ?? defaultStart;
    setDate(toDateInput(start));
    setTime(toTimeInput(start));
    setDurationMin(
      p?.startsAt != null && p?.endsAt != null
        ? Math.max(15, Math.round((p.endsAt - p.startsAt) / 60_000))
        : 30,
    );
    setAllDay(p?.allDay ?? false);
    setAttendeesRaw((p?.attendees ?? []).map((a) => a.email).join(", "));
    setLocation(p?.location ?? "");
    setJoinUrl(p?.joinUrl ?? "");
    setDescription(p?.description ?? "");
    setQuick("");
    requestAnimationFrame(() => quickRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const quickPreview = useMemo(() => (quick.trim() ? parseQuickAdd(quick) : null), [quick]);

  if (!open) return null;

  const editingId = open.eventId ?? null;
  // Editing keeps the event on its own account; creating follows the filter.
  const accountId =
    open.prefill?.accountId ?? useUi.getState().accountFilter ?? accounts?.[0]?.id ?? null;

  // Natural-language fallback: anything the deterministic parser can't read
  // ("tao meeting ngay mai", any language) goes to the AI intent parser.
  const quickAi = async () => {
    const q = quick.trim();
    if (!q || quickAiPending) return;
    setQuickAiPending(true);
    try {
      const intent = await call("ai_command", { query: q });
      if (intent.kind === "create_event" && intent.startsAt != null) {
        setSummary(intent.summary ?? q);
        setDate(toDateInput(intent.startsAt));
        setTime(toTimeInput(intent.startsAt));
        setAllDay(intent.allDay === true);
        if (intent.allDay !== true && intent.endsAt != null) {
          setDurationMin(Math.max(15, Math.round((intent.endsAt - intent.startsAt) / 60_000)));
        }
        if (intent.location) setLocation(intent.location);
        setQuick("");
      } else {
        pushToast({ kind: "info", message: t("calendar:create.quickAiMiss"), durationMs: 3500 });
      }
    } catch (e) {
      pushToast({ kind: "error", message: errorMessage(e) });
    } finally {
      setQuickAiPending(false);
    }
  };

  const applyQuick = () => {
    if (!quickPreview) return;
    setSummary(quickPreview.summary);
    setDate(toDateInput(quickPreview.startsAt));
    setTime(toTimeInput(quickPreview.startsAt));
    setAllDay(quickPreview.allDay);
    if (!quickPreview.allDay) {
      setDurationMin(Math.round((quickPreview.endsAt - quickPreview.startsAt) / 60_000));
    }
    setQuick("");
  };

  const isMicrosoftAccount =
    accounts?.find((a) => a.id === accountId)?.provider === "microsoft";

  // Mint a real Teams meeting via Graph and drop its join URL into the field,
  // using this event's own date/time/duration. Microsoft accounts only; first
  // use may open the browser once for consent.
  const createTeamsMeeting = async () => {
    if (accountId == null || teamsPending) return;
    setTeamsPending(true);
    try {
      const startsAt = allDay ? fromInputs(date, "00:00") : fromInputs(date, time);
      const endsAt = allDay ? startsAt + 24 * H_MS : startsAt + durationMin * 60_000;
      const { joinUrl: url } = await call("create_teams_meeting", {
        accountId,
        subject: summary.trim() || t("calendar:create.teamsMeeting"),
        startMs: startsAt,
        endMs: endsAt,
      });
      setJoinUrl(url);
      pushToast({ kind: "info", message: t("calendar:create.teamsAdded"), durationMs: 2500 });
    } catch (e) {
      pushToast({
        kind: "error",
        message: t("calendar:create.teamsError", { error: errorMessage(e) }),
      });
    } finally {
      setTeamsPending(false);
    }
  };

  const close = () => set({ eventCreate: null });

  const saving = create.isPending || update.isPending;

  const save = () => {
    if (accountId == null || !summary.trim() || saving) return;
    const startsAt = allDay ? fromInputs(date, "00:00") : fromInputs(date, time);
    const endsAt = allDay ? startsAt + 24 * H_MS : startsAt + durationMin * 60_000;
    const attendees = parseAttendees(attendeesRaw);
    const args = {
      accountId,
      summary: summary.trim(),
      description: description.trim() || null,
      location: location.trim() || null,
      joinUrl: joinUrl.trim() || null,
      startsAt,
      endsAt,
      allDay,
      attendees,
    };
    const done = (createdKey: "created" | "updated") => {
      close();
      pushToast({
        kind: "info",
        message:
          attendees.length > 0
            ? t(`calendar:${createdKey}.withInvites`, { count: attendees.length })
            : t(`calendar:${createdKey}.plain`),
      });
    };
    const onError = (e: unknown) => pushToast({ message: errorMessage(e), kind: "error" });
    if (editingId != null) {
      update.mutate(
        { ...args, eventId: editingId, notify: true },
        { onSuccess: () => done("updated"), onError },
      );
    } else {
      create.mutate(args, { onSuccess: () => done("created"), onError });
    }
  };

  // Keep nonstandard durations (edited/dragged events) selectable as-is.
  const durationOptions = [15, 30, 45, 60, 90, 120].includes(durationMin)
    ? [15, 30, 45, 60, 90, 120]
    : [...[15, 30, 45, 60, 90, 120], durationMin].sort((a, b) => a - b);

  const inputCls =
    "w-full rounded-md border border-hairline bg-bg0 px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent/60";
  const labelCls = "mb-1 block text-[11.5px] font-medium text-ink-faint";

  return (
    <div
      className="co-overlay flex items-start justify-center pt-[12vh]"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div
        data-testid="event-create"
        className="co-fade-in w-[520px] rounded-xl border border-hairline bg-bg1 p-4"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">
            {t(editingId != null ? "calendar:edit.title" : "calendar:create.title")}
          </h2>
          <span className="text-[11.5px] text-ink-faint">{t("calendar:create.saveHint")}</span>
        </header>

        <input
          ref={quickRef}
          className={`${inputCls} mb-1`}
          placeholder={t("calendar:create.quickPlaceholder")}
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (quickPreview) applyQuick();
              else void quickAi();
            }
          }}
        />
        <div className="mb-3 h-4 text-[11.5px] text-accent">
          {!quickPreview && quickAiPending && <span>{t("calendar:create.quickAiPending")}</span>}
          {!quickPreview && !quickAiPending && quick.trim().length >= 3 && (
            <span className="text-ink-faint">{t("calendar:create.quickAiHint")}</span>
          )}
          {quickPreview && (
            <>
              {quickPreview.summary} ·{" "}
              {new Date(quickPreview.startsAt).toLocaleString(i18n.language, {
                weekday: "short",
                month: "short",
                day: "numeric",
                ...(quickPreview.allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
              })}{" "}
              — {t("calendar:create.quickApply")}
            </>
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          <div>
            <label className={labelCls}>{t("calendar:create.summary")}</label>
            <input
              className={inputCls}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className={labelCls}>{t("calendar:create.date")}</label>
              <input
                type="date"
                className={inputCls}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            {!allDay && (
              <>
                <div className="w-28">
                  <label className={labelCls}>{t("calendar:create.time")}</label>
                  <input
                    type="time"
                    className={inputCls}
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </div>
                <div className="w-28">
                  <label className={labelCls}>{t("calendar:create.duration")}</label>
                  <select
                    className={inputCls}
                    value={durationMin}
                    onChange={(e) => setDurationMin(Number(e.target.value))}
                  >
                    {durationOptions.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m}m` : `${m / 60}h`}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <label className="flex items-center gap-1.5 pb-2 text-[12px] text-ink-muted select-none">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              {t("calendar:allDay")}
            </label>
          </div>

          <div>
            <label className={labelCls}>{t("calendar:create.attendees")}</label>
            <input
              className={inputCls}
              placeholder={t("calendar:create.attendeesPlaceholder")}
              value={attendeesRaw}
              onChange={(e) => setAttendeesRaw(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelCls}>{t("calendar:create.location")}</label>
              <input
                className={inputCls}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <div className="mb-1 flex items-center justify-between">
                <label className={`${labelCls} mb-0`}>{t("calendar:create.joinUrl")}</label>
                {isMicrosoftAccount && (
                  <button
                    type="button"
                    disabled={teamsPending}
                    onClick={() => void createTeamsMeeting()}
                    title={t("calendar:create.teamsTip")}
                    className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    {teamsPending && (
                      <span className="co-spinner size-2.5 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
                    )}
                    {t("calendar:create.teamsMeeting")}
                  </button>
                )}
              </div>
              <input
                className={inputCls}
                placeholder="https://meet…"
                value={joinUrl}
                onChange={(e) => setJoinUrl(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={labelCls}>{t("calendar:create.description")}</label>
            <textarea
              className={`${inputCls} min-h-16 resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <footer className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2 hover:text-ink"
            onClick={close}
          >
            {t("common:action.cancel")}
          </button>
          <button
            type="button"
            disabled={!summary.trim() || accountId == null || saving}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            onClick={save}
          >
            {editingId != null
              ? parseAttendees(attendeesRaw).length > 0
                ? t("calendar:edit.saveInvite")
                : t("calendar:edit.save")
              : parseAttendees(attendeesRaw).length > 0
                ? t("calendar:create.saveInvite")
                : t("calendar:create.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
