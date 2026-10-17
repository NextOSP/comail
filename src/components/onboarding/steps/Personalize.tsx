import { motion } from "motion/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ACCENT_PRESETS, accentHex, DEFAULT_ACCENT } from "../../../lib/accent";
import { MOD_LABEL } from "../../../lib/format";
import { useSettings } from "../../../queries/hooks";
import { useUi } from "../../../stores/ui";
import { updateSettings } from "../../settings/SettingsPanel";
import { Icon } from "../../ui/Icon";
import { Item, PrimaryCta, SPRING, Stagger, StepHeader } from "../flowParts";

type Theme = "snow" | "carbon" | "system";

/** Theme + accent, applied live (the whole window - preview included -
 *  re-skins as you pick) and persisted through the normal settings write. */
export function PersonalizeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const theme = useUi((s) => s.theme);
  const { data: settings } = useSettings();
  const accent = settings?.accentColor ?? DEFAULT_ACCENT;
  // Resolved here rather than read off <html data-theme>: that attribute is
  // written by App's theme effect *after* this render, one pick behind.
  const resolved =
    theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "carbon" : "snow") : theme;

  // Cross-fade colors while this step is up, so a pick re-skins smoothly
  // instead of snapping (see .co-reskin in app.css).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("co-reskin");
    return () => root.classList.remove("co-reskin");
  }, []);

  return (
    <Stagger className="flex flex-col">
      <StepHeader
        title={t("onboarding:flow.personalize.title")}
        body={t("onboarding:flow.personalize.body", { mod: MOD_LABEL })}
      />
      <Item className="mt-7">
        <p className="co-onb-label">{t("onboarding:flow.personalize.theme")}</p>
        <div className="grid grid-cols-3 gap-2.5">
          {(["snow", "carbon", "system"] as Theme[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`co-theme-card ${theme === key ? "is-active" : ""}`}
              aria-pressed={theme === key}
              onClick={() => void updateSettings({ theme: key })}
            >
              <ThemeThumb kind={key} />
              <span>{t(`onboarding:flow.personalize.themes.${key}`)}</span>
            </button>
          ))}
        </div>
      </Item>
      <Item className="mt-6">
        <p className="co-onb-label">{t("onboarding:flow.personalize.accent")}</p>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_PRESETS.map((p) => (
            <motion.button
              key={p.key}
              type="button"
              className="co-swatch"
              style={{ background: accentHex(p.key, resolved) }}
              aria-label={p.key}
              aria-pressed={accent === p.key}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.92 }}
              transition={SPRING}
              onClick={() => void updateSettings({ accentColor: p.key })}
            >
              {accent === p.key && (
                <motion.span layoutId="co-swatch-ring" className="co-swatch-ring" transition={SPRING} />
              )}
              {accent === p.key && <Icon name="check" size={12} />}
            </motion.button>
          ))}
        </div>
      </Item>
      <Item className="mt-9">
        <PrimaryCta onClick={onNext}>{t("onboarding:flow.continue")}</PrimaryCta>
      </Item>
    </Stagger>
  );
}

/** A tiny fixed-palette window sketch (the system card is half of each). */
function ThemeThumb({ kind }: { kind: Theme }) {
  const half = (dark: boolean) => (
    <div className={`co-theme-thumb ${dark ? "is-dark" : ""}`}>
      <div className="co-theme-thumb-side" />
      <div className="co-theme-thumb-main">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
  if (kind !== "system") return <div className="co-theme-thumb-frame">{half(kind === "carbon")}</div>;
  return (
    <div className="co-theme-thumb-frame co-theme-thumb-split">
      {half(false)}
      {half(true)}
    </div>
  );
}
