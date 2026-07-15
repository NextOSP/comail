import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { Address } from "../../ipc/types";
import { call } from "../../ipc/commands";
import { parseQuickAdd } from "../../lib/quickadd";
import { useAccounts, useCreateEvent, useUpdateEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

const H_MS = 3_600_000;

/** Small lucide-style line icons (the app has no icon lib; see AttachmentPreviewModal). */
const svg = (children: ReactNode, size = 13) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);
const ICON = {
  sparkle: svg(<path d="M12 2l2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2z" />, 15),
  title: svg(
    <>
      <path d="M4 7V5h16v2" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </>,
  ),
  date: svg(
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>,
  ),
  time: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  ),
  duration: svg(
    <>
      <path d="M10 2h4" />
      <circle cx="12" cy="14" r="8" />
      <path d="M12 14V10" />
    </>,
  ),
  users: svg(
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  ),
  location: svg(
    <>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </>,
  ),
  link: svg(
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>,
  ),
  notes: svg(<path d="M17 10H3M21 6H3M21 14H3M17 18H3" />),
  close: svg(<path d="M18 6L6 18M6 6l12 12" />),
  video: svg(
    <>
      <path d="M15 10l5-3v10l-5-3v-4z" />
      <rect x="2" y="6" width="13" height="12" rx="2" />
    </>,
    12,
  ),
};

/** Uppercase group heading (matches AvailabilityPicker / panelKit SectionLabel). */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
      {children}
    </div>
  );
}

/** Field label with a leading muted icon. */
function FieldLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint">
      {icon}
      {children}
    </label>
  );
}

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

/** Does this natural-language text ask for an online / Teams meeting? */
function wantsOnlineMeeting(text: string): boolean {
  const s = text.toLowerCase();
  if (/\b(teams|zoom|webex|google meet|video call|virtual meeting|online meeting)\b/.test(s))
    return true;
  if (/\bteam meeting\b/.test(s)) return true;
  if (s.includes("online") && (s.includes("meeting") || s.includes("call"))) return true;
  return false;
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

  const isMicrosoftAccount =
    accounts?.find((a) => a.id === accountId)?.provider === "microsoft";

  // Mint a real Teams meeting via Graph and drop its join URL into the field.
  // Microsoft accounts only; first use may open the browser once for consent.
  const fillTeamsMeeting = async (startMs: number, endMs: number, subject: string) => {
    if (accountId == null || teamsPending) return;
    setTeamsPending(true);
    try {
      const { joinUrl: url } = await call("create_teams_meeting", {
        accountId,
        subject: subject.trim() || t("calendar:create.teamsMeeting"),
        startMs,
        endMs,
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

  // Button in the WHERE section: build a meeting from the current form values.
  const createTeamsMeeting = () => {
    const startsAt = allDay ? fromInputs(date, "00:00") : fromInputs(date, time);
    const endsAt = allDay ? startsAt + 24 * H_MS : startsAt + durationMin * 60_000;
    return fillTeamsMeeting(startsAt, endsAt, summary);
  };

  // Quick-add asked for an online meeting ("create team meeting 2pm tmr"):
  // auto-create it with the parsed time. Needs a Microsoft account.
  const maybeAddMeeting = (text: string, subject: string, startsAt: number, endsAt: number) => {
    if (!wantsOnlineMeeting(text)) return;
    if (!isMicrosoftAccount) {
      pushToast({ kind: "info", message: t("calendar:create.teamsNeedsMs"), durationMs: 4000 });
      return;
    }
    void fillTeamsMeeting(startsAt, endsAt, subject);
  };

  // Natural-language fallback: anything the deterministic parser can't read
  // ("tao meeting ngay mai", any language) goes to the AI intent parser.
  const quickAi = async () => {
    const q = quick.trim();
    if (!q || quickAiPending) return;
    setQuickAiPending(true);
    try {
      const intent = await call("ai_command", { query: q });
      if (intent.kind === "create_event" && intent.startsAt != null) {
        const endsAt =
          intent.allDay !== true && intent.endsAt != null
            ? intent.endsAt
            : intent.startsAt + 30 * 60_000;
        setSummary(intent.summary ?? q);
        setDate(toDateInput(intent.startsAt));
        setTime(toTimeInput(intent.startsAt));
        setAllDay(intent.allDay === true);
        if (intent.allDay !== true) {
          setDurationMin(Math.max(15, Math.round((endsAt - intent.startsAt) / 60_000)));
        }
        if (intent.location) setLocation(intent.location);
        setQuick("");
        maybeAddMeeting(q, intent.summary ?? q, intent.startsAt, endsAt);
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
    const text = quick;
    const { summary: s, startsAt, endsAt, allDay: ad } = quickPreview;
    setSummary(s);
    setDate(toDateInput(startsAt));
    setTime(toTimeInput(startsAt));
    setAllDay(ad);
    if (!ad) setDurationMin(Math.round((endsAt - startsAt) / 60_000));
    setQuick("");
    maybeAddMeeting(text, s, startsAt, endsAt);
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
    "w-full rounded-md border border-hairline bg-bg0 px-2.5 py-1.5 text-[13px] text-ink outline-none transition focus:border-accent/60";

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
        <header className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">
            {t(editingId != null ? "calendar:edit.title" : "calendar:create.title")}
          </h2>
          <span className="text-[11.5px] text-ink-faint">{t("calendar:create.saveHint")}</span>
        </header>
        <div className="-mx-4 mt-3 mb-3 border-b border-hairline" />

        {/* Smart quick-add: natural language fills the form below. */}
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-accent">
            {ICON.sparkle}
          </span>
          <input
            ref={quickRef}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="event-quickadd"
            className="w-full rounded-lg border border-accent/40 bg-accent/[0.05] py-2 pr-9 pl-8 text-[13px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent/70 focus-visible:outline-none"
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
          {quickAiPending || teamsPending ? (
            <span className="co-spinner absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
          ) : (
            quick && (
              <button
                type="button"
                onClick={() => {
                  setQuick("");
                  quickRef.current?.focus();
                }}
                title={t("common:action.clear")}
                aria-label={t("common:action.clear")}
                className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent/10 hover:text-ink"
              >
                {ICON.close}
              </button>
            )
          )}
        </div>
        <div className="mt-1 mb-3 h-4 px-1 text-[11.5px] text-accent">
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
 - {t("calendar:create.quickApply")}
            </>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {/* Title */}
          <div>
            <FieldLabel icon={ICON.title}>{t("calendar:create.summary")}</FieldLabel>
            <input
              className={inputCls}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          {/* WHEN */}
          <div>
            <SectionLabel>{t("calendar:create.section.when")}</SectionLabel>
            <div className="flex items-end gap-2">
              <div className="w-44">
                <FieldLabel icon={ICON.date}>{t("calendar:create.date")}</FieldLabel>
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
                    <FieldLabel icon={ICON.time}>{t("calendar:create.time")}</FieldLabel>
                    <input
                      type="time"
                      className={inputCls}
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </div>
                  <div className="w-28">
                    <FieldLabel icon={ICON.duration}>{t("calendar:create.duration")}</FieldLabel>
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
              <label className="ml-auto flex items-center gap-1.5 pb-2 text-[12px] text-ink-muted select-none">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                />
                {t("calendar:allDay")}
              </label>
            </div>
          </div>

          {/* WHO */}
          <div>
            <SectionLabel>{t("calendar:create.section.who")}</SectionLabel>
            <FieldLabel icon={ICON.users}>{t("calendar:create.attendees")}</FieldLabel>
            <input
              className={inputCls}
              placeholder={t("calendar:create.attendeesPlaceholder")}
              value={attendeesRaw}
              onChange={(e) => setAttendeesRaw(e.target.value)}
            />
          </div>

          {/* WHERE */}
          <div>
            <SectionLabel>{t("calendar:create.section.where")}</SectionLabel>
            <div className="flex gap-2">
              <div className="flex-1">
                <div className="mb-1 flex h-6 items-center gap-1.5 text-[11.5px] font-medium text-ink-faint">
                  {ICON.location}
                  {t("calendar:create.location")}
                </div>
                <input
                  className={inputCls}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <div className="mb-1 flex h-6 items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint">
                    {ICON.link}
                    {t("calendar:create.joinUrl")}
                  </span>
                  {isMicrosoftAccount && (
                    <button
                      type="button"
                      disabled={teamsPending}
                      onClick={() => void createTeamsMeeting()}
                      title={t("calendar:create.teamsTip")}
                      className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/[0.06] px-2 py-0.5 text-[11px] font-medium text-accent transition hover:bg-accent/10 disabled:opacity-50"
                    >
                      {teamsPending ? (
                        <span className="co-spinner size-2.5 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
                      ) : (
                        ICON.video
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
          </div>

          {/* NOTES */}
          <div>
            <SectionLabel>{t("calendar:create.section.notes")}</SectionLabel>
            <FieldLabel icon={ICON.notes}>{t("calendar:create.description")}</FieldLabel>
            <textarea
              className={`${inputCls} min-h-16 resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="-mx-4 mt-4 border-b border-hairline" />
        <footer className="mt-3 flex items-center justify-end gap-2">
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
