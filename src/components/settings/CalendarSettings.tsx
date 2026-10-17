import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage, parseError } from "../../ipc/errors";
import type { Account, Calendar } from "../../ipc/types";
import { normalizeHex } from "../calendar/calendarColor";
import { queryClient } from "../../queries/client";
import {
  useAccounts,
  useCalendars,
  useSetCalendarColor,
  useSetDefaultCalendar,
} from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { SWATCHES } from "./LabelsPanel";
import { Button, Checkbox, inputCls, SettingsGroup } from "./panelKit";

/** Per-account calendar sync (Settings → Accounts): connect Google Calendar
 *  (OAuth re-consent), Microsoft 365 (Graph consent; Outlook has no CalDAV)
 *  or a generic CalDAV server (Fastmail, iCloud, Radicale…) with an app
 *  password; then per-collection enable toggles + sync now. */
export function CalendarSettings() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: calendars } = useCalendars();

  if ((accounts ?? []).length === 0) return null;

  return (
    <SettingsGroup title={t("settings:calendar.section")} description={t("settings:calendar.hint")}>
      {(accounts ?? []).map((a) => (
        <AccountCalendarCard
          key={a.id}
          account={a}
          calendars={(calendars ?? []).filter((c) => c.accountId === a.id)}
        />
      ))}
    </SettingsGroup>
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
  const [syncing, setSyncing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState(account.email);
  const [password, setPassword] = useState("");

  const connected = calendars.length > 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["calendars"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  const connect = async (kind: "google" | "microsoft" | "generic") => {
    setBusy(true);
    try {
      await call("connect_calendar", {
        args:
          kind === "generic"
            ? { accountId: account.id, kind, url, username, password }
            : { accountId: account.id, kind },
      });
      pushToast({ kind: "info", message: t("settings:calendar.connected") });
      setFormOpen(false);
      setPassword("");
      refresh();
    } catch (err) {
      // A Google CalDAV rejection (403/404) almost always means the Cloud
      // project behind the OAuth client hasn't enabled the Calendar API or
      // added the calendar scope. Point the user straight at the fix.
      const googleSetup =
        kind === "google" && parseError(err).code === "caldav"
          ? ` ${t("settings:calendar.googleSetupHint")}`
          : "";
      pushToast({ kind: "error", message: `${errorMessage(err)}${googleSetup}` });
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
    setSyncing(true);
    try {
      await call("calendar_sync_now", { accountId: account.id });
      pushToast({ kind: "info", message: t("settings:calendar.syncStarted") });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base text-ink">{account.email}</span>
        {connected ? (
          <>
            <Button size="sm" busy={syncing} onClick={() => void syncNow()}>
              {t("settings:calendar.syncNow")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void disconnect()}>
              {t("settings:calendar.disconnect")}
            </Button>
          </>
        ) : (
          <>
            {account.provider === "gmail" && (
              <Button size="sm" busy={busy} onClick={() => void connect("google")}>
                {t("settings:calendar.connectGoogle")}
              </Button>
            )}
            {account.provider === "microsoft" ? (
              // Outlook / Microsoft 365 has no CalDAV endpoint; the calendar
              // syncs through Microsoft Graph on the account's own sign-in.
              <Button size="sm" busy={busy} onClick={() => void connect("microsoft")}>
                {t("settings:calendar.connectMicrosoft")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setFormOpen((v) => !v)}>
                {t("settings:calendar.connectCaldav")}
              </Button>
            )}
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
            <Button
              variant="primary"
              size="sm"
              busy={busy}
              disabled={!url.trim() || !password}
              onClick={() => void connect("generic")}
            >
              {busy ? t("common:loading") : t("settings:calendar.connect")}
            </Button>
          </div>
        </div>
      )}

      {connected && (
        <div className="mt-2 flex flex-col gap-1">
          {calendars.map((c) => (
            <CalendarRow key={c.id} calendar={c} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One discovered collection: enable toggle, color swatch picker, and a
 *  "make default" control (the default receives newly created events). */
function CalendarRow({ calendar: c, onChanged }: { calendar: Calendar; onChanged: () => void }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const setColor = useSetCalendarColor();
  const setDefault = useSetDefaultCalendar();
  const [picking, setPicking] = useState(false);

  const onError = (err: unknown) => pushToast({ kind: "error", message: errorMessage(err) });
  const hex = normalizeHex(c.color);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 select-none">
        <button
          type="button"
          className="flex size-4 shrink-0 items-center justify-center rounded-full hover:ring-2 hover:ring-accent/40"
          title={t("settings:calendar.colorTip")}
          aria-label={t("settings:calendar.colorTip")}
          onClick={() => setPicking((v) => !v)}
        >
          <span
            className="size-2.5 rounded-full"
            style={{ background: hex ?? "var(--accent)" }}
          />
        </button>
        <div className="min-w-0 flex-1 truncate">
          <Checkbox
            checked={c.enabled}
            label={c.displayName ?? c.url}
            onChange={(enabled) => {
              void call("set_calendar_enabled", { calendarId: c.id, enabled }).then(onChanged, onError);
            }}
          />
        </div>
        {c.isDefault ? (
          <span className="rounded bg-bg2 px-1.5 text-2xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("settings:calendar.default")}
          </span>
        ) : (
          !c.readOnly && (
            <button
              type="button"
              className="rounded px-1.5 text-2xs font-semibold tracking-wide text-ink-faint uppercase hover:bg-bg2 hover:text-ink"
              onClick={() =>
                setDefault.mutate({ calendarId: c.id }, { onSuccess: onChanged, onError })
              }
            >
              {t("settings:calendar.makeDefault")}
            </button>
          )
        )}
      </div>
      {picking && (
        <div className="mt-1.5 mb-1 ml-6 flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((s) => (
            <button
              key={s}
              type="button"
              aria-label={s}
              className={`size-4.5 rounded-full transition ${
                hex === s ? "ring-2 ring-accent ring-offset-1 ring-offset-bg0" : ""
              }`}
              style={{ background: s }}
              onClick={() => {
                setPicking(false);
                setColor.mutate(
                  { calendarId: c.id, color: s },
                  { onSuccess: onChanged, onError },
                );
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
