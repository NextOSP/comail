import { useState } from "react";
import { useTranslation } from "react-i18next";
import { folderLeafName } from "../../lib/folders";
import { accountLabel, IS_MAC, MOD_LABEL } from "../../lib/format";
import { aggregateSyncStatuses } from "../../lib/syncStatus";
import { displayShortcut } from "../../keyboard/registry";
import { useAccounts, useFolders, useSettings } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Menu";

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
  const { data: settings } = useSettings();
  // Avatar inbox UI: a quieter bar (home + search icons, no wordmark).
  const avatarUi = settings?.inboxUi === "avatar";
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
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
      <IconButton
        icon={avatarUi ? "home" : "menu"}
        label={t("common:topbar.menu")}
        title={`${t("common:topbar.menu")} (${displayShortcut("mod+\\")})`}
        className="-ml-1"
        onClick={() => set({ sidebarOpen: true })}
      />
      {!avatarUi && (
        <span className="co-wordmark text-sm font-semibold tracking-[0.14em] text-ink-faint uppercase">
          Comail
        </span>
      )}
      <span className="text-base font-medium text-ink-muted">{title}</span>

      {keySequence && (
        <span className="co-fade-in co-kbd" title={t("common:topbar.waitingForChord")}>
          {keySequence.toUpperCase()} …
        </span>
      )}

      <div className="grow" />

      {sync.foregroundSyncing && (
        <span className="flex items-center gap-1.5 text-xs text-ink-muted" title={t("common:topbar.checkingMail")}>
          <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
          <span>{t("common:topbar.checkingMail")}</span>
        </span>
      )}
      {offline && (
        <span className="co-chip !border-transparent !bg-bg2 !text-ink-muted text-xs">
          <span className="size-1.5 rounded-full bg-danger" /> {t("common:topbar.offline")}
        </span>
      )}

      {avatarUi && (
        <IconButton
          icon="search"
          label={t("common:topbar.search")}
          title={`${t("common:topbar.search")} (${displayShortcut("/")})`}
          onClick={() => set({ calendarScreen: false, searchOpen: true, openThreadId: null })}
        />
      )}

      <IconButton
        icon="edit"
        label={t("common:topbar.compose")}
        title={t("common:topbar.composeWithShortcut", { shortcut: displayShortcut("c") })}
        onClick={() => useUi.getState().openComposer({ mode: "new" })}
      />

      <IconButton
        icon={calendarScreen ? "mail" : "calendar"}
        label={calendarScreen ? t("common:topbar.mail") : t("common:topbar.calendar")}
        onClick={() => {
          const s = useUi.getState();
          s.set(
            s.calendarScreen
              ? { calendarScreen: false, calendarFocusDay: null }
              : { calendarScreen: true, calendarDrawer: null, calendarFocusDay: null },
          );
        }}
      />

      <IconButton
        icon="settings"
        label={t("common:topbar.settings")}
        title={t("common:topbar.settingsWithShortcut", { shortcut: `${MOD_LABEL}+,` })}
        onClick={() => set({ panel: "settings" })}
      />

      <button
        className="flex items-center gap-1.5 rounded-full border border-hairline bg-bg1 py-1 pr-2 pl-2.5 text-sm font-medium text-ink hover:bg-bg2"
        title={active ? active.email : t("common:topbar.allAccounts")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // Right-aligned under the pill; the popover clamps itself on-screen.
          setMenuAt(menuAt ? null : { x: r.right - MENU_WIDTH, y: r.bottom + 6 });
        }}
      >
        <span className="max-w-[150px] truncate">
          {active ? accountLabel(active) : t("common:topbar.allAccounts")}
        </span>
        <Icon name="chevronDown" size={11} className="text-ink-faint" />
      </button>
      {menuAt && (
        <Popover x={menuAt.x} y={menuAt.y} minWidth={MENU_WIDTH} onClose={() => setMenuAt(null)}>
          <AccountItem
            label={t("common:topbar.allAccounts")}
            hint={displayShortcut(IS_MAC ? "ctrl+0" : "alt+0")}
            selected={accountFilter == null}
            onClick={() => {
              set({ accountFilter: null });
              setMenuAt(null);
            }}
          />
          {(accounts ?? []).map((a, i) => (
            <AccountItem
              key={a.id}
              label={accountLabel(a)}
              detail={a.displayName?.trim() ? a.email : undefined}
              hint={i < 9 ? displayShortcut(IS_MAC ? `ctrl+${i + 1}` : `alt+${i + 1}`) : undefined}
              sub={a.syncState !== "idle" ? t(`common:syncState.${a.syncState}`) : undefined}
              selected={accountFilter === a.id}
              onClick={() => {
                set({ accountFilter: a.id });
                setMenuAt(null);
              }}
            />
          ))}
        </Popover>
      )}
    </header>
  );
}

const MENU_WIDTH = 256;

function AccountItem({
  label,
  detail,
  sub,
  hint,
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
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      className={`flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-base ${selected ? "bg-bg2" : "hover:bg-bg2"}`}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${selected ? "font-medium text-ink" : "text-ink"}`}>{label}</span>
        {detail && <span className="truncate text-xs text-ink-faint">{detail}</span>}
      </span>
      {sub && <span className="shrink-0 text-xs text-ink-faint">{sub}</span>}
      {hint && <kbd className="co-kbd shrink-0 tabular-nums">{hint}</kbd>}
    </button>
  );
}
