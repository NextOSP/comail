import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import type { Address } from "../../ipc/types";
import { call } from "../../ipc/commands";
import { parseQuickAdd } from "../../lib/quickadd";
import { useAccounts, useCalendars, useCreateEvent, useUpdateEvent } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { AiSparkle, AiSurface } from "../ui/Ai";
import { Button, IconButton } from "../ui/Button";
import { Toggle } from "../ui/Field";
import { Icon, type IconName } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { normalizeHex } from "./calendarColor";

const H_MS = 3_600_000;

/** One form row: muted icon in a fixed gutter, controls to its right
 *  (Proton / Front event editors). */
function Row({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-2 flex w-4 shrink-0 justify-center text-ink-faint" title={label}>
        <Icon name={icon} size={15} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
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

function formatDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
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
  const { data: calendars } = useCalendars();
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
  const [endTime, setEndTime] = useState(toTimeInput(defaultStart + 30 * 60_000));
  const [allDay, setAllDay] = useState(false);
  const [attendeesRaw, setAttendeesRaw] = useState("");
  const [location, setLocation] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [description, setDescription] = useState("");
  const [quick, setQuick] = useState("");
  const [quickAiPending, setQuickAiPending] = useState(false);
  const [teamsPending, setTeamsPending] = useState(false);
  // "cal:<id>" targets a calendar collection, "acct:<id>" an account with no
  // writable calendar (local-only event); null = not yet touched (use default).
  const [calSelection, setCalSelection] = useState<string | null>(null);

  // Seed from prefill (create-from-email) each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const p = open.prefill;
    setSummary(p?.summary ?? "");
    const start = p?.startsAt ?? defaultStart;
    setDate(toDateInput(start));
    setTime(toTimeInput(start));
    setEndTime(
      toTimeInput(
        p?.startsAt != null && p?.endsAt != null && p.endsAt > p.startsAt
          ? p.endsAt
          : start + 30 * 60_000,
      ),
    );
    setAllDay(p?.allDay ?? false);
    setAttendeesRaw((p?.attendees ?? []).map((a) => a.email).join(", "));
    setLocation(p?.location ?? "");
    setJoinUrl(p?.joinUrl ?? "");
    setDescription(p?.description ?? "");
    setQuick("");
    setCalSelection(null);
    requestAnimationFrame(() => quickRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const quickPreview = useMemo(() => (quick.trim() ? parseQuickAdd(quick) : null), [quick]);

  if (!open) return null;

  const editingId = open.eventId ?? null;
  // Editing keeps the event on its own account; creating follows the filter.
  const fallbackAccountId =
    open.prefill?.accountId ?? useUi.getState().accountFilter ?? accounts?.[0]?.id ?? null;

  // Calendar picker (create only): enabled, writable calendars grouped by
  // account; an account without any gets a single local-only option.
  const writable = (calendars ?? []).filter((c) => c.enabled && !c.readOnly);
  const defaultSelectionFor = (accId: number | null): string | null => {
    if (accId == null) return null;
    const cals = writable.filter((c) => c.accountId === accId);
    const def = cals.find((c) => c.isDefault) ?? cals[0];
    return def ? `cal:${def.id}` : `acct:${accId}`;
  };
  const selection = calSelection ?? defaultSelectionFor(fallbackAccountId);
  const selectedCalendar = selection?.startsWith("cal:")
    ? writable.find((c) => c.id === Number(selection.slice(4)))
    : undefined;
  const accountId =
    editingId != null
      ? fallbackAccountId
      : (selectedCalendar?.accountId ??
        (selection?.startsWith("acct:") ? Number(selection.slice(5)) : fallbackAccountId));
  const calendarId = editingId == null ? (selectedCalendar?.id ?? null) : null;
  const calendarOptionCount = (accounts ?? []).reduce(
    (n, a) => n + Math.max(writable.filter((c) => c.accountId === a.id).length, 1),
    0,
  );

  const isMicrosoftAccount =
    accounts?.find((a) => a.id === accountId)?.provider === "microsoft";

  const editCalendar =
    editingId != null && open.prefill?.calendarId != null
      ? (calendars ?? []).find((c) => c.id === open.prefill!.calendarId)
      : undefined;

  // An end time at or before the start rolls over to the next day.
  const endsFromInputs = (startsAt: number) => {
    const e = fromInputs(date, endTime);
    return e <= startsAt ? e + 24 * H_MS : e;
  };

  // Moving the start keeps the event length; the end field follows.
  const changeStart = (next: string) => {
    const oldStart = fromInputs(date, time);
    const span = endsFromInputs(oldStart) - oldStart;
    setTime(next);
    setEndTime(toTimeInput(fromInputs(date, next) + span));
  };

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
    const endsAt = allDay ? startsAt + 24 * H_MS : endsFromInputs(startsAt);
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
        if (intent.allDay !== true) setEndTime(toTimeInput(endsAt));
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
    if (!ad) setEndTime(toTimeInput(endsAt));
    setQuick("");
    maybeAddMeeting(text, s, startsAt, endsAt);
  };

  const close = () => set({ eventCreate: null });

  const saving = create.isPending || update.isPending;

  const save = () => {
    if (accountId == null || !summary.trim() || saving) return;
    const startsAt = allDay ? fromInputs(date, "00:00") : fromInputs(date, time);
    const endsAt = allDay ? startsAt + 24 * H_MS : endsFromInputs(startsAt);
    const attendees = parseAttendees(attendeesRaw);
    const args = {
      accountId,
      calendarId,
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

  const inputCls =
    "h-8 rounded-control border border-hairline bg-bg0 px-2.5 text-[13px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent/60";
  const invites = parseAttendees(attendeesRaw).length > 0;
  const startMs = fromInputs(date, time);

  return (
    <div
      className="co-overlay flex items-start justify-center pt-[10vh]"
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
        className="co-fade-in flex max-h-[84vh] w-[540px] flex-col rounded-xl border border-hairline bg-bg1"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-[13px] font-semibold text-ink-muted">
            {t(editingId != null ? "calendar:edit.title" : "calendar:create.title")}
          </h2>
          <IconButton icon="close" label={t("common:action.cancel")} onClick={close} />
        </header>

        <div className="min-h-0 overflow-y-auto px-5 pt-2 pb-4">
        {/* Smart quick-add: natural language fills the form below. */}
        <AiSurface className="relative">
          <AiSparkle size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
          <input
            ref={quickRef}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="event-quickadd"
            className="co-ai-fill w-full rounded-card py-2 pr-9 pl-8 text-base text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
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
            <Spinner className="co-ai-icon absolute top-1/2 right-2.5 -translate-y-1/2" />
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
                className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition hover:bg-bg2 hover:text-ink"
              >
                <Icon name="close" size={12} />
              </button>
            )
          )}
        </AiSurface>
        <div className="co-ai-icon mt-1 mb-3 h-4 px-1 text-xs">
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

        {/* Title: the big, borderless headline field */}
        <input
          className="mb-3 w-full border-b border-hairline bg-transparent pb-2 text-[20px] font-semibold text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          placeholder={t("calendar:create.summary")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />

        <div className="flex flex-col gap-3">
          {/* When: date, start → end, duration; all-day switch below */}
          <Row icon="clock" label={t("calendar:create.section.when")}>
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label={t("calendar:create.date")}
                className={`${inputCls} w-[9.25rem] shrink-0`}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              {!allDay && (
                <>
                  <input
                    type="time"
                    aria-label={t("calendar:create.start")}
                    className={`${inputCls} w-[7.5rem] shrink-0`}
                    value={time}
                    onChange={(e) => changeStart(e.target.value)}
                  />
                  <span className="text-ink-faint">→</span>
                  <input
                    type="time"
                    aria-label={t("calendar:create.end")}
                    className={`${inputCls} w-[7.5rem] shrink-0`}
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </>
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 text-[12.5px] text-ink-muted">
              <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                <Toggle checked={allDay} onChange={setAllDay} label={t("calendar:allDay")} />
                {t("calendar:allDay")}
              </label>
              {!allDay && (
                <span className="text-ink-faint tabular-nums">
                  {formatDuration(endsFromInputs(startMs) - startMs)}
                </span>
              )}
            </div>
          </Row>

          {/* Calendar: pick the target account+calendar (create); read-only on
              edit - moving an event between calendars isn't supported. */}
          {editingId == null && calendarOptionCount > 1 && (
            <Row icon="calendar" label={t("calendar:create.calendar")}>
              <div className="relative">
                <span
                  className="pointer-events-none absolute top-1/2 left-2.5 size-2.5 -translate-y-1/2 rounded-full"
                  style={{
                    background: normalizeHex(selectedCalendar?.color) ?? "var(--accent)",
                  }}
                />
                <select
                  aria-label={t("calendar:create.calendar")}
                  className={`${inputCls} w-full cursor-pointer pl-7`}
                  value={selection ?? ""}
                  onChange={(e) => setCalSelection(e.target.value)}
                >
                  {(accounts ?? []).map((a) => {
                    const cals = writable.filter((c) => c.accountId === a.id);
                    return (
                      <optgroup key={a.id} label={a.email}>
                        {cals.length === 0 ? (
                          <option value={`acct:${a.id}`}>{t("calendar:create.localOnly")}</option>
                        ) : (
                          cals.map((c) => (
                            <option key={c.id} value={`cal:${c.id}`}>
                              {c.displayName ?? c.url}
                            </option>
                          ))
                        )}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
            </Row>
          )}
          {editingId != null && editCalendar && (
            <Row icon="calendar" label={t("calendar:create.calendar")}>
              <div className="flex h-8 items-center gap-2 text-[13px] text-ink-muted">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: normalizeHex(editCalendar.color) ?? "var(--accent)" }}
                />
                <span className="truncate">
                  {editCalendar.displayName ?? editCalendar.url}
                  <span className="text-ink-faint">
                    {" · "}
                    {accounts?.find((a) => a.id === accountId)?.email ?? ""}
                  </span>
                </span>
              </div>
            </Row>
          )}

          <Row icon="users" label={t("calendar:create.attendees")}>
            <input
              aria-label={t("calendar:create.attendees")}
              className={`${inputCls} w-full`}
              placeholder={t("calendar:create.attendeesPlaceholder")}
              value={attendeesRaw}
              onChange={(e) => setAttendeesRaw(e.target.value)}
            />
          </Row>

          <Row icon="pin" label={t("calendar:create.location")}>
            <input
              aria-label={t("calendar:create.location")}
              className={`${inputCls} w-full`}
              placeholder={t("calendar:create.location")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </Row>

          <Row icon="video" label={t("calendar:create.joinUrl")}>
            <div className="flex items-center gap-2">
              <input
                aria-label={t("calendar:create.joinUrl")}
                className={`${inputCls} w-full`}
                placeholder={t("calendar:create.joinUrl")}
                value={joinUrl}
                onChange={(e) => setJoinUrl(e.target.value)}
              />
              {isMicrosoftAccount && (
                <Button
                  size="sm"
                  icon="video"
                  busy={teamsPending}
                  title={t("calendar:create.teamsTip")}
                  onClick={() => void createTeamsMeeting()}
                >
                  {t("calendar:create.teamsMeeting")}
                </Button>
              )}
            </div>
          </Row>

          <Row icon="notes" label={t("calendar:create.description")}>
            <textarea
              aria-label={t("calendar:create.description")}
              className={`${inputCls} block h-auto min-h-20 w-full resize-y py-2`}
              placeholder={t("calendar:create.description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Row>
        </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <span className="text-[11.5px] text-ink-faint">{t("calendar:create.saveHint")}</span>
          <div className="grow" />
          <Button variant="ghost" onClick={close}>
            {t("common:action.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!summary.trim() || accountId == null}
            busy={saving}
            onClick={save}
          >
            {editingId != null
              ? invites
                ? t("calendar:edit.saveInvite")
                : t("calendar:edit.save")
              : invites
                ? t("calendar:create.saveInvite")
                : t("calendar:create.save")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
