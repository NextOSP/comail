import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Calendar } from "../../ipc/types";
import { useAccounts, useCalendars } from "../../queries/hooks";
import { HIDDEN_LOCAL_CALENDAR, useUi } from "../../stores/ui";
import { normalizeHex, tint } from "./calendarColor";
import { CalIcon } from "./icons";
import { MiniMonth } from "./MiniMonth";

/** Full-screen calendar's left rail: new event, mini month, calendar toggles. */
export function CalendarSidebar() {
  const { t } = useTranslation();
  const { data: calendars } = useCalendars();
  const { data: accounts } = useAccounts();
  const hidden = useUi((s) => s.calendarHidden);

  const groups = useMemo(() => {
    const byAccount = new Map<number, Calendar[]>();
    for (const c of calendars ?? []) {
      if (!c.enabled) continue;
      const list = byAccount.get(c.accountId) ?? [];
      list.push(c);
      byAccount.set(c.accountId, list);
    }
    return [...byAccount].map(([accountId, list]) => ({
      accountId,
      label: accounts?.find((a) => a.id === accountId)?.email ?? null,
      calendars: list,
    }));
  }, [calendars, accounts]);

  const toggle = (id: number) => {
    const { calendarHidden, set } = useUi.getState();
    set({
      calendarHidden: calendarHidden.includes(id)
        ? calendarHidden.filter((h) => h !== id)
        : [...calendarHidden, id],
    });
  };

  return (
    <aside className="co-hairline-r flex w-[232px] shrink-0 flex-col gap-4 overflow-y-auto bg-bg1 p-3">
      <button
        type="button"
        onClick={() => useUi.getState().set({ eventCreate: {} })}
        className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent text-[12.5px] font-medium text-white hover:opacity-90"
      >
        <CalIcon name="plus" />
        {t("calendar:newEvent")}
      </button>

      <MiniMonth />

      <div>
        <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          {t("calendar:calendars")}
        </div>
        {groups.map((g) => (
          <div key={g.accountId} className="mb-1.5">
            {groups.length > 1 && g.label && (
              <div className="truncate px-1 pt-1 pb-0.5 text-[11px] text-ink-muted">{g.label}</div>
            )}
            {g.calendars.map((c) => (
              <CalendarToggle
                key={c.id}
                label={c.displayName ?? c.url}
                hex={normalizeHex(c.color)}
                checked={!hidden.includes(c.id)}
                onToggle={() => toggle(c.id)}
              />
            ))}
          </div>
        ))}
        <CalendarToggle
          label={t("calendar:invitesLocal")}
          hex={null}
          checked={!hidden.includes(HIDDEN_LOCAL_CALENDAR)}
          onToggle={() => toggle(HIDDEN_LOCAL_CALENDAR)}
        />
      </div>
    </aside>
  );
}

function CalendarToggle({
  label,
  hex,
  checked,
  onToggle,
}: {
  label: string;
  hex: string | null;
  checked: boolean;
  onToggle: () => void;
}) {
  const color = tint(hex);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-bg2"
    >
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border"
        style={{ borderColor: color, backgroundColor: checked ? color : "transparent" }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{label}</span>
    </button>
  );
}
