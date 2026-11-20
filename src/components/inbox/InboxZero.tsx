import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutHint } from "../../keyboard/registry";
import { friendlyDate } from "../../lib/format";

/** `viewTitle` is shown as-is (no case folding: lowercasing translated text
 *  is wrong in many languages); in the inbox it is the active tab's name. */
export function InboxZero({ viewTitle }: { viewTitle: string }) {
  const { t } = useTranslation();
  const hint = useShortcutHint();
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <div className="co-halo" aria-hidden />
      <div className="co-fade-in relative z-10 flex flex-col items-center gap-2 text-center">
        <svg
          width="42"
          height="42"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mb-2 opacity-80"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{t("inbox:zero.allDone")}</h1>
        <p className="text-base text-ink-muted">
          {t("inbox:zero.nothingIn", { view: viewTitle, date: friendlyDate(Date.now()) })}
        </p>
        <p className="mt-4 text-sm text-ink-faint">
          {[
            [hint("next-split"), t("inbox:zero.hintNextSplit")],
            [hint("compose"), t("inbox:zero.hintCompose")],
            [hint("help"), t("inbox:zero.hintShortcuts")],
          ]
            .filter(([key]) => key)
            .map(([key, label], i) => (
              <Fragment key={label}>
                {i > 0 && <>&ensp;·&ensp;</>}
                <kbd className="co-kbd">{key}</kbd> {label}
              </Fragment>
            ))}
        </p>
      </div>
    </div>
  );
}
