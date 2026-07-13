import { useState } from "react";
import { useTranslation } from "react-i18next";
import { folderLeafName } from "../../lib/folders";
import { accountColor, accountLabel, IS_MAC, MOD_LABEL } from "../../lib/format";
import { aggregateSyncStatuses } from "../../lib/syncStatus";
import { displayShortcut } from "../../keyboard/registry";
import { useAccounts, useFolders } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

export function TopBar() {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const folderFilter = useUi((s) => s.folderFilter);
  const calendarScreen = useUi((s) => s.calendarScreen);
  const searchOpen = useUi((s) => s.searchOpen);
  const offline = useUi((s) => s.offline);
  const syncStatuses = useUi((s) => s.syncStatuses);
  const keySequence = useUi((s) => s.keySequence);
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const { data: accounts } = useAccounts();
  const { data: folders } = useFolders(accountFilter);
  const [menuOpen, setMenuOpen] = useState(false);
  const sync = aggregateSyncStatuses(syncStatuses, accountFilter);

  const active = accounts?.find((a) => a.id === accountFilter);
  const activeFolder = folders?.find((f) => f.id === folderFilter);
  const title = searchOpen
    ? t("common:topbar.search")
    : activeFolder
      ? folderLeafName(activeFolder)
      : t(`common:view.${view}`);

  return (
    <header
      data-tauri-drag-region
      className="co-glass relative z-30 flex h-10 shrink-0 items-center gap-3 px-4 select-none"
    >
      <button
        className="-ml-1 rounded-md p-1.5 text-ink-faint hover:bg-bg2 hover:text-ink"
        title={t("common:topbar.menu")}
        aria-label={t("common:topbar.menu")}
        onClick={() => set({ sidebarOpen: true })}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <span className="text-[12px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
        Comail
      </span>
      <span className="text-[13px] font-medium text-ink-muted">{title}</span>

      {keySequence && (
        <span className="co-fade-in co-kbd" title={t("common:topbar.waitingForChord")}>
          {keySequence.toUpperCase()} …
        </span>
      )}

      <div className="grow" />

      {sync.foregroundSyncing && (
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-muted" title={t("common:topbar.checkingMail")}>
          <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
          <span>{t("common:topbar.checkingMail")}</span>
        </span>
      )}
      {offline && (
        <span className="co-chip !border-transparent !bg-bg2 !text-ink-muted text-[11.5px]">
          <span className="size-1.5 rounded-full bg-danger" /> {t("common:topbar.offline")}
        </span>
      )}

      <button
        className="rounded-md p-1.5 text-ink-faint hover:bg-bg2 hover:text-ink"
        title={calendarScreen ? t("common:topbar.mail") : t("common:topbar.calendar")}
        aria-label={calendarScreen ? t("common:topbar.mail") : t("common:topbar.calendar")}
        onClick={() => {
          const s = useUi.getState();
          s.set(
            s.calendarScreen
              ? { calendarScreen: false, calendarFocusDay: null }
              : { calendarScreen: true, calendarDrawer: null, calendarFocusDay: null },
          );
        }}
      >
        {calendarScreen ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16v16H4z" />
            <path d="M4 6l8 7 8-7" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        )}
      </button>

      <button
        className="rounded-md p-1.5 text-ink-faint hover:bg-bg2 hover:text-ink"
        title={t("common:topbar.settingsWithShortcut", { shortcut: `${MOD_LABEL}+,` })}
        aria-label={t("common:topbar.settings")}
        onClick={() => set({ panel: "settings" })}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <div className="relative">
        <button
          className="flex items-center gap-1.5 rounded-full border border-hairline bg-bg1 py-1 pr-2 pl-2.5 text-[12px] font-medium text-ink hover:bg-bg2"
          title={active ? active.email : t("common:topbar.allAccounts")}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: active ? accountColor(active.email) : "var(--info)" }}
          />
          <span className="max-w-[150px] truncate">
            {active ? accountLabel(active) : t("common:topbar.allAccounts")}
          </span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-faint">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div
              className="co-pop-in absolute right-0 z-40 mt-1.5 min-w-64 rounded-lg border border-hairline bg-bg1 p-1"
              style={{ boxShadow: "var(--elev-2)" }}
            >
              <MenuItem
                label={t("common:topbar.allAccounts")}
                color="var(--info)"
                hint={displayShortcut(IS_MAC ? "ctrl+0" : "alt+0")}
                selected={accountFilter == null}
                onClick={() => {
                  set({ accountFilter: null });
                  setMenuOpen(false);
                }}
              />
              {(accounts ?? []).map((a, i) => (
                <MenuItem
                  key={a.id}
                  label={accountLabel(a)}
                  detail={a.displayName?.trim() ? a.email : undefined}
                  color={accountColor(a.email)}
                  hint={i < 9 ? displayShortcut(IS_MAC ? `ctrl+${i + 1}` : `alt+${i + 1}`) : undefined}
                  sub={a.syncState !== "idle" ? t(`common:syncState.${a.syncState}`) : undefined}
                  selected={accountFilter === a.id}
                  onClick={() => {
                    set({ accountFilter: a.id });
                    setMenuOpen(false);
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function MenuItem({
  label,
  detail,
  sub,
  hint,
  color,
  selected,
  onClick,
}: {
  label: string;
  /** secondary line (e.g. the email when the label is a display name) */
  detail?: string;
  /** right-aligned status text (e.g. "Syncing") */
  sub?: string;
  /** keyboard hint chip, e.g. "⌃1" */
  hint?: string;
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${selected ? "bg-bg2" : "hover:bg-bg2"}`}
      onClick={onClick}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${selected ? "font-medium text-ink" : "text-ink"}`}>{label}</span>
        {detail && <span className="truncate text-[11px] text-ink-faint">{detail}</span>}
      </span>
      {sub && <span className="shrink-0 text-[11px] text-ink-faint">{sub}</span>}
      {hint && (
        <kbd className="shrink-0 rounded border border-hairline bg-bg0 px-1.5 py-0.5 text-[10.5px] leading-none font-medium text-ink-faint tabular-nums">
          {hint}
        </kbd>
      )}
    </button>
  );
}
