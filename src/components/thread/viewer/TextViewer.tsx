import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUi } from "../../../stores/ui";
import { IconButton, Pill, PillDivider, useViewerKeys } from "./common";

const WRAP_KEY = "comail.viewer.wrap";

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Plain text / logs / code: line-number gutter, wrap toggle, copy. */
export function TextViewer({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [wrap, setWrap] = useState(readWrap);
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const gutter = String(lines.length).length;

  const toggleWrap = () =>
    setWrap((w) => {
      try {
        localStorage.setItem(WRAP_KEY, w ? "0" : "1");
      } catch {
        /* storage unavailable - session-only */
      }
      return !w;
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: "info", message: t("thread:attachment.preview.copied") });
    } catch {
      pushToast({ kind: "error", message: t("thread:details.copyFailed") });
    }
  };

  useViewerKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "w") {
      toggleWrap();
      return true;
    }
    return false;
  });

  return (
    <div className="relative h-full">
      <div className="co-viewer-scroll h-full overflow-auto">
        <div
          className={`grid min-w-fit py-4 pb-20 font-mono text-[12.5px] leading-[1.6] ${wrap ? "w-full" : ""}`}
          style={{ gridTemplateColumns: `calc(${gutter}ch + 32px) 1fr` }}
        >
          {lines.map((line, i) => (
            <div key={i} className="contents">
              <span className="sticky left-0 bg-bg0 pr-4 text-right text-ink-faint select-none tabular-nums">{i + 1}</span>
              <span className={`pr-6 text-ink select-text ${wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"}`}>{line || " "}</span>
            </div>
          ))}
          {truncated && (
            <div className="col-span-2 mt-3 text-center font-sans text-[11.5px] text-ink-faint">
              {t("thread:attachment.preview.truncated")}
            </div>
          )}
        </div>
      </div>
      <Pill>
        <span className="px-2 text-[11.5px] text-ink-faint tabular-nums">{t("thread:attachment.preview.lines", { count: lines.length })}</span>
        <PillDivider />
        <IconButton icon="wrap" label={t("thread:attachment.preview.wrap")} shortcut="W" active={wrap} onClick={toggleWrap} size={28} />
        <IconButton icon="copy" label={t("thread:attachment.preview.copy")} onClick={() => void copy()} size={28} />
      </Pill>
    </div>
  );
}
