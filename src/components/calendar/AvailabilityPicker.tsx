import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  computeFreeSlots,
  DEFAULT_SLOT_OPTIONS,
  formatSlotsHtml,
  type Slot,
} from "../../lib/availability";
import { useCalendarEvents } from "../../queries/hooks";

const DAY_MS = 86_400_000;

function slotKey(s: Slot): string {
  return `${s.start}`;
}

/** Share-availability overlay (Cmd+Shift+S in a draft): suggests free slots
 *  from the local calendar; the picked ones are inserted into the email as
 *  formatted HTML. */
export function AvailabilityPicker({
  onInsert,
  onClose,
}: {
  onInsert: (html: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [durationMin, setDurationMin] = useState(30);
  const [days, setDays] = useState(5);

  const now = useMemo(() => Date.now(), []);
  const rangeStart = useMemo(() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [now]);
  // Scan a bit past the visible window so weekend-skipping still fills `days`.
  const { data: events } = useCalendarEvents(rangeStart, rangeStart + (days + 3) * DAY_MS);

  const slots = useMemo(
    () =>
      computeFreeSlots(events ?? [], {
        ...DEFAULT_SLOT_OPTIONS,
        now,
        days: days + 3,
        durationMin,
      }),
    [events, now, days, durationMin],
  );

  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const chosen = slots.filter((s) => !deselected.has(slotKey(s)));

  const toggle = (s: Slot) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      const k = slotKey(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const byDay = useMemo(() => {
    const groups = new Map<number, Slot[]>();
    for (const s of slots) {
      const d = new Date(s.start);
      d.setHours(0, 0, 0, 0);
      const list = groups.get(d.getTime()) ?? [];
      list.push(s);
      groups.set(d.getTime(), list);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [slots]);

  const insert = () => {
    if (chosen.length === 0) return;
    onInsert(formatSlotsHtml(chosen, i18n.language, t("calendar:availability.leadIn")));
    onClose();
  };

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });

  return (
    <div
      className="co-overlay flex items-start justify-center pt-[14vh]"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          insert();
        }
      }}
    >
      <div
        data-testid="availability-picker"
        className="co-fade-in w-[480px] rounded-xl border border-hairline bg-bg1 p-4"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">
            {t("calendar:availability.title")}
          </h2>
          <div className="flex items-center gap-2 text-[12px]">
            <select
              className="rounded-md border border-hairline bg-bg0 px-1.5 py-1 text-ink"
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
              aria-label={t("calendar:create.duration")}
            >
              {[15, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
            <select
              className="rounded-md border border-hairline bg-bg0 px-1.5 py-1 text-ink"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label={t("calendar:availability.days")}
            >
              {[3, 5, 7, 10].map((d) => (
                <option key={d} value={d}>
                  {t("calendar:availability.daysOption", { count: d })}
                </option>
              ))}
            </select>
          </div>
        </header>

        <p className="mb-2 text-[11.5px] text-ink-faint">{t("calendar:availability.hint")}</p>

        <div className="max-h-[46vh] overflow-y-auto">
          {byDay.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ink-faint">
              {t("calendar:availability.none")}
            </p>
          ) : (
            byDay.map(([day, list]) => (
              <section key={day} className="mb-2.5">
                <h3 className="mb-1 text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                  {new Date(day).toLocaleDateString(i18n.language, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((s) => {
                    const off = deselected.has(slotKey(s));
                    return (
                      <button
                        key={slotKey(s)}
                        type="button"
                        className={`rounded-md border px-2.5 py-1 text-[12px] tabular-nums transition-colors ${
                          off
                            ? "border-hairline text-ink-faint line-through opacity-60"
                            : "border-accent/50 bg-accent/10 text-accent"
                        }`}
                        onClick={() => toggle(s)}
                      >
                        {fmtTime(s.start)} – {fmtTime(s.end)}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        <footer className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2 hover:text-ink"
            onClick={onClose}
          >
            {t("common:action.cancel")}
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            onClick={insert}
          >
            {t("calendar:availability.insert", { count: chosen.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}
