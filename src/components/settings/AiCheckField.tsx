import { useTranslation } from "react-i18next";
import { useAiStatus, useSettings } from "../../queries/hooks";
import { ConfidenceSlider } from "./DecisionSettings";
import { Checkbox, inputCls } from "./panelKit";

/** "AI check" editor shared by rules and splits: the yes/no question, who
 *  answers it (decision model, chat model, or nobody), and an optional
 *  per-check confidence bar. */
export function AiCheckField({
  instruction,
  onInstruction,
  minConfidence,
  onMinConfidence,
  hasCondition,
  feature,
}: {
  instruction: string;
  onInstruction: (v: string) => void;
  minConfidence: number | null | undefined;
  onMinConfidence: (v: number | null) => void;
  hasCondition: boolean;
  /** Which "use decision models for" switch applies. */
  feature: "rules" | "splits";
}) {
  const { t } = useTranslation();
  const { data: status } = useAiStatus();
  const { data: settings } = useSettings();
  const globalMin = settings?.decisionMinConfidence ?? 0.6;
  const useDecision =
    feature === "rules" ? settings?.decisionUseRules !== false : settings?.decisionUseSplits !== false;
  const chatAllowed = settings?.decisionChatFallback !== false || !status?.decisionConfigured;
  const has = instruction.trim() !== "";

  // Who answers: the decision model when set and enabled, else the chat model.
  const who =
    status?.decisionConfigured && useDecision
      ? status.configured && chatAllowed
        ? t("settings:rules.answeredByDecisionThenChat", {
            model: status.decisionModel,
            chat: status.model,
          })
        : t("settings:rules.answeredByDecision", { model: status.decisionModel })
      : status?.configured
        ? t("settings:rules.answeredByChat", { model: status.model })
        : t("settings:rules.answeredByNone");

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-ink-faint">
          {t("settings:rules.aiCheckLabel")}
          <span className="font-normal">{t("settings:rules.optional")}</span>
        </span>
        <textarea
          className={`${inputCls} resize-y leading-relaxed`}
          value={instruction}
          onChange={(e) => onInstruction(e.target.value)}
          placeholder={t("settings:rules.aiCheckPlaceholder")}
          rows={2}
        />
      </label>
      <span className="text-2xs leading-relaxed text-ink-faint">
        {has
          ? `${hasCondition ? t("settings:rules.aiCheckBoth") : t(`settings:rules.aiCheckOnly_${feature}`)} ${who}`
          : t(`settings:rules.aiCheckHint_${feature}`)}
      </span>
      {has && (
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox
            checked={minConfidence != null}
            onChange={(on) => onMinConfidence(on ? globalMin : null)}
            label={t("settings:rules.ownConfidence", { pct: Math.round(globalMin * 100) })}
          />
          {minConfidence != null && (
            <ConfidenceSlider
              value={minConfidence}
              onChange={onMinConfidence}
              label={t("settings:rules.ownConfidenceLabel")}
            />
          )}
        </div>
      )}
    </div>
  );
}
