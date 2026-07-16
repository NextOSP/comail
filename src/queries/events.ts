import { useEffect } from "react";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { onEvent, subscribeEvent } from "../ipc/events";
import { MOCK_MODE } from "../ipc/mock";
import type {
  AccountStateEvent,
  CalendarEvent,
  NewEventInfo,
  Settings,
  SyncProgressEvent,
  SyncStatus,
} from "../ipc/types";
import { parseMailto } from "../lib/mailto";
import { extendStartupQuiet, markSoundsReady, playSound } from "../lib/sound";
import { normalizeSyncStatus } from "../lib/syncStatus";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

let notifyPermission: boolean | null = null;

// Sends that auth-paused and already have a "sign in again" warning on screen,
// keyed by action id -> toast id. A stuck send retries every sync cycle, so this
// collapses the repeats into one persistent toast that clears when the send
// finally goes through, fails, or is cancelled.
const pausedSendToasts = new Map<number, number>();

/** Mark mail-derived queries stale and refetch the ones currently on screen. */
async function refreshMailQueries() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["threads"] }),
    queryClient.invalidateQueries({ queryKey: ["unreadCounts"] }),
    queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    queryClient.invalidateQueries({ queryKey: ["emailStats"] }),
  ]);
}

/** Setting + OS-permission gate shared by every desktop notification. */
async function notificationsAllowed(): Promise<boolean> {
  const settings = queryClient.getQueryData<Settings>(["settings"]);
  if (settings && !settings.notificationsEnabled) return false;
  const { isPermissionGranted, requestPermission } = await import(
    "@tauri-apps/plugin-notification"
  );
  if (notifyPermission == null) {
    notifyPermission = await isPermissionGranted();
    if (!notifyPermission) {
      notifyPermission = (await requestPermission()) === "granted";
    }
  }
  return notifyPermission;
}

/** Bring the (possibly tray-hidden) window forward. Best-effort. */
async function focusMainWindow() {
  if (MOCK_MODE) return;
  try {
    await call("focus_main_window", {});
  } catch {
    // best-effort
  }
}

/** Desktop reminder before a meeting starts; clicking it joins the call. */
async function notifyMeetingReminder(event: CalendarEvent, occurrenceStart: number) {
  if (MOCK_MODE) return;
  try {
    if (!(await notificationsAllowed())) return;
    const plugin = await import("@tauri-apps/plugin-notification");

    const time = new Date(occurrenceStart).toLocaleTimeString(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const where = event.location && !event.location.startsWith("http") ? ` · ${event.location}` : "";
    plugin.sendNotification({
      title: event.summary ?? i18n.t("calendar:noTitle"),
      body: i18n.t("calendar:reminderBody", { time }) + where,
    });

    // Click-to-join (best effort: notification actions aren't supported on
    // every platform; the meeting still shows in the calendar either way).
    if (event.joinUrl && typeof plugin.onAction === "function") {
      try {
        const listener = await plugin.onAction(() => {
          void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(event.joinUrl!));
        });
        // The reminder is only actionable around its start; drop the listener after.
        setTimeout(() => void listener.unregister(), 15 * 60_000);
      } catch {
        /* platform without notification actions */
      }
    }
  } catch {
    // notifications are best-effort
  }
}

/** Desktop notification for new calendar events an incremental sync pulled in. */
async function notifyNewEvents(events: NewEventInfo[]) {
  if (MOCK_MODE || events.length === 0) return;
  try {
    if (!(await notificationsAllowed())) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");

    if (events.length === 1) {
      const ev = events[0];
      const when = ev.allDay
        ? new Date(ev.startsAt).toLocaleDateString(i18n.language, {
            month: "short",
            day: "numeric",
          })
        : new Date(ev.startsAt).toLocaleString(i18n.language, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
      sendNotification({
        title: ev.summary ?? i18n.t("calendar:noTitle"),
        body: i18n.t("calendar:newEventBody", { when }),
      });
    } else {
      sendNotification({
        title: "Comail",
        body: i18n.t("calendar:newEvents", { count: events.length }),
      });
    }
  } catch {
    // notifications are best-effort
  }
}

/** Wire backend push events into targeted query invalidations. Mount once. */
export function useBackendEvents() {
  // Clicking any desktop notification should bring the app forward - the window
  // is hidden to the tray on close, so macOS activating the process alone shows
  // nothing. Registered once, independent of the backend-event listeners below.
  useEffect(() => {
    if (MOCK_MODE) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { onAction } = await import("@tauri-apps/plugin-notification");
        if (typeof onAction !== "function") return;
        const listener = await onAction(() => void focusMainWindow());
        if (cancelled) void listener.unregister();
        else unlisten = () => void listener.unregister();
      } catch {
        // platform without notification actions
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const offs = [
      onEvent("mail:new", () => {
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        void queryClient.invalidateQueries({ queryKey: ["emailStats"] });
        // calendar invites arrive by mail
        void queryClient.invalidateQueries({ queryKey: ["events"] });
        playSound("new-email");
      }),
      onEvent("mail:updated", ({ threadIds }) => {
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        for (const id of threadIds) {
          void queryClient.invalidateQueries({ queryKey: ["thread", id] });
        }
      }),
      onEvent("thread:woke", ({ threadId }) => {
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
      }),
      onEvent("action:state", ({ actionId, state, error }) => {
        const ui = useUi.getState();
        // Clear the send's undo state once it reaches a terminal (or paused)
        // state, so the "Sending…" badge doesn't linger after the send finished,
        // failed, or stalled waiting on re-authentication.
        if (
          (state === "done" || state === "failed" || state === "paused") &&
          ui.lastUndo?.type === "send" &&
          ui.lastUndo.actionId === actionId
        ) {
          ui.set({ lastUndo: null });
        }
        // Once a paused send resolves (sent, gave up, or was cancelled), drop its
        // lingering "sign in again" toast.
        if (state === "done" || state === "failed" || state === "cancelled") {
          const toastId = pausedSendToasts.get(actionId);
          if (toastId != null) {
            ui.dismissToast(toastId);
            pausedSendToasts.delete(actionId);
          }
        }
        if (state === "failed") {
          ui.pushToast({
            kind: "error",
            message: error ? `Couldn't send: ${error}` : "Sending failed",
          });
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
          void queryClient.invalidateQueries({ queryKey: ["thread"] });
        } else if (state === "paused") {
          // The send couldn't authenticate: it's parked in the outbox, not sent.
          // Warn once (retries keep the same action id) with a persistent,
          // actionable toast instead of leaving the message to vanish silently.
          if (!pausedSendToasts.has(actionId)) {
            const toastId = ui.pushToast({
              kind: "error",
              message: error
                ? `Couldn't send: ${error}. Sign in to your account again.`
                : "Couldn't send: sign in to your account again.",
              durationMs: 60 * 60 * 1000,
              actionLabel: "Account settings",
              onAction: () =>
                useUi.getState().set({ panel: "settings", settingsTab: "accounts" }),
            });
            pausedSendToasts.set(actionId, toastId);
          }
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
          void queryClient.invalidateQueries({ queryKey: ["thread"] });
        } else if (state === "done") {
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
          void queryClient.invalidateQueries({ queryKey: ["emailStats"] });
        }
      }),
      onEvent("network:state", ({ online }) => {
        useUi.getState().set({ offline: !online });
      }),
      onEvent("calendar:updated", () => {
        void queryClient.invalidateQueries({ queryKey: ["events"] });
        void queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
        void queryClient.invalidateQueries({ queryKey: ["calendars"] });
      }),
      onEvent("calendar:new", ({ events }) => {
        void queryClient.invalidateQueries({ queryKey: ["events"] });
        void notifyNewEvents(events);
      }),
      onEvent("calendar:reminder", ({ event, occurrenceStart }) => {
        void notifyMeetingReminder(event, occurrenceStart);
      }),
      onEvent("calendar:conflict", ({ summary }) => {
        useUi.getState().pushToast({
          kind: "error",
          message: i18n.t("calendar:syncConflict", {
            summary: summary ?? i18n.t("calendar:noTitle"),
          }),
        });
        void queryClient.invalidateQueries({ queryKey: ["events"] });
      }),
      onEvent("deeplink:mailto", (url) => {
        const fields = parseMailto(url);
        if (!fields) return;
        // A mailto click should land the user on a fresh, prefilled compose
        // window: clear any overlay/panel first, then open the composer.
        const ui = useUi.getState();
        ui.set({ panel: null, paletteOpen: false, addAccountOpen: false });
        ui.openComposer({
          mode: "new",
          initial: {
            to: fields.to,
            cc: fields.cc.length ? fields.cc : undefined,
            bcc: fields.bcc.length ? fields.bcc : undefined,
            subject: fields.subject,
            body: fields.body,
          },
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let subscriptionsReady = false;
    let eventRevision = 0;
    let lastRecoveryAt = 0;
    const unlisteners: Array<() => void> = [];
    const foregroundSeen = new Set<number>();
    const authoritativeAccounts = new Set<number>();

    const observeStatus = (status: SyncStatus, previous: SyncStatus | undefined) => {
      if (status.foregroundPhase === "inbox") {
        foregroundSeen.add(status.accountId);
        // A foreground catch-up may outlast the fixed startup grace period.
        extendStartupQuiet();
        return;
      }

      const hadForegroundWork =
        previous?.foregroundPhase === "inbox" || foregroundSeen.has(status.accountId);
      foregroundSeen.delete(status.accountId);
      if (hadForegroundWork) {
        markSoundsReady();
        void refreshMailQueries();
      }
    };

    const applyStatus = (value: unknown, fromEvent = true) => {
      const status = normalizeSyncStatus(value);
      if (!status || cancelled) return;
      if (fromEvent) eventRevision += 1;
      const previous = useUi.getState().syncStatuses[status.accountId];
      useUi.getState().upsertSyncStatus(status);
      observeStatus(status, previous);
    };

    const applySnapshot = (statuses: SyncStatus[]) => {
      const previous = useUi.getState().syncStatuses;
      useUi.getState().replaceSyncStatuses(statuses);
      for (const status of statuses) observeStatus(status, previous[status.accountId]);

      // The subscribed authoritative snapshot makes an idle startup safe: the
      // backend has already established its no-notification startup baseline.
      if (statuses.every((status) => status.foregroundPhase === "idle")) {
        markSoundsReady();
      }
    };

    const refreshStatusSnapshot = async () => {
      if (!subscriptionsReady || cancelled) return;
      try {
        // If an event lands while the command is in flight, discard that
        // potentially older response and read once more. This preserves the
        // subscribe-then-snapshot ordering guarantee without UI flicker.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const revisionBefore = eventRevision;
          const rawStatuses = await call("get_sync_status", {});
          const statuses = rawStatuses
            .map(normalizeSyncStatus)
            .filter((status): status is SyncStatus => status != null);
          if (cancelled) return;
          if (revisionBefore === eventRevision) {
            for (const raw of rawStatuses) {
              if (Object.prototype.hasOwnProperty.call(raw, "foregroundPhase")) {
                authoritativeAccounts.add(raw.accountId);
              }
            }
            applySnapshot(statuses);
            return;
          }
        }
      } catch {
        // Transient startup/focus failures are retried on the next recovery.
      }
    };

    const legacyProgress = (progress: SyncProgressEvent): SyncStatus => {
      const previous = useUi.getState().syncStatuses[progress.accountId];
      if (progress.phase === "idle") {
        return {
          accountId: progress.accountId,
          state: "idle",
          foregroundPhase: "idle",
          background: previous?.background ?? null,
        };
      }
      if (progress.phase === "bodies" || progress.phase === "history") {
        return {
          accountId: progress.accountId,
          state: "idle",
          foregroundPhase: "idle",
          background: {
            phase: progress.phase === "bodies" ? "content" : "headers",
            done: progress.done,
            total: progress.total,
            failed: 0,
          },
        };
      }

      // Legacy headers only represent foreground work when they belong to the
      // Inbox. Other folders become passive history progress.
      const inbox = progress.phase === "folders" || progress.folder.toUpperCase() === "INBOX";
      return {
        accountId: progress.accountId,
        state: inbox ? "syncing" : "idle",
        foregroundPhase: inbox ? "inbox" : "idle",
        background: inbox
          ? previous?.background ?? null
          : { phase: "headers", done: progress.done, total: progress.total, failed: 0 },
      };
    };

    const legacyAccountState = ({ accountId, syncState }: AccountStateEvent): SyncStatus => {
      const previous = useUi.getState().syncStatuses[accountId];
      const foregroundPhase = syncState === "syncing" ? "inbox" : "idle";
      return {
        accountId,
        state: syncState,
        foregroundPhase,
        background: previous?.background ?? null,
      };
    };

    void (async () => {
      const installed = await Promise.all([
        subscribeEvent("sync:status", (status) => {
          authoritativeAccounts.add(status.accountId);
          applyStatus(status);
        }),
        subscribeEvent("sync:progress", (progress) => {
          if (!authoritativeAccounts.has(progress.accountId)) {
            applyStatus(legacyProgress(progress));
          }
        }),
        subscribeEvent("account:state", (state) => {
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
          if (!authoritativeAccounts.has(state.accountId)) {
            applyStatus(legacyAccountState(state));
          }
        }),
      ]);
      if (cancelled) {
        installed.forEach((off) => off());
        return;
      }
      unlisteners.push(...installed);
      subscriptionsReady = true;
      await refreshStatusSnapshot();
    })().catch(() => {
      // A focus recovery will retry the authoritative read if listener setup or
      // the initial IPC request failed during startup.
    });

    const recoverVisibleMail = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRecoveryAt < 250) return;
      lastRecoveryAt = now;
      void refreshMailQueries();
      void refreshStatusSnapshot();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") recoverVisibleMail();
    };
    window.addEventListener("focus", recoverVisibleMail);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", recoverVisibleMail);
      document.removeEventListener("visibilitychange", onVisibility);
      unlisteners.forEach((off) => off());
    };
  }, []);
}
