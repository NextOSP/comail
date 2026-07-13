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
import { Onboarding } from "./components/onboarding/Onboarding";
import { SpaceIntro } from "./components/onboarding/SpaceIntro";
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
import {
  installIframeFocusGuard,
  installKeyboard,
  installMouseNav,
  registerCommands,
} from "./keyboard/registry";
import { call } from "./ipc/commands";
import { checkForUpdate, installUpdate } from "./ipc/updater";
import { hasSeenIntro, markIntroSeen } from "./lib/intro";
import { initSounds } from "./lib/sound";
import { useDockBadge } from "./queries/dockBadge";
import { useBackendEvents } from "./queries/events";
import { flattenThreads, useAccounts, useSearch, useSettings, useThreads } from "./queries/hooks";
import { useUi, type Screen } from "./stores/ui";

registerCommands(ALL_COMMANDS);

/**
 * Preview flag: force the first-run "into space" intro + onboarding, regardless
 * of saved accounts or whether the intro was already seen. Enable it by baking
 * `VITE_INTRO=1` into the build/run - works in dev (`VITE_INTRO=1 pnpm dev`) and
 * in a test build (`VITE_INTRO=1 pnpm tauri build`) so the packaged app can show
 * it on demand. A normal shipping build (no VITE_INTRO) leaves this off, so the
 * intro only plays on a genuine first run. In dev, `?intro` on the URL also works.
 */
const PREVIEW_INTRO =
  import.meta.env.VITE_INTRO === "1" ||
  (import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("intro"));

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

  // First-run "into space" intro. Space is only the intro: it plays, then an exit
  // warp fades the scene out to reveal the onboarding on its gradient backdrop.
  // `cardReady` mounts the card (under the fading space) at reveal; `showIntro`
  // drops the intro once the fade completes.
  const [showIntro, setShowIntro] = useState(() => PREVIEW_INTRO || !hasSeenIntro());
  const [cardReady, setCardReady] = useState(false);

  // Tell the backend when the startup show is out of the way (or absent):
  // it holds back the account sync - whose OAuth token loads are the first
  // OS keyring access - so the keychain prompt never lands on the intro.
  useEffect(() => {
    if (!showIntro) void call("ui_ready", {});
  }, [showIntro]);

  // Replies/forwards render inside the conversation (thread stays visible);
  // only a brand-new message takes over the screen as its own compose view.
  const screen: Screen = PREVIEW_INTRO || (!accountsLoading && accounts?.length === 0)
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
      {(screen === "onboarding" || (screen === "inbox" && inboxEmpty)) && <AppBackdrop />}
      {screen !== "onboarding" && <TopBar />}

      {accountsLoading && !PREVIEW_INTRO ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="co-spinner size-5 rounded-full border-2 border-hairline-strong border-t-accent" />
        </div>
      ) : screen === "onboarding" ? (
        <>
          {showIntro && (
            <SpaceIntro
              onReveal={() => {
                if (!PREVIEW_INTRO) markIntroSeen();
                setCardReady(true);
              }}
              onFinished={() => setShowIntro(false)}
            />
          )}
          {(!showIntro || cardReady) && <Onboarding />}
        </>
      ) : screen === "compose" ? (
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
      {screen !== "onboarding" && <Sidebar />}
      <CommandPalette />
      <SnoozePopover />
      <MovePopover />
      <LabelPopover />
      <SplitPopover />
      {screen !== "onboarding" && <CalendarDrawer />}
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
 * alpha — motion is pure GPU transform, so unlike a blurred layer it doesn't
 * pin WebKitGTK's compositor. Sits at z-0 under the z-10 content and shows
 * through the translucent glass chrome and inbox-zero screen. Only mounted on
 * inbox-zero (and onboarding) — with mail still in the list the chrome sits on
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
