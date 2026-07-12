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
        const remaining = Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000));
        return (
          <div
            key={t.id}
            className="co-toast-in pointer-events-auto flex items-center gap-3 rounded-lg border border-hairline bg-bg1 py-2 pr-2 pl-4 text-[13px] text-ink"
            style={{ boxShadow: "var(--elev-2)" }}
          >
            {t.kind === "error" && (
              <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden />
            )}
            <span>
              {t.countdown ? t.message.replace("{s}", String(remaining)) : t.message}
            </span>
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
          </div>
        );
      })}
    </div>
  );
}
