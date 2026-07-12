import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDrawer } from "./components/calendar/CalendarDrawer";
import { CommandPalette } from "./components/palette/CommandPalette";
import { Composer } from "./components/compose/Composer";
import { ConversationScreen } from "./components/thread/ConversationScreen";
import { FpsMeter } from "./components/common/FpsMeter";
import { InboxScreen } from "./components/inbox/InboxScreen";
import { MovePopover } from "./components/common/MovePopover";
import { LabelPopover } from "./components/common/LabelPopover";
import { Onboarding } from "./components/onboarding/Onboarding";
import { SearchScreen } from "./components/search/SearchScreen";
import { Sidebar } from "./components/common/Sidebar";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ShortcutHelp } from "./components/common/ShortcutHelp";
import { SnippetsPanel } from "./components/settings/SnippetsPanel";
import { SplitsPanel } from "./components/settings/SplitsPanel";
import { LabelsPanel } from "./components/settings/LabelsPanel";
import { SnoozePopover } from "./components/common/SnoozePopover";
import { SplitPopover } from "./components/common/SplitPopover";
import { Toasts } from "./components/common/Toasts";
import { TopBar } from "./components/common/TopBar";
import { setLanguage } from "./i18n";
import { ALL_COMMANDS } from "./keyboard/commands";
import { installKeyboard, registerCommands } from "./keyboard/registry";
import { checkForUpdate, installUpdate } from "./ipc/updater";
import { useBackendEvents } from "./queries/events";
import { flattenThreads, useAccounts, useSearch, useSettings, useThreads } from "./queries/hooks";
import { useUi, type Screen } from "./stores/ui";

registerCommands(ALL_COMMANDS);

export default function App() {
  useBackendEvents();
  useThemeSync();
  useStartupUpdateCheck();

  useEffect(() => installKeyboard(), []);

  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const openThreadId = useUi((s) => s.openThreadId);
  const searchOpen = useUi((s) => s.searchOpen);
  const composer = useUi((s) => s.composer);

  const screen: Screen = !accountsLoading && accounts?.length === 0
    ? "onboarding"
    : openThreadId != null
      ? "conversation"
      : searchOpen
        ? "search"
        : "inbox";

  return (
    <div className="relative flex h-full flex-col bg-bg0 text-ink">
      <ThreadOrderSync />
      {screen !== "onboarding" && <TopBar />}

      {accountsLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="co-spinner size-5 rounded-full border-2 border-hairline-strong border-t-accent" />
        </div>
      ) : screen === "onboarding" ? (
        <Onboarding />
      ) : screen === "conversation" ? (
        <ConversationScreen threadId={openThreadId!} />
      ) : screen === "search" ? (
        <SearchScreen />
      ) : (
        <InboxScreen />
      )}

      {/* global overlays; replies to the open thread render inline in the
          conversation instead of as a bottom sheet */}
      {composer && composer.replyTo?.threadId !== openThreadId && (
        <Composer
          key={`${composer.mode}-${composer.replyTo?.id ?? "new"}-${composer.draftId ?? 0}`}
          state={composer}
        />
      )}
      {screen !== "onboarding" && <Sidebar />}
      <CommandPalette />
      <SnoozePopover />
      <MovePopover />
      <LabelPopover />
      <SplitPopover />
      {screen !== "onboarding" && <CalendarDrawer />}
      <ShortcutHelp />
      <SettingsPanel />
      <SnippetsPanel />
      <SplitsPanel />
      <LabelsPanel />
      {screen !== "onboarding" && <AddAccountOverlay />}
      <Toasts />
      <FpsMeter />
    </div>
  );
}

/**
 * On launch, quietly ask GitHub whether a newer signed build exists. If one
 * does, offer it as a toast with a "Restart & install" action. Failures
 * (offline, no published release, mock mode) are swallowed - this is best
 * effort and must never interrupt startup.
 */
function useStartupUpdateCheck() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const update = await checkForUpdate();
        if (!update || cancelled) return;
        pushToast({
          kind: "info",
          message: t("settings:about.updateAvailable", { version: update.version }),
          actionLabel: t("settings:about.restartInstall"),
          onAction: () => void installUpdate(update),
          durationMs: 30000,
        });
      } catch {
        // best effort; ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, pushToast]);
}

/** Add-account (onboarding form) shown as a modal on demand from Settings. */
function AddAccountOverlay() {
  const open = useUi((s) => s.addAccountOpen);
  const set = useUi((s) => s.set);
  if (!open) return null;
  return (
    <div className="co-overlay flex">
      <Onboarding onClose={() => set({ addAccountOpen: false })} />
    </div>
  );
}

/**
 * Keeps ui.visibleThreadIds in sync with the current list order so
 * J/K + auto-advance work identically from the list, a conversation,
 * or search results.
 */
function ThreadOrderSync() {
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const labelFilter = useUi((s) => s.labelFilter);
  const accountFilter = useUi((s) => s.accountFilter);
  const searchOpen = useUi((s) => s.searchOpen);
  const searchQuery = useUi((s) => s.searchQuery);
  const set = useUi((s) => s.set);

  const threadsQuery = useThreads(
    view,
    view === "inbox" ? splitId : null,
    accountFilter,
    labelFilter,
  );
  const searchResults = useSearch(searchOpen ? searchQuery : "");

  const ids = useMemo(() => {
    if (searchOpen && searchQuery.trim()) {
      return (searchResults.data ?? []).map((t) => t.id);
    }
    return flattenThreads(threadsQuery.data).map((t) => t.id);
  }, [searchOpen, searchQuery, searchResults.data, threadsQuery.data]);

  useEffect(() => {
    const cur = useUi.getState().visibleThreadIds;
    if (cur.length === ids.length && cur.every((v, i) => v === ids[i])) return;
    set({ visibleThreadIds: ids });
  }, [ids, set]);

  return null;
}

/** Applies the theme setting to <html data-theme> and follows the OS in system mode. */
function useThemeSync() {
  const { data: settings } = useSettings();
  const theme = useUi((s) => s.theme);
  const set = useUi((s) => s.set);

  useEffect(() => {
    if (settings?.theme && settings.theme !== useUi.getState().theme) {
      set({ theme: settings.theme });
    }
  }, [settings?.theme, set]);

  // Follow the persisted language setting.
  useEffect(() => {
    if (settings?.language) setLanguage(settings.language);
  }, [settings?.language]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (mq.matches ? "carbon" : "snow") : theme;
      document.documentElement.dataset.theme = resolved;
      try {
        localStorage.setItem("comail:theme", resolved);
      } catch {
        /* ignore */
      }
    };
    apply();
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
}
