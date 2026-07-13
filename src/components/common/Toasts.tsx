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
        return (
          <div
            key={t.id}
            className="co-toast-in pointer-events-auto relative flex items-center gap-3 overflow-hidden rounded-lg border border-hairline bg-bg1 py-2 pr-2 pl-4 text-[13px] text-ink"
            style={{ boxShadow: "var(--elev-2)" }}
          >
            {t.kind === "error" && (
              <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden />
            )}
            <span>
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
          </div>
        );
      })}
    </div>
  );
}
