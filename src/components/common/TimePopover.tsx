import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseNaturalTime, snoozePresets } from "../../lib/snooze";

/**
 * Shared time picker for Snooze (H) and Send later (Cmd+Shift+L):
 * a free-text natural-language input plus preset buttons.
 */
export function TimePopover({
  title,
  verb,
  onPick,
  onClose,
}: {
  title: string;
  verb: string;
  onPick: (at: number, label: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const presets = useMemo(() => snoozePresets(), []);
  const parsed = useMemo(() => parseNaturalTime(input), [input]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="co-overlay flex items-start justify-center pt-[18vh]" onMouseDown={onClose}>
      <div
        className="co-pop-in w-[380px] rounded-xl border border-hairline bg-bg1 p-3"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-1 pb-2 text-[12px] font-semibold tracking-wide text-ink-faint uppercase">
          {title}
        </div>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && parsed) {
              e.preventDefault();
              onPick(parsed.at, parsed.label);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder={t("common:timePopover.placeholder")}
          className="w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
        />
        <div className="min-h-[26px] px-1 pt-1.5 text-[12.5px]">
          {input.trim() &&
            (parsed ? (
              <span className="text-accent">
                ↵ {verb} {parsed.label}
              </span>
            ) : (
              <span className="text-ink-faint">{t("common:timePopover.keepTyping")}</span>
            ))}
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {presets.map((p) => (
            <button
              key={p.name}
              className="flex items-center justify-between rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink hover:bg-bg2"
              onClick={() => onPick(p.at, p.label)}
            >
              <span>{p.name}</span>
              <span className="text-[12px] text-ink-faint">{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
