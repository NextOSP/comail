import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUi } from "../../stores/ui";
import { Button, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";

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
            className={`co-toast-in pointer-events-auto relative flex max-w-[min(30rem,92vw)] items-center gap-2.5 overflow-hidden rounded-card border py-2 pr-1.5 pl-3 text-base text-ink shadow-elev-2 ${
              isError ? "border-danger/35" : "border-hairline bg-bg1"
            }`}
            style={{
              // Tint mixed into the opaque surface: a translucent danger fill
              // lets the list underneath show through the floating toast.
              ...(isError && {
                background: "color-mix(in srgb, var(--danger) 8%, var(--bg1))",
              }),
            }}
          >
            <span
              className={`shrink-0 self-start ${isError ? "text-danger" : "text-ink-faint"}`}
              style={{ marginTop: "0.1875rem" }}
            >
              <Icon name={isError ? "alert" : "info"} size={16} />
            </span>
            <span className="min-w-0 grow break-words py-0.5 leading-snug">
              {t.countdown ? t.message.replace("{s}", String(remaining)) : t.message}
            </span>
            {t.secondaryLabel && (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 font-semibold !text-accent"
                onClick={() => {
                  t.onSecondary?.();
                  dismiss(t.id);
                }}
              >
                {t.secondaryLabel}
              </Button>
            )}
            {t.actionLabel && (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 font-semibold !text-accent"
                onClick={() => {
                  t.onAction?.();
                  dismiss(t.id);
                }}
              >
                {t.actionLabel}
              </Button>
            )}
            <IconButton
              icon="close"
              size="xs"
              label={tr("common:action.dismiss")}
              className="mt-0.5 self-start"
              onClick={() => dismiss(t.id)}
            />
            {t.countdown && (
              // Thin progress bar draining along the bottom edge.
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/60"
                aria-hidden
                style={{ width: `${Math.max(0, (1 - progress) * 100)}%` }}
              />
            )}
            {t.progress !== undefined && (
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/10"
                aria-hidden
              >
                <span
                  className={`co-progress-fill absolute inset-y-0 left-0 bg-accent ${
                    t.progress == null ? "is-indeterminate" : "is-loading"
                  }`}
                  style={
                    t.progress == null
                      ? undefined
                      : {
                          width: `${Math.min(100, Math.max(0, t.progress * 100))}%`,
                        }
                  }
                />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
