import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Button";
import { ImapForm, OAuthButtons, useOAuth } from "./connect";

/**
 * The add-account modal opened from Settings (first run uses OnboardingFlow).
 * Opens straight on the IMAP form; Back reveals the OAuth sign-in options.
 * Not ui/Modal: App's AddAccountOverlay already provides the overlay.
 */
export function AddAccountCard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(true);
  const oauth = useOAuth({ onDone: onClose, onLeave: onClose });

  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden"
      data-tauri-drag-region
      onMouseDown={onClose}
    >
      <div
        className="co-pop-in relative z-10 w-[420px] rounded-sheet border border-hairline bg-bg1 p-8 shadow-elev-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconButton
          icon="close"
          label={t("onboarding:closeAria")}
          className="absolute top-3 right-3"
          onClick={onClose}
        />
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {t("onboarding:titleAddAccount")}
        </h1>
        <p className="mt-1 mb-6 text-base text-ink-muted">{t("onboarding:subtitleAddAccount")}</p>

        {showForm ? (
          <ImapForm onDone={onClose} onBack={() => setShowForm(false)} />
        ) : (
          <div className="flex flex-col gap-2.5">
            <button
              className="w-full rounded-control bg-accent py-2.5 text-md font-semibold text-on-accent transition-transform hover:brightness-110 active:scale-[0.99]"
              onClick={() => setShowForm(true)}
            >
              {t("onboarding:addAccountImapSmtp")}
            </button>
            <OAuthButtons oauth={oauth} />
          </div>
        )}
      </div>
    </div>
  );
}
