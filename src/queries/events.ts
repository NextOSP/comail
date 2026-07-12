import { useEffect } from "react";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { onEvent } from "../ipc/events";
import { MOCK_MODE } from "../ipc/mock";
import type { CalendarEvent, Settings } from "../ipc/types";
import { parseMailto } from "../lib/mailto";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

let notifyPermission: boolean | null = null;

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

/** Desktop notification for new mail, gated by the setting and window focus. */
async function notifyNewMail(threadIds: number[]) {
  if (MOCK_MODE || document.hasFocus()) return;

  try {
    if (!(await notificationsAllowed())) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");

    if (threadIds.length === 1) {
      // Single thread: show its subject/sender.
      const detail = await call("get_thread", { threadId: threadIds[0] });
      const last = detail.messages[detail.messages.length - 1];
      sendNotification({
        title: last ? (last.from.name ?? last.from.email) : "Comail",
        body: detail.thread.subject || detail.thread.snippet,
      });
    } else {
      sendNotification({
        title: "Comail",
        body: i18n.t("common:notification.newMessages", { count: threadIds.length }),
      });
    }
  } catch {
    // notifications are best-effort
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

/** Wire backend push events into targeted query invalidations. Mount once. */
export function useBackendEvents() {
  useEffect(() => {
    const offs = [
      onEvent("mail:new", ({ threadIds }) => {
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        // calendar invites arrive by mail
        void queryClient.invalidateQueries({ queryKey: ["events"] });
        void notifyNewMail(threadIds);
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
      onEvent("action:state", ({ state, error }) => {
        if (state === "failed") {
          useUi.getState().pushToast({
            kind: "error",
            message: error ? `Action failed: ${error}` : "An action failed to sync",
          });
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
        }
      }),
      onEvent("network:state", ({ online }) => {
        useUi.getState().set({ offline: !online });
      }),
      onEvent("sync:progress", ({ phase }) => {
        useUi.getState().set({ syncing: phase !== "idle" });
      }),
      onEvent("account:state", () => {
        void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      }),
      onEvent("calendar:updated", () => {
        void queryClient.invalidateQueries({ queryKey: ["events"] });
        void queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
        void queryClient.invalidateQueries({ queryKey: ["calendars"] });
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
}
