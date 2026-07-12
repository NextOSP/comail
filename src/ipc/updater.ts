import { MOCK_MODE } from "./mock";

/** Result of a successful update check when a newer version is available. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Opaque handle used by installUpdate(); kept off the public shape. */
  download: () => Promise<void>;
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
    download: async () => {
      await update.downloadAndInstall();
    },
  };
}

/** Install an already-found update, then relaunch into the new version. */
export async function installUpdate(update: UpdateInfo): Promise<void> {
  await update.download();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Current app version. Falls back to the injected build version in mock mode. */
export async function appVersion(): Promise<string> {
  if (MOCK_MODE) return import.meta.env.VITE_APP_VERSION ?? "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
