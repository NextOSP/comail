import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Account } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

function useCalendars() {
  return useQuery({
    queryKey: ["calendars"],
    queryFn: () => call("list_calendars", {}),
    staleTime: 30_000,
  });
}

/** Per-account calendar sync (Settings → Accounts): connect Google Calendar
 *  (OAuth re-consent) or a generic CalDAV server (Fastmail, iCloud, Radicale…)
 *  with an app password; then per-collection enable toggles + sync now. */
export function CalendarSettings() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: calendars } = useCalendars();

  if ((accounts ?? []).length === 0) return null;

  return (
    <section className="mt-5">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
        {t("settings:calendar.section")}
      </div>
      <p className="mb-2 text-[12px] text-ink-faint">{t("settings:calendar.hint")}</p>
      <div className="flex flex-col gap-2">
        {(accounts ?? []).map((a) => (
          <AccountCalendarCard
            key={a.id}
            account={a}
            calendars={(calendars ?? []).filter((c) => c.accountId === a.id)}
          />
        ))}
      </div>
    </section>
  );
}

function AccountCalendarCard({
  account,
  calendars,
}: {
  account: Account;
  calendars: import("../../ipc/types").Calendar[];
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState(account.email);
  const [password, setPassword] = useState("");

  const connected = calendars.length > 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["calendars"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  const connect = async (kind: "google" | "generic") => {
    setBusy(true);
    try {
      await call("connect_calendar", {
        args:
          kind === "google"
            ? { accountId: account.id, kind }
            : { accountId: account.id, kind, url, username, password },
      });
      pushToast({ kind: "info", message: t("settings:calendar.connected") });
      setFormOpen(false);
      setPassword("");
      refresh();
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await call("disconnect_calendar", { accountId: account.id });
      pushToast({ kind: "info", message: t("settings:calendar.disconnected") });
      refresh();
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const syncNow = async () => {
    try {
      await call("calendar_sync_now", { accountId: account.id });
      pushToast({ kind: "info", message: t("settings:calendar.syncStarted") });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const inputCls =
    "w-full rounded-md border border-hairline bg-bg0 px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent/60";

  return (
    <div className="rounded-lg border border-hairline bg-bg0 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{account.email}</span>
        {connected ? (
          <>
            <button
              className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-bg2 hover:text-ink"
              onClick={() => void syncNow()}
            >
              {t("settings:calendar.syncNow")}
            </button>
            <button
              className="rounded-md px-2 py-0.5 text-[11.5px] text-danger hover:bg-bg2"
              onClick={() => void disconnect()}
            >
              {t("settings:calendar.disconnect")}
            </button>
          </>
        ) : (
          <>
            {account.provider === "gmail" && (
              <button
                className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-bg2 hover:text-ink disabled:opacity-50"
                disabled={busy}
                onClick={() => void connect("google")}
              >
                {t("settings:calendar.connectGoogle")}
              </button>
            )}
            <button
              className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-bg2 hover:text-ink"
              onClick={() => setFormOpen((v) => !v)}
            >
              {t("settings:calendar.connectCaldav")}
            </button>
          </>
        )}
      </div>

      {!connected && formOpen && (
        <div className="mt-2 flex flex-col gap-1.5">
          <input
            className={inputCls}
            placeholder={t("settings:calendar.urlPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="flex gap-1.5">
            <input
              className={inputCls}
              placeholder={t("settings:calendar.username")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className={inputCls}
              type="password"
              placeholder={t("settings:calendar.appPassword")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <button
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              disabled={busy || !url.trim() || !password}
              onClick={() => void connect("generic")}
            >
              {busy ? t("common:loading") : t("settings:calendar.connect")}
            </button>
          </div>
        </div>
      )}

      {connected && (
        <div className="mt-2 flex flex-col gap-1">
          {calendars.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted select-none"
            >
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={async (e) => {
                  try {
                    await call("set_calendar_enabled", {
                      calendarId: c.id,
                      enabled: e.target.checked,
                    });
                    refresh();
                  } catch (err) {
                    pushToast({ kind: "error", message: errorMessage(err) });
                  }
                }}
              />
              {c.color && (
                <span
                  className="size-2 rounded-full"
                  style={{ background: c.color.slice(0, 7) }}
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {c.displayName ?? c.url}
              </span>
              {c.isDefault && (
                <span className="rounded bg-bg2 px-1.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                  {t("settings:calendar.default")}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
