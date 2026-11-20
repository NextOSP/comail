import { toggleSidebar } from "../../lib/sidebar";
import { useTranslation } from "react-i18next";
import { folderLeafName } from "../../lib/folders";
import { errorMessage } from "../../ipc/errors";
import { accountLabel } from "../../lib/format";
import { syncNowAndRefresh, useManualSyncBusy } from "../../lib/syncNow";
import { aggregateSyncStatuses } from "../../lib/syncStatus";
import { useShortcutHint, withShortcut } from "../../keyboard/registry";
import { useAccounts, useFolders, useSettings } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { IconButton } from "../ui/Button";
import { SyncControl } from "./SyncControl";

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
  const hint = useShortcutHint();
  const { data: folders } = useFolders(accountFilter);
  const { data: settings } = useSettings();
  // Avatar inbox UI: a quieter bar (search icon, no wordmark).
  const avatarUi = settings?.inboxUi === "avatar";
  const sync = aggregateSyncStatuses(syncStatuses, accountFilter);
  const { data: accounts } = useAccounts();
  const manualSyncBusy = useManualSyncBusy(accountFilter);
  const syncing = manualSyncBusy || sync.foregroundSyncing;
  const syncAccount = accounts?.find((a) => a.id === accountFilter);
  const syncLabel = syncAccount
    ? t("common:topbar.syncMailAccount", { account: accountLabel(syncAccount) })
    : t("common:topbar.syncMail");
  const syncMail = () => {
    syncNowAndRefresh(accountFilter).catch((error) => {
      useUi.getState().pushToast({
        kind: "error",
        message: t("common:topbar.syncFailed", { detail: errorMessage(error) }),
      });
    });
  };

  const calendarToday = hint("calendar-today");
  const calendarWeek = hint("calendar-week");
  const composeKey = hint("compose");
  const settingsKey = hint("open-settings");

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
        icon="menu"
        label={t("common:topbar.menu")}
        title={withShortcut(t("common:topbar.menu"), hint("toggle-sidebar"))}
        className="-ml-1"
        onClick={toggleSidebar}
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

      {offline && (
        <span className="co-chip !border-transparent !bg-bg2 !text-ink-muted text-xs">
          <span className="size-1.5 rounded-full bg-danger" /> {t("common:topbar.offline")}
        </span>
      )}

      <SyncControl
        syncing={syncing}
        statusLabel={t("common:topbar.checkingMail")}
        buttonLabel={syncLabel}
        onSync={syncMail}
      />

      {avatarUi && (
        <IconButton
          icon="search"
          label={t("common:topbar.search")}
          title={withShortcut(t("common:topbar.search"), hint("search"))}
          onClick={() => set({ calendarScreen: false, searchOpen: true, openThreadId: null })}
        />
      )}

      <IconButton
        icon="edit"
        label={t("common:topbar.compose")}
        title={
          composeKey
            ? t("common:topbar.composeWithShortcut", { shortcut: composeKey })
            : t("common:topbar.compose")
        }
        onClick={() => useUi.getState().openComposer({ mode: "new" })}
      />

      <IconButton
        icon={calendarScreen ? "mail" : "calendar"}
        label={
          calendarScreen
            ? t("common:topbar.mail")
            : calendarToday && calendarWeek
              ? t("common:topbar.calendar", { today: calendarToday, week: calendarWeek })
              : t("common:sidebar.calendar")
        }
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
        title={
          settingsKey
            ? t("common:topbar.settingsWithShortcut", { shortcut: settingsKey })
            : t("common:topbar.settings")
        }
        onClick={() => set({ panel: "settings" })}
      />

    </header>
  );
}
