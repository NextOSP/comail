import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import type { Settings } from "../ipc/types";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

type SettingsPatch = Partial<Settings> | ((current: Settings) => Partial<Settings> | null);

let pendingWrite = Promise.resolve(true);

/** Serialize full-settings writes so rapid shortcuts cannot save stale values. */
export function updateSettings(patch: SettingsPatch): Promise<boolean> {
  pendingWrite = pendingWrite.then(async () => {
    const queryKey = ["settings"];
    let previous: Settings | undefined;
    try {
      const current = await queryClient.ensureQueryData<Settings>({
        queryKey,
        queryFn: () => call("get_settings", {}),
      });
      previous = current;
      const changes = typeof patch === "function" ? patch(current) : patch;
      if (!changes) return true;

      const next = { ...current, ...changes };
      queryClient.setQueryData(queryKey, next);
      if (changes.theme) useUi.getState().set({ theme: changes.theme });
      await call("set_settings", { settings: next });
      return true;
    } catch (err) {
      if (previous) {
        queryClient.setQueryData(queryKey, previous);
        useUi.getState().set({ theme: previous.theme });
      }
      useUi.getState().pushToast({
        kind: "error",
        message: i18n.t("settings:toast.settingsSaveFailed", { detail: errorMessage(err) }),
      });
      return false;
    }
  });
  return pendingWrite;
}
