import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUi } from "../../stores/ui";

export function Toasts() {
  const { t: tr } = useTranslation();
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const [, tick] = useState(0);

  const hasCountdown = toasts.some((t) => t.countdown);
  useEffect(() => {
    if (!hasCountdown) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [hasCountdown]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => {
        const msLeft = Math.max(0, t.expiresAt - Date.now());
        const remaining = Math.ceil(msLeft / 1000);
        // Fraction of time elapsed, for the countdown bar (undo-send toasts).
        const progress = t.countdown && t.durationMs ? 1 - msLeft / t.durationMs : 0;
        const isError = t.kind === "error";
        return (
          <div
            key={t.id}
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
            className={`co-toast-in pointer-events-auto relative flex max-w-[min(30rem,92vw)] items-start gap-2.5 overflow-hidden rounded-lg border py-2.5 pr-2 pl-3.5 text-[13px] text-ink ${
              isError ? "border-danger/35 bg-danger/[0.06]" : "border-hairline bg-bg1"
            }`}
            style={{ boxShadow: "var(--elev-2)" }}
          >
            {isError && (
              <svg
                className="mt-px size-4 shrink-0 text-danger"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v5" />
                <path d="M12 16.5v.01" />
              </svg>
            )}
            <span className="min-w-0 break-words leading-snug">
              {t.countdown ? t.message.replace("{s}", String(remaining)) : t.message}
            </span>
            {t.secondaryLabel && (
              <button
                className="rounded-md px-2 py-1 text-[12.5px] font-semibold text-accent hover:bg-bg2"
                onClick={() => {
                  t.onSecondary?.();
                  dismiss(t.id);
                }}
              >
                {t.secondaryLabel}
              </button>
            )}
            {t.actionLabel && (
              <button
                className="rounded-md px-2 py-1 text-[12.5px] font-semibold text-accent hover:bg-bg2"
                onClick={() => {
                  t.onAction?.();
                  dismiss(t.id);
                }}
              >
                {t.actionLabel}
              </button>
            )}
            <button
              className="rounded-md px-1.5 py-1 text-ink-faint hover:bg-bg2 hover:text-ink-muted"
              onClick={() => dismiss(t.id)}
              aria-label={tr("common:action.dismiss")}
            >
              ✕
            </button>
            {t.countdown && (
              // Thin progress bar draining along the bottom edge.
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/60"
                aria-hidden
                style={{ width: `${Math.max(0, (1 - progress) * 100)}%` }}
              />
            )}
            {t.progress != null && (
              // Determinate fill growing along the bottom edge (update download).
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent transition-[width] duration-200 ease-out"
                aria-hidden
                style={{ width: `${Math.min(100, Math.max(0, t.progress * 100))}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
