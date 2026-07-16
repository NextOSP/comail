import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../ipc/errors";
import { installUpdate, type UpdateInfo } from "../ipc/updater";
import { useUi } from "../stores/ui";

// Shared by the startup and Settings flows so two update offers cannot start
// overlapping downloads of the same installer.
let installInProgress = false;

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
      if (installInProgress) return;
      installInProgress = true;
      // Long-lived toast: it lasts the whole download and is replaced by the
      // relaunch on success, or swapped for an error toast on failure.
      const id = pushToast({
        kind: "info",
        message: t("settings:about.preparingUpdate"),
        progress: null,
        durationMs: 10 * 60 * 1000,
      });
      void installUpdate(update, (p) => {
        if (p.fraction == null) {
          updateToast(id, {
            message: t("settings:about.downloadingUnknown"),
            progress: null,
          });
          return;
        }
        const percent = Math.round(p.fraction * 100);
        updateToast(id, {
          message:
            percent >= 100
              ? t("settings:about.installing")
              : t("settings:about.downloading", { percent }),
          // Installation has no byte total, so switch back to a clearly active
          // indeterminate bar instead of leaving a frozen 100% download bar.
          progress: percent >= 100 ? null : p.fraction,
        });
      }).catch((err) => {
        installInProgress = false;
        dismissToast(id);
        pushToast({ kind: "error", message: errorMessage(err) });
      });
    },
    [t, pushToast, updateToast, dismissToast],
  );
}
