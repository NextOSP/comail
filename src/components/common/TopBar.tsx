import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MOD_LABEL } from "../../lib/format";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

export function TopBar() {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const calendarScreen = useUi((s) => s.calendarScreen);
  const searchOpen = useUi((s) => s.searchOpen);
  const offline = useUi((s) => s.offline);
  const syncing = useUi((s) => s.syncing);
  const keySequence = useUi((s) => s.keySequence);
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const { data: accounts } = useAccounts();
  const [menuOpen, setMenuOpen] = useState(false);

  const active = accounts?.find((a) => a.id === accountFilter);

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
      <span className="text-[13px] font-medium text-ink-muted">
        {searchOpen ? t("common:topbar.search") : t(`common:view.${view}`)}
      </span>

      {keySequence && (
        <span className="co-fade-in co-kbd" title={t("common:topbar.waitingForChord")}>
          {keySequence.toUpperCase()} …
        </span>
      )}

      <div className="grow" />

      {syncing && (
        <span
          className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent"
          title={t("common:topbar.syncing")}
        />
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
          className="flex items-center gap-2 rounded-full border border-hairline bg-bg1 px-2.5 py-1 text-[12px] text-ink-muted hover:bg-bg2"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span
            className="size-2 rounded-full"
            style={{ background: active ? "var(--accent)" : "var(--info)" }}
          />
          {active ? active.email : t("common:topbar.allAccounts")}
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div
              className="co-pop-in absolute right-0 z-40 mt-1.5 min-w-56 rounded-lg border border-hairline bg-bg1 p-1"
              style={{ boxShadow: "var(--elev-2)" }}
            >
              <MenuItem
                label={t("common:topbar.allAccounts")}
                selected={accountFilter == null}
                onClick={() => {
                  set({ accountFilter: null });
                  setMenuOpen(false);
                }}
              />
              {(accounts ?? []).map((a) => (
                <MenuItem
                  key={a.id}
                  label={a.email}
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
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-bg2"
      onClick={onClick}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: selected ? "var(--accent)" : "transparent" }}
      />
      <span className="text-ink">{label}</span>
      {sub && <span className="ml-auto text-[11.5px] text-ink-faint">{sub}</span>}
    </button>
  );
}
