import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { queryClient } from "../../queries/client";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

/**
 * Inbox-level warning for accounts whose sign-in expired (`needs_reauth`).
 * Shown above the tab bar for every disconnected account regardless of the
 * account filter, with the browser reauth one click away; previously the state
 * was only discoverable inside the account dropdown or Settings.
 */
export function ReauthBanner() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const set = useUi((s) => s.set);
  const syncStatuses = useUi((s) => s.syncStatuses);
  const { data: accounts } = useAccounts();
  const [waitingId, setWaitingId] = useState<number | null>(null);

  // Live sync events win over the (possibly stale) accounts query snapshot.
  const needing = (accounts ?? []).filter(
    (a) => (syncStatuses[a.id]?.state ?? a.syncState) === "needs_reauth",
  );
  if (needing.length === 0) return null;

  const reauth = async (accountId: number, email: string) => {
    if (waitingId === accountId) {
      void call("cancel_oauth", {}).catch(() => {});
      return;
    }
    setWaitingId(accountId);
    try {
      await call("reauth_account", { accountId });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("settings:sync.reauthDone", { email }) });
    } catch (err) {
      const message = errorMessage(err);
      if (!message.includes("sign-in cancelled")) {
        pushToast({
          kind: "error",
          message: t("settings:sync.reauthFailed", { email, detail: message }),
        });
      }
    } finally {
      setWaitingId(null);
    }
  };

  return (
    <div className="relative z-10 flex shrink-0 flex-col gap-1.5 border-b border-hairline bg-bg1 px-4 py-2">
      {needing.map((a) => {
        const provider = t(`settings:accounts.provider.${a.provider}`);
        return (
          <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="size-1.5 shrink-0 rounded-full bg-danger" />
            <span className="min-w-0 truncate text-[12.5px] text-ink">
              {t("common:reauthBanner.message", { email: a.email })}
            </span>
            {a.provider === "imap" ? (
              <button
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-bg2"
                onClick={() => set({ panel: "settings", settingsTab: "accounts" })}
              >
                {t("common:reauthBanner.openSettings")}
              </button>
            ) : (
              <button
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-bg2 disabled:opacity-50"
                disabled={waitingId != null && waitingId !== a.id}
                onClick={() => void reauth(a.id, a.email)}
              >
                {waitingId === a.id
                  ? t("common:reauthBanner.waiting", { provider })
                  : t("common:reauthBanner.action", { provider })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
