import { useEffect } from "react";
import { MOCK_MODE } from "../ipc/mock";
import { useSettings, useUnreadCounts } from "./hooks";

/** Mirror the unread count onto the app icon (macOS Dock badge). Mount once. */
export function useDockBadge() {
  const { data: settings } = useSettings();
  const enabled = !MOCK_MODE && (settings?.dockBadgeEnabled ?? true);
  // null account = unread across all accounts; kept fresh by the
  // ["unreadCounts"] invalidations on mail:new / mail:updated.
  const { data: counts } = useUnreadCounts(null, enabled);
  const count = enabled
    ? settings?.dockBadgeSource === "important"
      ? counts?.important
      : counts?.inbox
    : 0;

  useEffect(() => {
    if (MOCK_MODE) return;
    if (count === undefined) return; // still loading: keep the current badge
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        // undefined clears the badge; badges aren't supported everywhere.
        getCurrentWindow().setBadgeCount(count > 0 ? count : undefined),
      )
      .catch(() => {});
  }, [count]);
}
