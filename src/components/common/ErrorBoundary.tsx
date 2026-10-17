import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";

/**
 * Catches render errors so a crash shows a themed recovery card instead of
 * unmounting the tree and leaving an empty window behind.
 *
 * `resetKey` clears the error when it changes (e.g. the user navigates to a
 * different screen), so one broken view doesn't wedge the whole app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: unknown; fullScreen?: boolean },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CrashCard
        error={this.state.error}
        fullScreen={this.props.fullScreen}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

function CrashCard({
  error,
  fullScreen,
  onRetry,
}: {
  error: Error;
  fullScreen?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation("errors");
  const [copied, setCopied] = useState(false);
  const details = `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ""}`;

  return (
    <div
      className={`flex flex-1 items-center justify-center bg-bg0 p-6 text-ink ${
        fullScreen ? "fixed inset-0 z-[60]" : "min-h-0"
      }`}
    >
      <div
        role="alert"
        className="co-pop-in flex w-[min(28rem,100%)] flex-col gap-3 rounded-card border border-hairline bg-bg1 p-5 shadow-elev-2"
      >
        <div className="flex items-start gap-3">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-full text-danger"
            style={{ background: "color-mix(in srgb, var(--danger) 12%, var(--bg1))" }}
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 8v5" />
              <path d="M12 16.5v.01" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-snug">{t("crash.title")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t("crash.body")}</p>
          </div>
        </div>
        <details className="group rounded-md border border-hairline bg-bg0 text-[12px]">
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-ink-muted hover:text-ink">
            {t("crash.details")}
          </summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-[11.5px] text-ink-muted select-text">
            {details}
          </pre>
        </details>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              navigator.clipboard
                ?.writeText(details)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? t("crash.copied") : t("crash.copy")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => location.reload()}>
            {t("crash.reload")}
          </Button>
          <Button variant="primary" size="sm" onClick={onRetry}>
            {t("crash.retry")}
          </Button>
        </div>
      </div>
    </div>
  );
}
