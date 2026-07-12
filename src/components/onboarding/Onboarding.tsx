import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { AddPasswordAccountArgs } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useUi } from "../../stores/ui";

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

export function Onboarding({ onClose }: { onClose?: () => void } = {}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  // Modal mode (opened from Settings) jumps straight to the IMAP form.
  const [showForm, setShowForm] = useState(onClose != null);
  const [oauthBusy, setOauthBusy] = useState<"gmail" | "microsoft" | null>(null);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("fastmail");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(PRESETS.fastmail.imapHost);
  const [imapPort, setImapPort] = useState(PRESETS.fastmail.imapPort);
  const [smtpHost, setSmtpHost] = useState(PRESETS.fastmail.smtpHost);
  const [smtpPort, setSmtpPort] = useState(PRESETS.fastmail.smtpPort);
  const [busy, setBusy] = useState<"test" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (key: keyof typeof PRESETS) => {
    setPreset(key);
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
    imapHost: imapHost.trim(),
    imapPort,
    smtpHost: smtpHost.trim(),
    smtpPort,
  });

  const submit = async () => {
    setError(null);
    setBusy("test");
    try {
      const test = await call("test_connection", { args: buildArgs() });
      if (!test.ok) {
        setError(test.error ? errorMessage(test.error) : t("onboarding:connectionFailed"));
        return;
      }
      setBusy("add");
      await call("add_account_password", { args: buildArgs() });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("onboarding:accountConnected", { email: email.trim() }) });
      onClose?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const oauth = async (provider: "gmail" | "microsoft") => {
    setOauthBusy(provider);
    try {
      await call("start_oauth", { provider });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("onboarding:oauthConnected") });
      onClose?.();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes("no OAuth app configured")) {
        // Take the user straight to the fields they need to fill in.
        useUi.getState().set({ panel: "settings" });
        onClose?.();
        pushToast({
          kind: "info",
          message: t("onboarding:oauthNotConfigured"),
          durationMs: 6000,
        });
      } else {
        pushToast({ kind: "error", message: errorMessage(err) });
      }
    } finally {
      setOauthBusy(null);
    }
  };

  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden"
      data-tauri-drag-region
      onMouseDown={onClose}
    >
      {!onClose && <div className="co-aurora" aria-hidden />}
      {!onClose && (
        <button
          className="absolute top-3 right-4 z-20 rounded-md p-2 text-ink-faint hover:bg-bg2 hover:text-ink"
          title={t("onboarding:settingsTitle")}
          aria-label={t("onboarding:settingsAria")}
          onClick={() => useUi.getState().set({ panel: "settings" })}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}
      <div
        className="co-pop-in relative z-10 w-[420px] rounded-2xl border border-hairline bg-bg1 p-8"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {onClose && (
          <button
            className="absolute top-3 right-3 rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={onClose}
            aria-label={t("onboarding:closeAria")}
          >
            ✕
          </button>
        )}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          {onClose ? t("onboarding:titleAddAccount") : "Comail"}
        </h1>
        <p className="mt-1 mb-6 text-[13px] text-ink-muted">
          {onClose
            ? t("onboarding:subtitleAddAccount")
            : t("onboarding:subtitleWelcome")}
        </p>

        {!showForm ? (
          <div className="flex flex-col gap-2.5">
            <button
              className="w-full rounded-lg bg-accent py-2.5 text-[14px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.99]"
              onClick={() => setShowForm(true)}
            >
              {t("onboarding:addAccountImapSmtp")}
            </button>
            <button
              className="w-full rounded-lg border border-hairline bg-bg0 py-2.5 text-[13.5px] text-ink-faint hover:bg-bg2 disabled:opacity-60"
              disabled={oauthBusy != null}
              onClick={() => void oauth("gmail")}
            >
              {oauthBusy === "gmail" ? t("onboarding:waitingForGoogle") : t("onboarding:signInWithGoogle")}
            </button>
            <button
              className="w-full rounded-lg border border-hairline bg-bg0 py-2.5 text-[13.5px] text-ink-faint hover:bg-bg2 disabled:opacity-60"
              disabled={oauthBusy != null}
              onClick={() => void oauth("microsoft")}
            >
              {oauthBusy === "microsoft" ? t("onboarding:waitingForMicrosoft") : t("onboarding:signInWithMicrosoft")}
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label={t("onboarding:field.provider")}>
              <select
                value={preset}
                onChange={(e) => applyPreset(e.target.value as keyof typeof PRESETS)}
                className="w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent/60"
              >
                {Object.keys(PRESETS).map((k) => (
                  <option key={k} value={k}>
                    {t(`onboarding:provider.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("onboarding:field.email")}>
              <Input value={email} onChange={setEmail} type="email" placeholder={t("onboarding:placeholder.email")} autoFocus />
            </Field>
            <Field label={t("onboarding:field.displayName")}>
              <Input value={displayName} onChange={setDisplayName} placeholder={t("onboarding:placeholder.displayName")} />
            </Field>
            <Field label={t("onboarding:field.password")}>
              <Input value={password} onChange={setPassword} type="password" placeholder={t("onboarding:placeholder.password")} />
            </Field>
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <Field label={t("onboarding:field.imapHost")}>
                <Input value={imapHost} onChange={setImapHost} placeholder={t("onboarding:placeholder.imapHost")} />
              </Field>
              <Field label={t("onboarding:field.port")}>
                <Input value={String(imapPort)} onChange={(v) => setImapPort(Number(v) || 0)} />
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <Field label={t("onboarding:field.smtpHost")}>
                <Input value={smtpHost} onChange={setSmtpHost} placeholder={t("onboarding:placeholder.smtpHost")} />
              </Field>
              <Field label={t("onboarding:field.port")}>
                <Input value={String(smtpPort)} onChange={(v) => setSmtpPort(Number(v) || 0)} />
              </Field>
            </div>

            {PRESETS[preset].hasNote && (
              <p className="text-[11.5px] text-ink-faint">{t(`onboarding:note.${preset}`)}</p>
            )}
            {error && <p className="text-[12.5px] text-danger">{error}</p>}

            <div className="mt-2 flex items-center gap-2">
              <button
                type="submit"
                disabled={busy != null || !email || !password || !imapHost}
                className="rounded-lg bg-accent px-4 py-2 text-[13.5px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
              >
                {busy === "test" ? t("onboarding:testingConnection") : busy === "add" ? t("onboarding:adding") : t("onboarding:connect")}
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-[13px] text-ink-muted hover:bg-bg2"
                onClick={() => setShowForm(false)}
              >
                {t("onboarding:back")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={type}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      className="w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
    />
  );
}
