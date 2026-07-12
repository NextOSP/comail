import { useTranslation } from "react-i18next";
import { friendlyDate } from "../../lib/format";

export function InboxZero({ viewTitle }: { viewTitle: string }) {
  const { t } = useTranslation();
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
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">{t("inbox:zero.allDone")}</h1>
        <p className="text-[13.5px] text-ink-muted">
          {t("inbox:zero.nothingIn", { view: viewTitle.toLowerCase(), date: friendlyDate(Date.now()) })}
        </p>
        <p className="mt-4 text-[12px] text-ink-faint">
          <kbd className="co-kbd">Tab</kbd> {t("inbox:zero.hintNextSplit")} &ensp;·&ensp; <kbd className="co-kbd">C</kbd>{" "}
          {t("inbox:zero.hintCompose")} &ensp;·&ensp; <kbd className="co-kbd">?</kbd> {t("inbox:zero.hintShortcuts")}
        </p>
      </div>
    </div>
  );
}
