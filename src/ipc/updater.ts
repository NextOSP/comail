import { MOCK_MODE } from "./mock";

/** Download progress for the in-flight update, emitted as bytes arrive. */
export interface DownloadProgress {
  /** Bytes received so far. */
  downloaded: number;
  /** Total bytes to download, or null when the server sends no length. */
  total: number | null;
  /** 0..1 completion, or null when `total` is unknown (indeterminate). */
  fraction: number | null;
}

/** Result of a successful update check when a newer version is available. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Opaque handle used by installUpdate(); kept off the public shape. */
  download: (onProgress?: (p: DownloadProgress) => void) => Promise<void>;
}

/**
 * Ask the configured GitHub Releases endpoint whether a newer signed build
 * exists. Returns null when we're up to date, running in browser mock mode,
 * or the check fails (offline, rate-limited, no published release yet).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (MOCK_MODE) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    download: async (onProgress) => {
      // The plugin streams three event kinds: Started (carries the total, when
      // the server sends one), Progress (one per chunk), and Finished. We tally
      // chunk lengths ourselves since the events don't report a running total.
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            break;
          case "Finished":
            downloaded = total ?? downloaded;
            break;
        }
        const fraction =
          event.event === "Finished" ? 1 : total != null && total > 0 ? downloaded / total : null;
        onProgress?.({ downloaded, total, fraction });
      });
    },
  };
}

/** Install an already-found update, then relaunch into the new version. */
export async function installUpdate(
  update: UpdateInfo,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  await update.download(onProgress);
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Current app version. Falls back to the injected build version in mock mode. */
export async function appVersion(): Promise<string> {
  if (MOCK_MODE) return import.meta.env.VITE_APP_VERSION ?? "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
