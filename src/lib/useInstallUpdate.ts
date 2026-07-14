import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../ipc/errors";
import { installUpdate, type UpdateInfo } from "../ipc/updater";
import { useUi } from "../stores/ui";

/**
 * Returns a callback that installs a found update while showing live download
 * progress. It pushes a single toast, updates its message and progress bar as
 * bytes arrive, then hands off to the plugin's relaunch (which tears down the
 * UI, so no success toast is needed). Both the startup check and the Settings
 * "check for updates" flow share this so their progress UX stays identical.
 */
export function useInstallUpdate() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const updateToast = useUi((s) => s.updateToast);
  const dismissToast = useUi((s) => s.dismissToast);

  return useCallback(
    (update: UpdateInfo) => {
      // Long-lived toast: it lasts the whole download and is replaced by the
      // relaunch on success, or swapped for an error toast on failure.
      const id = pushToast({
        kind: "info",
        message: t("settings:about.downloading", { percent: 0 }),
        progress: 0,
        durationMs: 10 * 60 * 1000,
      });
      void installUpdate(update, (p) => {
        if (p.fraction == null) {
          updateToast(id, { message: t("settings:about.downloadingUnknown"), progress: undefined });
          return;
        }
        const percent = Math.round(p.fraction * 100);
        updateToast(id, {
          message:
            percent >= 100
              ? t("settings:about.installing")
              : t("settings:about.downloading", { percent }),
          progress: p.fraction,
        });
      }).catch((err) => {
        dismissToast(id);
        pushToast({ kind: "error", message: errorMessage(err) });
      });
    },
    [t, pushToast, updateToast, dismissToast],
  );
}
