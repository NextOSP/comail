import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Account, Provider, Settings, SyncState } from "../../ipc/types";
import { accountColor, accountLabel } from "../../lib/format";
import { queryClient } from "../../queries/client";
import { useAccounts, useSettings } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { SWATCHES } from "./LabelsPanel";
import { updateSettings } from "./SettingsPanel";
import {
  Button,
  ConfirmButton,
  EmptyState,
  FormField,
  inputCls,
  Segmented,
  SettingRow,
  SettingsGroup,
  Toggle,
} from "./panelKit";

const SYNC_DOT: Record<SyncState, string> = {
  idle: "var(--ok)",
  syncing: "var(--info)",
  error: "var(--danger)",
  needs_reauth: "var(--danger)",
  offline: "var(--bg4)",
};

type AccountTheme = Settings["theme"];

/**
 * Connected accounts as a clean list (Attio / Notion Mail pattern): one row per
 * account with its marker, name, provider and status. Everything editable lives
 * in an Edit dialog with an explicit Save, so nothing changes by accident.
 */
export function AccountsSection() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: settings } = useSettings();
  const pushToast = useUi((s) => s.pushToast);
  const set = useUi((s) => s.set);
  const [oauthBusy, setOauthBusy] = useState<Provider | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [reauthId, setReauthId] = useState<number | null>(null);

  const oauth = async (provider: "gmail" | "microsoft") => {
    setOauthBusy(provider);
    try {
      await call("start_oauth", { provider });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("settings:accounts.connected") });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("errors:oauthFailed");
      if (!message.includes("sign-in cancelled")) {
        pushToast(
          message.includes("no OAuth app configured")
            ? { kind: "info", message: t("settings:accounts.configureOauthFirst"), durationMs: 6000 }
            : { kind: "error", message },
        );
      }
    } finally {
      setOauthBusy(null);
    }
  };

  const cancelOauth = () => {
    void call("cancel_oauth", {}).catch(() => {});
  };

  const reauth = async (accountId: number, email: string) => {
    if (reauthId === accountId) {
      cancelOauth();
      return;
    }
    setReauthId(accountId);
    try {
      await call("reauth_account", { accountId });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("settings:sync.reauthDone", { email }) });
    } catch (err) {
      const message = errorMessage(err);
      if (!message.includes("sign-in cancelled")) {
        pushToast({ kind: "error", message: t("settings:sync.reauthFailed", { email, detail: message }) });
      }
    } finally {
      setReauthId(null);
    }
  };

  const list = accounts ?? [];

  return (
    <section>
      <SettingsGroup
        title={t("settings:accounts.listTitle")}
        flush
        actions={
          <>
            <Button size="sm" icon="plus" onClick={() => set({ addAccountOpen: true })}>
              {t("settings:accounts.addImap")}
            </Button>
            {/* Not `busy`: while waiting the button stays clickable to cancel. */}
            <Button
              size="sm"
              disabled={oauthBusy != null && oauthBusy !== "gmail"}
              onClick={() => (oauthBusy === "gmail" ? cancelOauth() : void oauth("gmail"))}
            >
              {oauthBusy === "gmail"
                ? t("settings:accounts.cancelWaiting", { waiting: t("settings:accounts.waitingGoogle") })
                : t("settings:accounts.signInGoogle")}
            </Button>
            <Button
              size="sm"
              disabled={oauthBusy != null && oauthBusy !== "microsoft"}
              onClick={() => (oauthBusy === "microsoft" ? cancelOauth() : void oauth("microsoft"))}
            >
              {oauthBusy === "microsoft"
                ? t("settings:accounts.cancelWaiting", { waiting: t("settings:accounts.waitingMicrosoft") })
                : t("settings:accounts.signInMicrosoft")}
            </Button>
          </>
        }
      >
        {list.length === 0 ? (
          <div className="p-4">
            <EmptyState icon="users" title={t("settings:accounts.empty")} />
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                settings={settings}
                reauthBusy={reauthId === a.id}
                reauthDisabled={reauthId != null && reauthId !== a.id}
                onReauth={() => void reauth(a.id, a.email)}
                onEdit={() => setEditing(a)}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingRow label={t("settings:accounts.showBadges")} hint={t("settings:accounts.showBadgesHint")}>
          <Toggle
            label={t("settings:accounts.showBadges")}
            checked={settings?.showAccountBadges ?? true}
            onChange={(showAccountBadges) => void updateSettings({ showAccountBadges })}
          />
        </SettingRow>
      </SettingsGroup>

      {editing &&
        settings &&
        createPortal(
          <AccountDialog account={editing} settings={settings} onClose={() => setEditing(null)} />,
          document.body,
        )}
    </section>
  );
}

function AccountRow({
  account: a,
  settings,
  reauthBusy,
  reauthDisabled,
  onReauth,
  onEdit,
}: {
  account: Account;
  settings: Settings | undefined;
  reauthBusy: boolean;
  reauthDisabled: boolean;
  onReauth: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const name = settings?.accountShortNames?.[String(a.id)] || accountLabel(a);
  const color = accountColor(a, settings?.accountColors);
  const signedOut = a.syncState === "needs_reauth";
  return (
    <li className={`flex items-center gap-3 px-4 py-3 ${signedOut ? "bg-danger/5" : ""}`}>
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{ background: color }}
        aria-hidden
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-base font-medium text-ink">{name}</span>
          <span className="truncate text-sm text-ink-faint">{a.email}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
          <span>{t(`settings:accounts.provider.${a.provider}`)}</span>
          <span aria-hidden>·</span>
          <span className="size-1.5 rounded-full" style={{ background: SYNC_DOT[a.syncState] }} aria-hidden />
          <span className={signedOut ? "font-medium text-danger" : undefined}>
            {signedOut
              ? t("settings:accounts.signedOut")
              : a.syncState === "idle"
                ? t("settings:accounts.statusOk")
                : t(`common:syncState.${a.syncState}`)}
          </span>
        </span>
      </span>
      {signedOut && a.provider !== "imap" && (
        <Button variant="primary" size="sm" busy={reauthBusy} disabled={reauthDisabled} onClick={onReauth}>
          {reauthBusy
            ? t("settings:sync.reauthWaiting")
            : t("common:reauthBanner.action", { provider: t(`settings:accounts.provider.${a.provider}`) })}
        </Button>
      )}
      <Button size="sm" icon="edit" onClick={onEdit}>
        {t("settings:accounts.edit")}
      </Button>
    </li>
  );
}

/** Edit one account: display name, marker color, theme. Saved in one write;
 *  removal sits in its own danger section. */
function AccountDialog({
  account: a,
  settings,
  onClose,
}: {
  account: Account;
  settings: Settings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const key = String(a.id);
  const initial = {
    name: settings.accountShortNames?.[key] ?? "",
    color: settings.accountColors?.[key] ?? "",
    theme: (settings.accountThemes?.[key] ?? "system") as AccountTheme,
  };
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [theme, setTheme] = useState<AccountTheme>(initial.theme);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== initial.name || color !== initial.color || theme !== initial.theme;

  const save = async () => {
    setSaving(true);
    const names = { ...settings.accountShortNames };
    const colors = { ...settings.accountColors };
    if (name.trim()) names[key] = name.trim();
    else delete names[key];
    if (color) colors[key] = color;
    else delete colors[key];
    try {
      await updateSettings({
        accountShortNames: names,
        accountColors: colors,
        accountThemes: { ...settings.accountThemes, [key]: theme },
      });
      pushToast({ kind: "info", message: t("settings:accounts.saved") });
      onClose();
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await call("remove_account", { accountId: a.id });
      pushToast({ kind: "info", message: t("settings:accounts.removed", { email: a.email }) });
      onClose();
    } catch (err) {
      pushToast({ kind: "error", message: t("settings:accounts.removeFailed", { detail: errorMessage(err) }) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    }
  };

  const previewColor = color || accountColor(a);
  const previewName = name.trim() || accountLabel(a);

  return (
    <Modal onClose={onClose} width={480} top="14vh" closeOnEsc labelledBy="account-dialog-title">
      <header className="flex items-center gap-3 border-b border-hairline px-5 py-4">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
          style={{ background: previewColor }}
          aria-hidden
        >
          {previewName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="account-dialog-title" className="text-md font-semibold text-ink">
            {t("settings:accounts.editTitle")}
          </h2>
          <p className="truncate text-sm text-ink-faint">
            {a.email} · {t(`settings:accounts.provider.${a.provider}`)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-control p-1.5 text-ink-faint hover:bg-bg2 hover:text-ink"
          aria-label={t("settings:accounts.cancel")}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <FormField label={t("settings:accounts.nameLabel")}>
          <input
            className={inputCls}
            value={name}
            placeholder={accountLabel(a)}
            maxLength={24}
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) void save();
            }}
          />
          <span className="text-xs text-ink-faint">{t("settings:accounts.nameHint")}</span>
        </FormField>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-ink-faint">{t("settings:accounts.colorLabel")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setColor("")}
              aria-pressed={!color}
              className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
                !color ? "border-accent text-ink" : "border-hairline text-ink-muted hover:bg-bg2"
              }`}
            >
              <span className="size-2.5 rounded-full" style={{ background: accountColor(a) }} />
              {t("settings:accounts.colorAuto")}
            </button>
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`flex size-7 items-center justify-center rounded-full transition ${
                  color === c ? "ring-2 ring-accent ring-offset-2 ring-offset-bg1" : "hover:scale-110"
                }`}
                style={{ background: c }}
              >
                {color === c && <Icon name="check" size={12} className="text-white" />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-ink-faint">{t("settings:accounts.themeLabel")}</span>
          <div>
            <Segmented<AccountTheme>
              value={theme}
              onChange={setTheme}
              options={[
                { value: "system", label: t("settings:accounts.themeInherit") },
                { value: "snow", label: t("settings:theme.snow") },
                { value: "carbon", label: t("settings:theme.carbon") },
              ]}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-card border border-danger/25 bg-danger/5 px-4 py-3">
          <div className="min-w-0">
            <div className="text-base font-medium text-ink">{t("settings:accounts.dangerTitle")}</div>
            <div className="mt-0.5 text-xs text-ink-faint">{t("settings:accounts.dangerHint")}</div>
          </div>
          <ConfirmButton
            label={t("settings:accounts.remove")}
            confirmLabel={t("settings:accounts.reallyRemove")}
            onConfirm={() => void remove()}
          />
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          {t("settings:accounts.cancel")}
        </Button>
        <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>
          {t("settings:accounts.save")}
        </Button>
      </footer>
    </Modal>
  );
}
