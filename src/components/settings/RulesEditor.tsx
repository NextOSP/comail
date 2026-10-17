import { useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type {
  AiAutomationAction,
  AiAutomationActionKind,
  AiAutomationPlan,
  AiAutomationRule,
  RuleCondition,
  Settings,
} from "../../ipc/types";
import { conditionProblems, simplify } from "../../lib/ruleCondition";
import { useAiStatus, useLabels, useSplits } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { AiBadge } from "../ui/Ai";
import { Icon } from "../ui/Icon";
import { AiCheckField } from "./AiCheckField";
import { ConditionBuilder, describeCondition } from "./ConditionBuilder";
import {
  Button,
  Checkbox,
  ConfirmButton,
  EmptyState,
  FormField,
  IconButton,
  inputCls,
  Select,
  Toggle,
} from "./panelKit";
import { asGroup, useConditionPreview } from "./SplitsPanel";

/** Saves the rule list; SettingsPanel owns the settings mutation. */
type Commit = (rules: AiAutomationRule[]) => void;

const ACTION_KINDS: readonly AiAutomationActionKind[] = [
  "add_label",
  "remove_label",
  "route_to",
  "mark_read",
  "star",
  "archive",
  "trash",
  "subject_prefix",
  "body_note",
];

const TEXT_ACTIONS = new Set<string>(["subject_prefix", "body_note"]);
const LABEL_ACTIONS = new Set<string>(["add_label", "remove_label"]);

export function newRule(
  partial: Partial<AiAutomationRule> = {},
): AiAutomationRule {
  return {
    id: `automation-${Date.now().toString(36)}`,
    name: "",
    sourcePrompt: "",
    instruction: "",
    enabled: true,
    actions: [],
    condition: null,
    ...partial,
  };
}

/** Human-readable action ("Add label: Finance"). */
export function useDescribeAction() {
  const { t } = useTranslation();
  const { data: labels } = useLabels();
  const { data: splits } = useSplits();
  const targetName = (value: string) => {
    if (value === "important") return t("inbox:split.important");
    if (value === "other") return t("inbox:split.other");
    if (value.startsWith("split:"))
      return (
        splits?.find((s) => s.id === Number(value.slice(6)))?.name ?? value
      );
    if (value.startsWith("label:"))
      return (
        labels?.find((l) => l.id === Number(value.slice(6)))?.name ?? value
      );
    return value;
  };
  return (action: AiAutomationAction) => {
    const base = t(`settings:ai.actions.${action.kind}`);
    if (action.kind === "route_to")
      return `${base}: ${targetName(action.value)}`;
    if (LABEL_ACTIONS.has(action.kind)) {
      const name =
        labels?.find((l) => l.id === Number(action.value))?.name ??
        action.value;
      return `${base}: ${name}`;
    }
    if (TEXT_ACTIONS.has(action.kind)) return `${base}: ${action.value}`;
    return base;
  };
}

/** Rules list + editor: a condition (the rule decision API), an optional AI
 *  check answered by the decision model, and the actions to run. */
export function RulesEditor({
  settings,
  commit,
}: {
  settings: Settings;
  commit: Commit;
}) {
  const { t } = useTranslation();
  const { data: labels } = useLabels();
  const describeAction = useDescribeAction();
  const [draft, setDraft] = useState<AiAutomationRule | null>(null);
  const rules = settings.aiAutomationRules;

  if (draft) {
    return (
      <RuleForm
        rules={rules}
        initial={draft}
        commit={commit}
        onDone={() => setDraft(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className="rounded-card border border-hairline bg-bg1 px-3.5 py-3"
        >
          <div className="flex items-start gap-3">
            <Toggle
              label={rule.name}
              checked={rule.enabled}
              onChange={(enabled) =>
                commit(
                  rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
                )
              }
            />
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => setDraft(structuredClone(rule))}
            >
              <span className="block truncate text-base font-medium text-ink">
                {rule.name}
              </span>
              <span className="mt-0.5 block line-clamp-2 text-xs leading-relaxed text-ink-faint">
                {ruleSummary(rule, t, labels ?? [])}
              </span>
            </button>
            <Button
              size="sm"
              icon="edit"
              onClick={() => setDraft(structuredClone(rule))}
            >
              {t("settings:ai.automation.edit")}
            </Button>
            <ConfirmButton
              label={t("settings:ai.automation.delete")}
              confirmLabel={t("settings:ai.automation.reallyDelete")}
              onConfirm={() => commit(rules.filter((r) => r.id !== rule.id))}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[52px]">
            {rule.actions.map((action, index) => (
              <span
                key={`${action.kind}-${index}`}
                className="max-w-full truncate rounded-full border border-hairline bg-bg0 px-2 py-0.5 text-2xs text-ink-muted"
              >
                {describeAction(action)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {rules.length === 0 && (
        <EmptyState
          icon="sparkle"
          title={t("settings:ai.automation.emptyTitle")}
          hint={t("settings:ai.automation.emptyHint")}
        />
      )}
      <Button
        variant="primary"
        icon="plus"
        className="mt-0.5 self-start"
        onClick={() => setDraft(newRule())}
      >
        {t("settings:ai.automation.add")}
      </Button>
    </div>
  );
}

/** "Sender ends with @x.com · AI: it is an invoice" */
export function ruleSummary(
  rule: AiAutomationRule,
  t: (key: string, opts?: Record<string, unknown>) => string,
  labels: { id: number; name: string }[],
): string {
  const parts: string[] = [];
  if (rule.condition) parts.push(describeCondition(rule.condition, t, labels));
  if (rule.instruction.trim())
    parts.push(
      t("settings:rules.aiCheckSummary", { text: rule.instruction.trim() }),
    );
  return parts.join(" · ") || rule.sourcePrompt;
}

/** Editor for one rule. Also used from Labels ("auto-apply this label"). */
export function RuleForm({
  rules,
  initial,
  commit,
  onDone,
}: {
  rules: AiAutomationRule[];
  initial: AiAutomationRule;
  commit: Commit;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { data: labels } = useLabels();
  const { data: splits } = useSplits();
  const { data: status } = useAiStatus();
  const pushToast = useUi((s) => s.pushToast);
  const describeAction = useDescribeAction();
  const userLabels = (labels ?? []).filter((l) => !l.isAuto);
  const autoLabels = (labels ?? []).filter((l) => l.isAuto);
  const ownTabSplits = (splits ?? []).filter((s) => s.target == null);

  const [rule, setRule] = useState<AiAutomationRule>(initial);
  const [useCondition, setUseCondition] = useState(initial.condition != null);
  const [tree, setTree] = useState(() => asGroup(initial.condition ?? null));
  const [plan, setPlan] = useState<AiAutomationPlan | null>(null);
  const [trying, setTrying] = useState(false);
  const patch = (p: Partial<AiAutomationRule>) =>
    setRule((r) => ({ ...r, ...p }));

  const condition: RuleCondition | null = useCondition ? simplify(tree) : null;
  const problems = condition ? conditionProblems(condition) : [];
  const preview = useConditionPreview(
    condition && problems.length === 0 ? condition : null,
  );
  const hasInstruction = rule.instruction.trim() !== "";
  const actionsValid =
    rule.actions.length > 0 &&
    rule.actions.every(
      (a) =>
        !(
          LABEL_ACTIONS.has(a.kind) ||
          TEXT_ACTIONS.has(a.kind) ||
          a.kind === "route_to"
        ) || a.value.trim() !== "",
    );
  const valid =
    rule.name.trim() !== "" &&
    actionsValid &&
    problems.length === 0 &&
    (condition != null || hasInstruction);
  const exists = rules.some((r) => r.id === rule.id);


  const tryPrompt = async () => {
    if (!rule.sourcePrompt.trim() || trying) return;
    setTrying(true);
    try {
      const next = await call("ai_plan_automation", {
        prompt: rule.sourcePrompt.trim(),
      });
      setPlan(next);
      if (next.supported) {
        patch({
          name: rule.name.trim() || next.name,
          instruction: next.instruction,
          actions: next.actions,
        });
      }
    } catch (err) {
      setPlan(null);
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setTrying(false);
    }
  };

  const save = () => {
    if (!valid) return;
    const saved: AiAutomationRule = {
      ...rule,
      name: rule.name.trim(),
      instruction: rule.instruction.trim(),
      condition,
    };
    commit(
      exists
        ? rules.map((r) => (r.id === saved.id ? saved : r))
        : [...rules, saved],
    );
    onDone();
  };

  const setAction = (i: number, a: AiAutomationAction) =>
    patch({ actions: rule.actions.map((x, j) => (j === i ? a : x)) });

  return (
    <div
      className="rounded-card border border-hairline bg-bg1 p-4 shadow-elev-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-md font-semibold text-ink">
            {exists
              ? t("settings:rules.editTitle")
              : t("settings:rules.newTitle")}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {t("settings:rules.editorHint")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <FormField label={t("settings:rules.nameLabel")}>
          <input
            className={inputCls}
            value={rule.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={t("settings:rules.namePlaceholder")}
            autoFocus
            spellCheck={false}
          />
        </FormField>

        {/* Optional: let the chat model draft the rule from plain language. */}
        {status?.configured && (
          <details className="group rounded-card border border-hairline bg-bg0">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink-muted">
              <AiBadge />
              <span className="flex-1">
                {t("settings:rules.describeLabel")}
              </span>
              <Icon
                name="chevronDown"
                size={14}
                className="transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="flex flex-col gap-2 border-t border-hairline px-3 py-3">
              <textarea
                className={`${inputCls} min-h-24 resize-y leading-relaxed`}
                value={rule.sourcePrompt}
                onChange={(e) => {
                  patch({ sourcePrompt: e.target.value });
                  setPlan(null);
                }}
                placeholder={t("settings:ai.automation.promptPlaceholder")}
                rows={3}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="ai"
                  size="sm"
                  busy={trying}
                  disabled={!rule.sourcePrompt.trim()}
                  onClick={() => void tryPrompt()}
                >
                  {trying
                    ? t("settings:ai.automation.trying")
                    : t("settings:rules.draftIt")}
                </Button>
                <span className="text-2xs text-ink-faint">
                  {t("settings:rules.draftHint")}
                </span>
              </div>
              {plan && !plan.supported && (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-xs leading-relaxed text-danger">
                  {plan.issues.map((issue, index) => (
                    <li key={`${issue}-${index}`}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}

        <section className="flex flex-col gap-2.5">
          <div className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("settings:rules.when")}
          </div>
          <Checkbox
            checked={useCondition}
            onChange={setUseCondition}
            label={t("settings:rules.useCondition")}
            hint={t("settings:rules.useConditionHint")}
          />
          {useCondition && (
            <>
              <ConditionBuilder
                value={tree}
                onChange={setTree}
                userLabels={userLabels}
              />
              {problems.length > 0 ? (
                <p className="text-xs text-ink-faint">
                  {problems
                    .map((p) => t(`settings:splits.cond.problems.${p}`))
                    .join(" ")}
                </p>
              ) : (
                preview && (
                  <p className="text-xs text-ink-faint">
                    {t("settings:splits.preview.matches", {
                      count: preview.total,
                      scanned: preview.scanned,
                    })}
                    {preview.samples.length > 0 &&
                      ` — ${preview.samples.map((s) => s.subject || s.fromAddr).join(" · ")}`}
                  </p>
                )
              )}
            </>
          )}
          <AiCheckField
            instruction={rule.instruction}
            onInstruction={(instruction) => patch({ instruction })}
            minConfidence={rule.minConfidence}
            onMinConfidence={(minConfidence) => patch({ minConfidence })}
            hasCondition={useCondition}
            feature="rules"
          />
        </section>

        <section className="flex flex-col gap-2">
          <div className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("settings:rules.then")}
          </div>
          {rule.actions.map((action, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg2 text-2xs font-semibold text-ink-faint">
                {i + 1}
              </span>
              <Select
                aria-label={t("settings:rules.actionKind")}
                value={action.kind}
                onChange={(e) =>
                  setAction(i, {
                    kind: e.target.value as AiAutomationActionKind,
                    value: "",
                  })
                }
              >
                {ACTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`settings:ai.actions.${k}`)}
                  </option>
                ))}
              </Select>
              {LABEL_ACTIONS.has(action.kind) && (
                <Select
                  aria-label={t("settings:rules.actionValue")}
                  value={action.value}
                  onChange={(e) =>
                    setAction(i, { ...action, value: e.target.value })
                  }
                >
                  <option value="">{t("settings:rules.pickLabel")}</option>
                  {userLabels.map((l) => (
                    <option key={l.id} value={String(l.id)}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
              {action.kind === "route_to" && (
                <Select
                  aria-label={t("settings:rules.actionValue")}
                  value={action.value}
                  onChange={(e) =>
                    setAction(i, { ...action, value: e.target.value })
                  }
                >
                  <option value="">{t("settings:rules.pickTab")}</option>
                  <option value="important">
                    {t("inbox:split.important")}
                  </option>
                  <option value="other">{t("inbox:split.other")}</option>
                  {ownTabSplits.map((s) => (
                    <option key={s.id} value={`split:${s.id}`}>
                      {t("settings:ai.automation.splitTarget", {
                        name: s.name,
                      })}
                    </option>
                  ))}
                  {autoLabels.map((l) => (
                    <option key={l.id} value={`label:${l.id}`}>
                      {t("settings:ai.automation.categoryTarget", {
                        name: l.name,
                      })}
                    </option>
                  ))}
                </Select>
              )}
              {TEXT_ACTIONS.has(action.kind) && (
                <input
                  aria-label={t("settings:rules.actionValue")}
                  className={`${inputCls} !w-[220px]`}
                  value={action.value}
                  onChange={(e) =>
                    setAction(i, { ...action, value: e.target.value })
                  }
                  placeholder={
                    action.kind === "subject_prefix"
                      ? "[INVOICE] "
                      : t("settings:rules.notePlaceholder")
                  }
                />
              )}
              <IconButton
                icon="close"
                size="xs"
                label={t("settings:rules.removeAction", {
                  action: describeAction(action),
                })}
                onClick={() =>
                  patch({ actions: rule.actions.filter((_, j) => j !== i) })
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            icon="plus"
            className="self-start"
            onClick={() =>
              patch({
                actions: [
                  ...rule.actions,
                  {
                    kind: "add_label",
                    value: userLabels[0] ? String(userLabels[0].id) : "",
                  },
                ],
              })
            }
          >
            {t("settings:rules.addAction")}
          </Button>
        </section>

        <div className="mt-1 flex items-center gap-2 border-t border-hairline pt-3">
          <Button variant="primary" disabled={!valid} onClick={save}>
            {t("settings:rules.save")}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            {t("settings:ai.automation.cancel")}
          </Button>
          {!valid && (
            <span className="ml-auto text-2xs text-ink-faint">
              {!rule.name.trim()
                ? t("settings:rules.needName")
                : condition == null && !hasInstruction
                  ? t("settings:rules.needMatch")
                  : problems.length > 0
                    ? t("settings:rules.fixCondition")
                    : t("settings:rules.needActions")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
