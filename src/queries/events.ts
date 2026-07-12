import { useEffect } from "react";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { onEvent } from "../ipc/events";
import { MOCK_MODE } from "../ipc/mock";
import type { Settings } from "../ipc/types";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

let notifyPermission: boolean | null = null;

/** Desktop notification for new mail, gated by the setting and window focus. */
async function notifyNewMail(threadIds: number[]) {
  if (MOCK_MODE || document.hasFocus()) return;
  const settings = queryClient.getQueryData<Settings>(["settings"]);
  if (settings && !settings.notificationsEnabled) return;

  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (notifyPermission == null) {
      notifyPermission = await isPermissionGranted();
      if (!notifyPermission) {
        notifyPermission = (await requestPermission()) === "granted";
      }
    }
    if (!notifyPermission) return;

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
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
