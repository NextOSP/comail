import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Account, AddressBook, CalendarLogin, ContactServer } from "../../ipc/types";
import { hostOf, reusableLogin } from "../../lib/carddav";
import { relativeTime } from "../../lib/format";
import { queryClient } from "../../queries/client";
import { useAccounts, useCalendarLogins, useContactServers } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Button, Checkbox, inputCls, SettingsGroup } from "./panelKit";

/** Per-account read-only CardDAV contact sync, next to calendar sync: connect
 *  a server with an app password (or the sign-in a CalDAV calendar on the
 *  same server already uses), pick the address books to include, sync now.
 *  Nothing is ever written back to the server. */
export function ContactsSettings() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: servers } = useContactServers();
  const { data: logins } = useCalendarLogins();

  if ((accounts ?? []).length === 0) return null;

  return (
    <SettingsGroup title={t("settings:contacts.section")} description={t("settings:contacts.hint")}>
      {(accounts ?? []).map((a) => (
        <AccountContactsCard
          key={a.id}
          account={a}
          server={(servers ?? []).find((s) => s.accountId === a.id) ?? null}
          logins={logins ?? []}
        />
      ))}
    </SettingsGroup>
  );
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: ["contactServers"] });

function AccountContactsCard({
  account,
  server,
  logins,
}: {
  account: Account;
  server: ContactServer | null;
  logins: CalendarLogin[];
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState(account.email);
  const [password, setPassword] = useState("");
  const [reuse, setReuse] = useState(true);

  // A calendar login on the same server can stand in for typed credentials.
  const login = reusableLogin(url, logins, account.id);
  const reusing = login !== null && reuse;
  const canConnect = !!hostOf(url) && (reusing || !!password);

  const connect = async () => {
    setBusy(true);
    try {
      await call("connect_contacts", {
        args:
          reusing && login
            ? { accountId: account.id, url, reuseCalendarAccountId: login.accountId }
          : { accountId: account.id, url, username, password },
      });
      pushToast({ kind: "info", message: t("settings:contacts.connected") });
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
      await call("disconnect_contacts", { accountId: account.id });
      pushToast({ kind: "info", message: t("settings:contacts.disconnected") });
      refresh();
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      await call("contacts_sync_now", { accountId: account.id });
      pushToast({ kind: "info", message: t("settings:contacts.syncStarted") });
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
        {server ? (
          <>
            <Button size="sm" busy={syncing} onClick={() => void syncNow()}>
              {t("settings:contacts.syncNow")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void disconnect()}>
              {t("settings:contacts.disconnect")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setFormOpen((v) => !v)}>
            {t("settings:contacts.connectCarddav")}
          </Button>
        )}
      </div>

      {!server && formOpen && (
        <div className="mt-2 flex flex-col gap-1.5">
          <input
            className={inputCls}
            placeholder={t("settings:contacts.urlPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {login && (
            <Checkbox
              checked={reuse}
              onChange={setReuse}
              label={t("settings:contacts.reuseLogin", {
                username: login.username,
                host: login.hosts[0] ?? "",
              })}
            />
          )}
          {!reusing && (
            <div className="flex gap-1.5">
              <input
                className={inputCls}
                placeholder={t("settings:contacts.username")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className={inputCls}
                type="password"
                placeholder={t("settings:contacts.appPassword")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          <div>
            <Button
              variant="primary"
              size="sm"
              busy={busy}
              disabled={!canConnect}
              onClick={() => void connect()}
            >
              {busy ? t("common:loading") : t("settings:contacts.connect")}
            </Button>
          </div>
        </div>
      )}

      {server && (
        <div className="mt-1 flex flex-col gap-1">
          <ServerStatus server={server} />
          {server.addressBooks.map((b) => (
            <AddressBookRow key={b.id} book={b} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Server, login and how the last sync went. */
function ServerStatus({ server }: { server: ContactServer }) {
  const { t } = useTranslation();
  const where = [hostOf(server.baseUrl), server.username].filter(Boolean).join(" · ");
  let status: string;
  if (server.lastError === "needs_reauth") {
    status = t("settings:contacts.needsReauth");
  } else if (server.lastError) {
    status = t("settings:contacts.failed", {
      error: server.lastError.replace(/ca(?:l|rd)dav error:\s*/gi, ""),
    });
  } else {
    status = server.lastSyncedAt
      ? t("settings:contacts.syncedAt", { when: relativeTime(server.lastSyncedAt) })
      : t("settings:contacts.notSynced");
  }
  return (
    <div className="text-xs text-ink-faint">
      {where && <span className="mr-1.5">{where} ·</span>}
      <span className={server.lastError ? "text-danger" : undefined}>{status}</span>
    </div>
  );
}

/** One address book: include toggle and how many usable cards it holds. */
function AddressBookRow({ book }: { book: AddressBook }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  return (
    <div className="flex items-center gap-2 select-none">
      <div className="min-w-0 flex-1 truncate">
        <Checkbox
          checked={book.enabled}
          label={book.displayName ?? book.url}
          onChange={(enabled) => {
            void call("set_address_book_enabled", { addressBookId: book.id, enabled }).then(
              refresh,
              (err: unknown) => pushToast({ kind: "error", message: errorMessage(err) }),
            );
          }}
        />
      </div>
      {book.enabled && (
        <span className="shrink-0 text-xs text-ink-faint tabular-nums">
          {t("settings:contacts.cardCount", { count: book.cardCount })}
        </span>
      )}
    </div>
  );
}
