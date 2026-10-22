import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDrawer } from "./components/calendar/CalendarDrawer";
import { CalendarScreen } from "./components/calendar/CalendarScreen";
import { EventCreate } from "./components/calendar/EventCreate";
import { EventDetailPopover } from "./components/calendar/EventDetailPopover";
import { CommandPalette } from "./components/palette/CommandPalette";
import { Composer } from "./components/compose/Composer";
import { AttachmentPreviewModal } from "./components/thread/AttachmentPreviewModal";
import { ConversationScreen } from "./components/thread/ConversationScreen";
import { FpsMeter } from "./components/common/FpsMeter";
import { InboxScreen } from "./components/inbox/InboxScreen";
import { MovePopover } from "./components/common/MovePopover";
import { LabelPopover } from "./components/common/LabelPopover";
import { ThreadContextMenu } from "./components/inbox/ThreadContextMenu";
import { AddAccountCard } from "./components/onboarding/Onboarding";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { SearchScreen } from "./components/search/SearchScreen";
import { useSidebarDocked } from "./lib/sidebar";
import { Sidebar } from "./components/common/Sidebar";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ShortcutHelp } from "./components/common/ShortcutHelp";
import { SnippetsPanel } from "./components/settings/SnippetsPanel";
import { SplitsPanel } from "./components/settings/SplitsPanel";
import { LabelsPanel } from "./components/settings/LabelsPanel";
import { SnoozePopover } from "./components/common/SnoozePopover";
import { SplitPopover } from "./components/common/SplitPopover";
import { Toasts } from "./components/common/Toasts";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { TopBar } from "./components/common/TopBar";
import i18n, { setLanguage } from "./i18n";
import { ALL_COMMANDS } from "./keyboard/commands";
import {
  installIframeFocusGuard,
  installKeyboard,
  installMouseNav,
  registerCommands,
} from "./keyboard/registry";
import { call } from "./ipc/commands";
import { checkForUpdate } from "./ipc/updater";
import { useInstallUpdate } from "./lib/useInstallUpdate";
import { applyAccent, DEFAULT_ACCENT } from "./lib/accent";
import { applyFont } from "./lib/font";
import { initSounds } from "./lib/sound";
import { useDockBadge } from "./queries/dockBadge";
import { useBackendEvents } from "./queries/events";
import { flattenThreads, useAccounts, useSearch, useSettings, useThreads } from "./queries/hooks";
import { useUi, type Screen } from "./stores/ui";

registerCommands(ALL_COMMANDS);

/**
 * Preview flag: force the first-run guided setup regardless of saved accounts.
 * Bake `VITE_ONBOARDING=1` into a run or build (`VITE_ONBOARDING=1 pnpm tauri
 * build`) to show it in a packaged app; in dev, `?onboarding` on the URL also
 * works. A normal shipping build leaves this off.
 */
const PREVIEW_ONBOARDING =
  import.meta.env.VITE_ONBOARDING === "1" ||
  (import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("onboarding"));

export default function App() {
  useBackendEvents();
  useDockBadge();
  useThemeSync();
  useStartupUpdateCheck();

  useEffect(() => installKeyboard(), []);
  useEffect(() => installMouseNav(), []);
  useEffect(() => installIframeFocusGuard(), []);
  useEffect(() => initSounds(), []);

  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const openThreadId = useUi((s) => s.openThreadId);
  const searchOpen = useUi((s) => s.searchOpen);
  const composer = useUi((s) => s.composer);
  const calendarScreen = useUi((s) => s.calendarScreen);
  const inboxEmpty = useInboxEmpty();

  // The guided setup runs from first sight of an empty account list until
  // its last step hands off, so it outlives the moment the first account is
  // connected (personalize, shortcuts, and sync come after). Existing
  // installs with accounts never enter it. Derived-state update during
  // render: React re-renders immediately, without painting the inbox first.
  const [inFlow, setInFlow] = useState(PREVIEW_ONBOARDING);
  if (!inFlow && !accountsLoading && accounts?.length === 0) setInFlow(true);

  // Tell the backend the UI is up: it holds back the account sync - whose
  // OAuth token loads are the first OS keyring access - until the window has
  // something to show behind a keychain prompt. The window also launches
  // hidden (no white flash of unstyled webview) and is revealed here.
  useEffect(() => {
    void call("ui_ready", {});
    void (async () => {
      if (!("__TAURI_INTERNALS__" in window)) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (!(await win.isVisible())) {
          await win.show();
          await win.setFocus();
        }
      } catch {
        /* the window may already be visible */
      }
    })();
  }, []);

  // Replies/forwards render inside the conversation (thread stays visible);
  // only a brand-new message takes over the screen as its own compose view.
  const sidebarDocked = useSidebarDocked();
  const screen: Screen = inFlow
    ? "onboarding"
    : composer != null && composer.replyTo == null
      ? "compose"
      : calendarScreen
        ? "calendar"
        : openThreadId != null
          ? "conversation"
          : searchOpen
            ? "search"
            : "inbox";

  return (
    <div className="relative isolate flex h-full flex-col bg-bg0 text-ink">
      <ThreadOrderSync />
      {screen === "inbox" && inboxEmpty && <AppBackdrop />}
      {screen !== "onboarding" && <TopBar />}

      {accountsLoading && !PREVIEW_ONBOARDING ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="co-spinner size-5 rounded-full border-2 border-hairline-strong border-t-accent" />
        </div>
      ) : screen === "onboarding" ? (
        <OnboardingFlow onDone={() => setInFlow(false)} />
      ) : (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <Sidebar docked={sidebarDocked} />
          <div className="flex min-w-0 flex-1 overflow-hidden">
          <ErrorBoundary resetKey={`${screen}:${openThreadId ?? ""}`}>
            {screen === "compose" ? (
              <Composer
                key={`${composer!.mode}-${composer!.replyTo?.id ?? "new"}-${composer!.draftId ?? 0}`}
                state={composer!}
              />
            ) : screen === "calendar" ? (
              <CalendarScreen />
            ) : screen === "conversation" ? (
              <ConversationScreen threadId={openThreadId!} />
            ) : screen === "search" ? (
              <SearchScreen />
            ) : (
              <InboxScreen />
            )}
          </ErrorBoundary>
          <CalendarDrawer />
          </div>
        </div>
      )}
      <CommandPalette />
      <SnoozePopover />
      <MovePopover />
      <LabelPopover />
      <ThreadContextMenu />
      <SplitPopover />
      {screen !== "onboarding" && <EventCreate />}
      {screen !== "onboarding" && <EventDetailPopover />}
      <AttachmentPreviewModal />
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
  const install = useInstallUpdate();
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
          onAction: () => install(update),
          durationMs: 30000,
        });
      } catch {
        // best effort; ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, pushToast, install]);
}

/**
 * Whether the currently visible inbox list is empty (inbox-zero). Mirrors the
 * `empty` computation in InboxScreen; the query is shared via react-query so
 * this costs no extra fetch.
 */
function useInboxEmpty(): boolean {
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const labelFilter = useUi((s) => s.labelFilter);
  const folderFilter = useUi((s) => s.folderFilter);
  const accountFilter = useUi((s) => s.accountFilter);
  const query = useThreads(
    view,
    view === "inbox" ? splitId : null,
    accountFilter,
    labelFilter,
    folderFilter,
  );
  return !query.isLoading && flattenThreads(query.data).length === 0;
}

/**
 * Ambient animated backdrop behind the inbox. Three slow-drifting colour blobs
 * (theme accent/info/star) whose softness is baked into their radial-gradient
 * alpha - motion is pure GPU transform, so unlike a blurred layer it doesn't
 * pin WebKitGTK's compositor. Sits at z-0 under the z-10 content and shows
 * through the translucent glass chrome and inbox-zero screen. Only mounted on
 * inbox-zero - with mail still in the list the chrome sits on
 * plain opaque bg0.
 */
function AppBackdrop() {
  return (
    <div className="co-backdrop" aria-hidden>
      <div className="co-blob co-blob--1" />
      <div className="co-blob co-blob--2" />
      <div className="co-blob co-blob--3" />
    </div>
  );
}

/** Add-account (onboarding form) shown as a modal on demand from Settings. */
function AddAccountOverlay() {
  const open = useUi((s) => s.addAccountOpen);
  const set = useUi((s) => s.set);
  if (!open) return null;
  return (
    <div className="co-overlay flex">
      <AddAccountCard onClose={() => set({ addAccountOpen: false })} />
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
  const folderFilter = useUi((s) => s.folderFilter);
  const accountFilter = useUi((s) => s.accountFilter);
  const searchOpen = useUi((s) => s.searchOpen);
  const searchQuery = useUi((s) => s.searchQuery);
  const set = useUi((s) => s.set);

  const threadsQuery = useThreads(
    view,
    view === "inbox" ? splitId : null,
    accountFilter,
    labelFilter,
    folderFilter,
  );
  const searchResults = useSearch(searchOpen ? searchQuery : "", accountFilter);

  const ids = useMemo(() => {
    if (searchOpen && searchQuery.trim()) {
      return (searchResults.data?.threads ?? []).map((t) => t.id);
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
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const accountThemes = settings?.accountThemes;
  const accentColor = settings?.accentColor ?? DEFAULT_ACCENT;
  // A per-account theme override only applies while the inbox is filtered to
  // that one account. The "All accounts" view (no filter) always uses the
  // global theme - even with a single account connected - so the Preferences
  // theme control never looks dead.
  const effectiveAccountId = accountFilter;

  useEffect(() => {
    if (settings?.theme && settings.theme !== useUi.getState().theme) {
      set({ theme: settings.theme });
    }
  }, [settings?.theme, set]);

  // Follow the persisted interface font.
  const fontFamily = settings?.fontFamily;
  useEffect(() => {
    if (fontFamily === undefined) return;
    applyFont(fontFamily, () =>
      useUi.getState().pushToast({
        kind: "error",
        message: i18n.t("settings:font.loadFailed", { name: fontFamily }),
      }),
    );
  }, [fontFamily]);

  // Follow the persisted language setting.
  useEffect(() => {
    if (settings?.language) setLanguage(settings.language);
  }, [settings?.language]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    // The active account may override the global theme; "All accounts" and
    // accounts with no override fall back to the global setting. A per-account
    // value of "system" (the default the account picker shows) means "inherit
    // the global theme", not a hard OS-follow override - otherwise the global
    // theme control looks dead while an account silently pins the theme.
    const override =
      effectiveAccountId != null ? accountThemes?.[String(effectiveAccountId)] : undefined;
    const chosen = override && override !== "system" ? override : theme;
    const apply = () => {
      const resolved = chosen === "system" ? (mq.matches ? "carbon" : "snow") : chosen;
      document.documentElement.dataset.theme = resolved;
      applyAccent(accentColor, resolved);
      try {
        localStorage.setItem("comail:theme", resolved);
      } catch {
        /* ignore */
      }
    };
    apply();
    if (chosen === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme, effectiveAccountId, accountThemes, accentColor]);
}
