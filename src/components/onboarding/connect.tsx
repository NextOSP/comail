import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { AddPasswordAccountArgs } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useUi } from "../../stores/ui";
import { Button } from "../ui/Button";
import { FormField as Field, inputCls, Segmented } from "../ui/Field";

/**
 * Account connection, shared by the first-run flow (OnboardingFlow) and the
 * add-account modal opened from Settings (AddAccountCard): the OAuth sign-in
 * hook, the provider buttons, and the IMAP / SMTP form.
 */

interface Preset {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  hasNote?: boolean;
}

const PRESETS: Record<string, Preset> = {
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    hasNote: true,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    hasNote: true,
  },
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    hasNote: true,
  },
  custom: {
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 587,
  },
};

export type OAuthProvider = "gmail" | "microsoft";

/** OAuth sign-in. `onDone` runs once the account is stored; a missing OAuth
 *  app opens Settings (and calls `onLeave`), a user cancel stays silent. */
export function useOAuth({ onDone, onLeave }: { onDone?: () => void; onLeave?: () => void } = {}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  const start = async (provider: OAuthProvider) => {
    const pushToast = useUi.getState().pushToast;
    setBusy(provider);
    try {
      await call("start_oauth", { provider });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("onboarding:oauthConnected") });
      onDone?.();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes("no OAuth app configured")) {
        // Take the user straight to the fields they need to fill in.
        useUi.getState().set({ panel: "settings", settingsTab: "accounts" });
        onLeave?.();
        pushToast({
          kind: "info",
          message: t("onboarding:oauthNotConfigured"),
          durationMs: 6000,
        });
      } else if (!raw.includes("sign-in cancelled")) {
        pushToast({ kind: "error", message: errorMessage(err) });
      }
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => {
    void call("cancel_oauth", {}).catch(() => {});
  };

  return { busy, start, cancel };
}

export function GoogleLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.87 8.88 4.76 12 4.76z" />
    </svg>
  );
}

export function MicrosoftLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

/** Google / Microsoft sign-in buttons. While a provider is waiting on the
 *  browser its button becomes the cancel button; the other is disabled. */
export function OAuthButtons({ oauth }: { oauth: ReturnType<typeof useOAuth> }) {
  const { t } = useTranslation();
  const providers: { id: OAuthProvider; logo: React.ReactNode; label: string; waiting: string }[] = [
    { id: "gmail", logo: <GoogleLogo />, label: t("onboarding:signInWithGoogle"), waiting: t("onboarding:waitingForGoogle") },
    { id: "microsoft", logo: <MicrosoftLogo />, label: t("onboarding:signInWithMicrosoft"), waiting: t("onboarding:waitingForMicrosoft") },
  ];
  return (
    <>
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          className="co-provider-btn"
          disabled={oauth.busy != null && oauth.busy !== p.id}
          onClick={() => (oauth.busy === p.id ? oauth.cancel() : void oauth.start(p.id))}
        >
          {oauth.busy === p.id ? <span className="co-spinner size-4 rounded-full border-2 border-hairline-strong border-t-accent" /> : p.logo}
          <span className="flex-1 text-left">
            {oauth.busy === p.id ? t("settings:accounts.cancelWaiting", { waiting: p.waiting }) : p.label}
          </span>
        </button>
      ))}
    </>
  );
}

/** The IMAP / SMTP form: tests the connection, then stores the account.
 *  Presets only ask for the address and password; their servers sit behind a
 *  one-line summary. Custom shows the server fields, guessing the hosts from
 *  the address domain until they're typed. */
export function ImapForm({
  onDone,
  onBack,
}: {
  onDone?: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<keyof typeof PRESETS>("fastmail");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(PRESETS.fastmail.imapHost);
  const [imapPort, setImapPort] = useState(PRESETS.fastmail.imapPort);
  const [smtpHost, setSmtpHost] = useState(PRESETS.fastmail.smtpHost);
  const [smtpPort, setSmtpPort] = useState(PRESETS.fastmail.smtpPort);
  const [editServers, setEditServers] = useState(false);
  const [busy, setBusy] = useState<"test" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCustom = preset === "custom";
  const showServers = isCustom || editServers;
  const domain = email.split("@")[1]?.trim().toLowerCase() || "";
  const imapGuess = isCustom && domain ? `imap.${domain}` : "";
  const smtpGuess = isCustom && domain ? `smtp.${domain}` : "";
  const imapEffective = imapHost.trim() || imapGuess;
  const smtpEffective = smtpHost.trim() || smtpGuess;

  const applyPreset = (key: keyof typeof PRESETS) => {
    setPreset(key);
    setEditServers(false);
    setError(null);
    const p = PRESETS[key];
    setImapHost(p.imapHost);
    setImapPort(p.imapPort);
    setSmtpHost(p.smtpHost);
    setSmtpPort(p.smtpPort);
  };

  const buildArgs = (): AddPasswordAccountArgs => ({
    email: email.trim(),
    displayName: displayName.trim() || null,
    username: email.trim(),
    password,
    imapHost: imapEffective,
    imapPort,
    smtpHost: smtpEffective,
    smtpPort,
  });

  const submit = async () => {
    setError(null);
    setBusy("test");
    try {
      const test = await call("test_connection", { args: buildArgs() });
      if (!test.ok) {
        setError(
          test.error
            ? errorMessage(test.error)
            : t("onboarding:connectionFailed"),
        );
        return;
      }
      setBusy("add");
      await call("add_account_password", { args: buildArgs() });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      useUi
        .getState()
        .pushToast({
          kind: "info",
          message: t("onboarding:accountConnected", { email: email.trim() }),
        });
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="self-start">
        <Segmented
          value={preset}
          onChange={applyPreset}
          options={Object.keys(PRESETS).map((k) => ({
            value: k,
            label: t(`onboarding:provider.${k}`),
          }))}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Field label={t("onboarding:field.email")}>
          <Input
            value={email}
            onChange={setEmail}
            type="email"
            placeholder={t("onboarding:placeholder.email")}
            autoFocus
          />
        </Field>
        <Field label={t("onboarding:field.password")}>
          <Input
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={t("onboarding:placeholder.password")}
          />
          {PRESETS[preset].hasNote && (
            <span className="text-xs text-ink-faint">
              {t(`onboarding:note.${preset}`)}
            </span>
          )}
        </Field>
        <Field label={t("onboarding:field.displayName")}>
          <Input
            value={displayName}
            onChange={setDisplayName}
            placeholder={t("onboarding:placeholder.displayName")}
            maxLength={60}
          />
        </Field>
      </div>

      {showServers ? (
        <div className="flex flex-col gap-3 rounded-control border border-hairline bg-bg0/60 p-3">
          <ServerRow
            label={t("onboarding:field.imapHost")}
            host={imapHost}
            onHost={setImapHost}
            hostPlaceholder={imapGuess || t("onboarding:placeholder.imapHost")}
            port={imapPort}
            onPort={setImapPort}
          />
          <ServerRow
            label={t("onboarding:field.smtpHost")}
            host={smtpHost}
            onHost={setSmtpHost}
            hostPlaceholder={smtpGuess || t("onboarding:placeholder.smtpHost")}
            port={smtpPort}
            onPort={setSmtpPort}
          />
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-control border border-hairline bg-bg0/60 px-3 py-2">
          <div className="min-w-0 flex-1 text-xs text-ink-faint">
            <div className="truncate font-mono">
              {imapHost}:{imapPort}
            </div>
            <div className="truncate font-mono">
              {smtpHost}:{smtpPort}
            </div>
          </div>
          <button
            type="button"
            className="co-onb-link shrink-0 text-sm"
            onClick={() => setEditServers(true)}
          >
            {t("onboarding:editServers")}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-control border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={
            busy != null ||
            !email.trim() ||
            !password ||
            !imapEffective ||
            !smtpEffective
          }
        >
          {busy === "test"
            ? t("onboarding:testingConnection")
            : busy === "add"
              ? t("onboarding:adding")
              : t("onboarding:connect")}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          {t("onboarding:back")}
        </Button>
      </div>
    </form>
  );
}

/** Host and port for one server, on one line. */
function ServerRow({
  label,
  host,
  onHost,
  hostPlaceholder,
  port,
  onPort,
}: {
  label: string;
  host: string;
  onHost: (v: string) => void;
  hostPlaceholder: string;
  port: number;
  onPort: (v: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[1fr_80px] gap-2">
      <Field label={label}>
        <Input value={host} onChange={onHost} placeholder={hostPlaceholder} />
      </Field>
      <Field label={t("onboarding:field.port")}>
        <Input
          value={port ? String(port) : ""}
          onChange={(v) => onPort(Number(v.replace(/\D/g, "")) || 0)}
          inputMode="numeric"
          maxLength={5}
        />
      </Field>
    </div>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
  maxLength,
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  maxLength?: number;
  inputMode?: "numeric";
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={type}
      placeholder={placeholder}
      autoFocus={autoFocus}
      maxLength={maxLength}
      inputMode={inputMode}
      spellCheck={false}
      className={inputCls}
    />
  );
}
