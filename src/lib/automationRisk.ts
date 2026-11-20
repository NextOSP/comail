import type { AiAutomationActionKind, AiAutomationRule } from "../ipc/types";

/** Actions "Run automations" may apply across the inbox without asking: they
 *  only file and tag mail. Every other action changes the mail itself
 *  (archive, trash, mark read, star, notes) in bulk. */
const FILING_ACTIONS = new Set<AiAutomationActionKind>(["add_label", "remove_label", "route_to"]);

/** What running the rules over the whole inbox would do that is worth a
 *  confirmation first. */
export interface AutomationRisk {
  /** Non-filing action kinds the enabled rules carry, in rule order. */
  actions: AiAutomationActionKind[];
  /** Some enabled rule has an AI check: up to one model call per conversation. */
  ai: boolean;
}

/** The risk of "Run automations" for these rules, or null when every rule
 *  only files and tags mail by condition. Counts the rules the core runs:
 *  enabled, with an action, and a condition or AI check. */
export function automationRisk(rules: AiAutomationRule[]): AutomationRisk | null {
  const live = rules.filter(
    (r) => r.enabled && r.actions.length > 0 && (r.condition != null || r.instruction.trim() !== ""),
  );
  const actions = [
    ...new Set(live.flatMap((r) => r.actions.map((a) => a.kind)).filter((k) => !FILING_ACTIONS.has(k))),
  ];
  const ai = live.some((r) => r.instruction.trim() !== "");
  return actions.length > 0 || ai ? { actions, ai } : null;
}

/** The confirmation shown before "Run automations": how many inbox
 *  conversations it runs on (every one while the count loads), what it does
 *  to matching mail, and whether it calls the AI. */
export function automationRiskMessage(
  risk: AutomationRisk,
  inboxCount: number | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts = [
    inboxCount == null
      ? t("settings:ai.resortConfirmEvery")
      : t("settings:ai.resortConfirm", { count: inboxCount }),
  ];
  if (risk.actions.length > 0) {
    const actions = risk.actions.map((k) => t(`settings:ai.actions.${k}`)).join(", ");
    parts.push(t("settings:ai.resortConfirmActions", { actions }));
  }
  if (risk.ai) parts.push(t("settings:ai.resortConfirmAi"));
  return parts.join(" ");
}
