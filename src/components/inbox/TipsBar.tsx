import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCommands, shortcutFor } from "../../keyboard/registry";
import { useUi } from "../../stores/ui";
import { Button, IconButton } from "../ui/Button";

// Persisted like the other UI conveniences (cf. `comail:introSeen`): a plain
// localStorage flag, guarded for contexts where storage is unavailable.
const STORAGE_KEY = "comail:tipsBarDismissed";
// One-time intro to split tabs, shown ahead of the key tips until dismissed.
const SPLITS_TIP_KEY = "comail:splitsTipDismissed";

function isDismissed(key = STORAGE_KEY): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* ignore - the tip just comes back next launch */
  }
}

/** Command ids taught by the bar, paired with their inbox:tips.* label. */
const TIPS = [
  ["mark-done", "done"],
  ["snooze", "remind"],
  ["compose", "compose"],
  ["search", "search"],
  ["palette", "command"],
] as const;

/**
 * Superhuman-style footer that teaches the core triage keys until dismissed.
 * Shortcuts come from the registry so the bar tracks the real bindings.
 */
export function TipsBar() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => isDismissed());
  const [splitsTipDismissed, setSplitsTipDismissed] = useState(() => isDismissed(SPLITS_TIP_KEY));

  const tips = useMemo(() => {
    const cmds = getCommands();
    return TIPS.flatMap(([id, key]) => {
      const cmd = cmds.find((c) => c.id === id);
      const sc = cmd && shortcutFor(cmd);
      return sc ? [{ key, shortcut: sc }] : [];
    });
  }, []);

  const dismissSplitsTip = () => {
    setSplitsTipDismissed(true);
    rememberDismissed(SPLITS_TIP_KEY);
  };

  if (!splitsTipDismissed) {
    return (
      <div className="co-fade-in flex h-8 shrink-0 items-center justify-center gap-3 border-t border-hairline bg-bg1 px-4 text-sm text-ink-faint">
        <span className="flex min-w-0 items-center gap-1.5">
          <kbd className="co-kbd">Tab</kbd>
          <span className="truncate">{t("inbox:tips.splits")}</span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dismissSplitsTip();
            useUi.getState().set({ panel: "settings", settingsTab: "splits" });
          }}
        >
          {t("inbox:tips.splitsOpen")}
        </Button>
        <IconButton icon="close" size="xs" label={t("inbox:tips.dismiss")} onClick={dismissSplitsTip} />
      </div>
    );
  }

  if (dismissed || tips.length === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    rememberDismissed(STORAGE_KEY);
  };

  return (
    <div className="co-fade-in flex h-8 shrink-0 items-center justify-center gap-4 border-t border-hairline bg-bg1 px-4 text-sm text-ink-faint">
      {tips.map((tip) => (
        <span key={tip.key} className="flex items-center gap-1.5">
          <kbd className="co-kbd">{tip.shortcut}</kbd>
          {t(`inbox:tips.${tip.key}`)}
        </span>
      ))}
      <IconButton icon="close" size="xs" label={t("inbox:tips.dismiss")} className="ms-2" onClick={dismiss} />
    </div>
  );
}
