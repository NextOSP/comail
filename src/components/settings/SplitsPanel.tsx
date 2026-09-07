import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type {
  ConditionPreview,
  Label,
  RuleCondition,
  SplitRule,
  SplitRuleQuery,
} from "../../ipc/types";
import {
  conditionProblems,
  isGroup,
  queryToCondition,
  simplify,
} from "../../lib/ruleCondition";
import { mergeTabOrder, nextTabPosition } from "../../lib/splitOrder";
import { queryClient } from "../../queries/client";
import { useLabels, useSplits } from "../../queries/hooks";
import { SPLIT_IMPORTANT, useUi } from "../../stores/ui";
import { Icon } from "../ui/Icon";
import {
  Button,
  Checkbox,
  ChipInput,
  ConfirmButton,
  EmptyState,
  FormField,
  inputCls,
  Segmented,
  Select,
  SettingsGroup,
} from "./panelKit";
import { AiCheckField } from "./AiCheckField";
import { ConditionBuilder, describeCondition } from "./ConditionBuilder";

type Automated = "any" | "automated" | "human";
type EditMode = "simple" | "advanced";
type GroupCondition = Extract<RuleCondition, { kind: "all" | "any" }>;

type SplitEditor = { kind: "new" } | { kind: "edit"; rule: SplitRule };

/** Longest tab name the editor accepts; the tab bar truncates well before this. */
const NAME_MAX_LENGTH = 64;
/** Beyond this many tabs the bar gets hard to scan; Settings shows a soft warning. */
const MANY_TABS = 7;

// Intl.ListFormat is ES2021, past tsconfig's ES2020 lib, so type the one
// constructor used here; every supported webview ships it.
const ListFormat = (
  Intl as unknown as {
    ListFormat?: new (
      lng: string,
      opts: { type: "conjunction" | "disjunction" },
    ) => { format(values: string[]): string };
  }
).ListFormat;

function formatList(
  values: string[],
  lng: string,
  type: "conjunction" | "disjunction",
  fallbackSep: string,
): string {
  try {
    if (ListFormat) return new ListFormat(lng, { type }).format(values);
  } catch {
    /* unknown locale tag: fall through */
  }
  return values.join(fallbackSep);
}

/** Locale-aware "a, b, or c" for a rule's any-of value lists. */
const anyOf = (values: string[], lng: string) =>
  formatList(values, lng, "disjunction", ", ");

/** Locale-aware "a, b, and c" for a rule's all-of conditions. */
const allOf = (values: string[], lng: string) =>
  formatList(values, lng, "conjunction", " · ");

/** Case- and whitespace-insensitive key for duplicate checks. */
const norm = (s: string) => s.trim().toLocaleLowerCase();

const DEFAULT_AUTO_LABEL_KEYWORDS = [
  "ComailAutoMarketing",
  "ComailAutoNews",
  "ComailAutoSocial",
  "ComailAutoPitch",
];

export function invalidateSplitViews() {
  void queryClient.invalidateQueries({ queryKey: ["splits"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
}

function describeQuery(
  q: SplitRuleQuery,
  t: TFunction,
  lng: string,
  labels: { id: number; name: string }[] = [],
): string {
  const parts: string[] = [];
  if (q.senders?.length)
    parts.push(
      t("settings:splits.describe.from", { senders: anyOf(q.senders, lng) }),
    );
  if (q.excludeSenders?.length)
    parts.push(
      t("settings:splits.describe.notFrom", {
        senders: anyOf(q.excludeSenders, lng),
      }),
    );
  if (q.recipients?.length)
    parts.push(
      t("settings:splits.describe.to", {
        recipients: anyOf(q.recipients, lng),
      }),
    );
  if (q.subjectContains?.length)
    parts.push(
      t("settings:splits.describe.subjectHas", {
        subjects: anyOf(q.subjectContains, lng),
      }),
    );
  if (q.labels?.length)
    parts.push(
      t("settings:splits.describe.hasLabel", {
        labels: anyOf(
          q.labels.map(
            (id) => labels.find((l) => l.id === id)?.name ?? `#${id}`,
          ),
          lng,
        ),
      }),
    );
  if (q.isAutomated === true)
    parts.push(t("settings:splits.describe.automatedOnly"));
  if (q.isAutomated === false)
    parts.push(t("settings:splits.describe.humanOnly"));
  if (q.hasAttachment) parts.push(t("settings:splits.describe.hasAttachment"));
  return parts.length > 0
    ? allOf(parts, lng)
    : t("settings:splits.describe.nothing");
}

/** Human name for a route target key ("important" | "other" | "label:<id>"). */
function targetName(
  target: string | null | undefined,
  labels: { id: number; name: string }[],
  t: TFunction,
): string {
  if (!target) return t("settings:splits.target.ownTab");
  if (target === "important") return t("inbox:split.important");
  if (target === "other") return t("inbox:split.other");
  const id = Number(target.slice("label:".length));
  return (
    labels.find((l) => l.id === id)?.name ?? t("settings:splits.target.ownTab")
  );
}

/** Compat shim: split management moved into Settings → Split inbox.
 *  Anything that still opens panel:"splits" is redirected there. */
export function SplitsPanel() {
  const open = useUi((s) => s.panel === "splits");
  const set = useUi((s) => s.set);
  useEffect(() => {
    if (open) set({ panel: "settings", settingsTab: "splits" });
  }, [open, set]);
  return null;
}

/** Split-inbox management, hosted inside the Settings panel. */
export function SplitInboxSection() {
  const { t, i18n } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const set = useUi((s) => s.set);
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const [editing, setEditing] = useState<SplitEditor | null>(null);
  // Drag handle to refocus once a keyboard reorder has re-rendered the list.
  const refocusKey = useRef<string | null>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const [relabeling, setRelabeling] = useState(false);
  const [restoringDefaults, setRestoringDefaults] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Custom splits and auto-label tabs share one order (see mergeTabOrder).
  const items = mergeTabOrder(splits, labels);
  const hasAutoLabels = items.some((it) => it.kind === "label");
  const missingAutoLabels = labels
    ? DEFAULT_AUTO_LABEL_KEYWORDS.filter(
        (keyword) =>
          !labels.some((label) => label.isAuto && label.keyword === keyword),
      ).length
    : 0;

  // Rules routed into an existing tab add no tab of their own.
  const ownTabCount = items.filter(
    (it) => it.kind === "label" || it.rule.target == null,
  ).length;

  useEffect(() => {
    if (refocusKey.current == null) return;
    handleRefs.current.get(refocusKey.current)?.focus();
    refocusKey.current = null;
  });

  const relabel = async () => {
    if (relabeling) return;
    setRelabeling(true);
    try {
      const n = await call("relabel_auto", {});
      pushToast({
        kind: "info",
        message: t("settings:splits.relabeled", { count: n }),
      });
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setRelabeling(false);
    }
  };

  const restoreDefaults = async () => {
    if (restoringDefaults) return;
    setRestoringDefaults(true);
    try {
      const count = await call("restore_auto_labels", {});
      pushToast({
        kind: "info",
        message: t("settings:splits.restoredDefaults", { count }),
      });
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setRestoringDefaults(false);
    }
  };

  // Move the tab at `from` so it sits at `to` (higher = earlier = wins first).
  // Custom splits and auto-label tabs share one order, so this drives both.
  const reorderTo = async (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // optimistic: renumber both caches so every tab reorders immediately
    const posOf = new Map(next.map((it, i) => [`${it.kind}:${it.id}`, i]));
    queryClient.setQueryData<SplitRule[]>(["splits"], (old) =>
      (old ?? []).map((s) => ({
        ...s,
        position: posOf.get(`split:${s.id}`) ?? s.position,
      })),
    );
    queryClient.setQueryData<Label[]>(["labels"], (old) =>
      (old ?? []).map((l) => ({
        ...l,
        position: posOf.get(`label:${l.id}`) ?? l.position,
      })),
    );
    try {
      await call("reorder_tabs", {
        order: next.map((it) => ({ kind: it.kind, id: it.id })),
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.reorderFailed", {
          detail: errorMessage(err),
        }),
      });
    } finally {
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    }
  };

  const deleteSplit = async (splitId: number) => {
    try {
      await call("delete_split", { splitId });
      // Don't leave the inbox pointed at a tab that no longer exists.
      if (useUi.getState().splitId === splitId) {
        set({
          splitId: SPLIT_IMPORTANT,
          selectedIndex: 0,
          selectedThreadId: null,
          selection: [],
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.deleteFailed", {
          detail: errorMessage(err),
        }),
      });
    } finally {
      invalidateSplitViews();
    }
  };

  const deleteLabel = async (labelId: number) => {
    try {
      await call("delete_label", { labelId });
      if (useUi.getState().labelFilter === labelId) {
        set({
          labelFilter: null,
          splitId: SPLIT_IMPORTANT,
          selectedIndex: 0,
          selectedThreadId: null,
          selection: [],
        });
      }
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    }
  };

  return (
    <section className="flex flex-col">
      {editing != null ? (
        <SplitForm
          key={
            editing.kind === "edit" ? `edit-${editing.rule.id}` : "new"
          }
          rule={editing.kind === "edit" ? editing.rule : null}
          nextPosition={nextTabPosition(splits, labels)}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <SettingsGroup
            title={t("settings:splits.customSplits")}
            description={
              <>
                {t("settings:splits.builtinNote")}
                {items.length > 1 && (
                  <span className="mt-0.5 block">
                    {t("settings:splits.priorityHint")}
                  </span>
                )}
                {/* +2: Important and Other are always tabs too. */}
                {ownTabCount > MANY_TABS && (
                  <span className="mt-0.5 block text-ink-muted">
                    {t("settings:splits.manyTabs", { count: ownTabCount + 2 })}
                  </span>
                )}
              </>
            }
            actions={
              <>
                {missingAutoLabels > 0 && (
                  <Button
                    size="sm"
                    busy={restoringDefaults}
                    onClick={() => void restoreDefaults()}
                  >
                    {restoringDefaults
                      ? t("settings:splits.restoringDefaults")
                      : t("settings:splits.restoreDefaults", {
                          count: missingAutoLabels,
                        })}
                  </Button>
                )}
                {hasAutoLabels && (
                  <Button
                    size="sm"
                    busy={relabeling}
                    onClick={() => void relabel()}
                  >
                    {relabeling
                      ? t("settings:splits.relabeling")
                      : t("settings:splits.relabel")}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon="plus"
                  onClick={() => setEditing({ kind: "new" })}
                >
                  {t("settings:splits.new")}
                </Button>
              </>
            }
          >
            {/* Important is the fixed first fallback bucket. */}
            <BuiltinRow
              name={t("settings:splits.builtin.importantName")}
              desc={t("settings:splits.builtin.importantDesc")}
              badge={t("settings:splits.builtin.firstBadge")}
            />
            {items.map((it, i) => (
              <div
                key={it.kind + it.id}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null) void reorderTo(dragIndex, i);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={`flex items-center gap-2.5 transition-colors ${
                  dragIndex === i
                    ? "opacity-40"
                    : overIndex === i && dragIndex !== null
                      ? "bg-accent/10"
                      : ""
                }`}
              >
                <button
                  type="button"
                  ref={(el) => {
                    const key = it.kind + it.id;
                    if (el) handleRefs.current.set(key, el);
                    else handleRefs.current.delete(key);
                  }}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  // Keyboard reorder: Arrow Up / Down move this tab one step.
                  onKeyDown={(e) => {
                    const to =
                      e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
                    if (to == null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (to < 0 || to >= items.length) return;
                    refocusKey.current = it.kind + it.id;
                    void reorderTo(i, to);
                  }}
                  title={t("settings:splits.dragHint")}
                  aria-label={t("settings:splits.reorderHandle", {
                    name: it.name,
                    position: i + 1,
                    total: items.length,
                  })}
                  className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-control bg-bg2 text-sm font-semibold text-ink-muted select-none active:cursor-grabbing"
                >
                  {i + 1}
                </button>
                <div className="flex shrink-0 flex-col">
                  <OrderButton
                    dir="up"
                    disabled={i === 0}
                    onClick={() => void reorderTo(i, i - 1)}
                  />
                  <OrderButton
                    dir="down"
                    disabled={i === items.length - 1}
                    onClick={() => void reorderTo(i, i + 1)}
                  />
                </div>
                {it.kind === "label" && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: it.label.color }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-ink">
                    {it.name}
                  </span>
                  {it.kind === "split" && (
                    <span className="block truncate text-xs text-ink-faint">
                      {it.rule.ai &&
                      !it.rule.condition &&
                      Object.keys(it.rule.query).length === 0
                        ? ""
                        : it.rule.condition
                          ? describeCondition(it.rule.condition, t, labels ?? [])
                          : describeQuery(
                              it.rule.query,
                              t,
                              i18n.language,
                              labels ?? [],
                            )}
                      {it.rule.ai &&
                        `${it.rule.condition || Object.keys(it.rule.query).length > 0 ? " · " : ""}${t(
                          "settings:rules.aiCheckSummary",
                          { text: it.rule.ai.instruction },
                        )}`}
                      {it.rule.target
                        ? ` ${t("settings:splits.routesTo", {
                            target: targetName(it.rule.target, labels ?? [], t),
                          })}`
                        : ""}
                    </span>
                  )}
                </span>
                {it.kind === "label" ? (
                  <>
                    <span className="rounded bg-bg2 px-1.5 py-px text-2xs font-semibold tracking-wide text-ink-faint uppercase">
                      {t("settings:splits.autoBadge")}
                    </span>
                    <ConfirmButton
                      label={t("settings:splits.delete")}
                      ariaLabel={t("settings:splits.deleteNamed", { name: it.name })}
                      confirmLabel={t("settings:splits.reallyDelete")}
                      onConfirm={() => void deleteLabel(it.id)}
                    />
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      icon="edit"
                      aria-label={t("settings:splits.editNamed", { name: it.name })}
                      onClick={() =>
                        setEditing({ kind: "edit", rule: it.rule })
                      }
                    >
                      {t("settings:splits.edit")}
                    </Button>
                    <ConfirmButton
                      label={t("settings:splits.delete")}
                      ariaLabel={t("settings:splits.deleteNamed", { name: it.name })}
                      confirmLabel={t("settings:splits.reallyDelete")}
                      onConfirm={() => void deleteSplit(it.id)}
                    />
                  </>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <div>
                <EmptyState title={t("settings:splits.empty")} />
              </div>
            )}
            {/* Other catches anything no earlier tab matched, so it is always last. */}
            <BuiltinRow
              name={t("settings:splits.builtin.otherName")}
              desc={t("settings:splits.builtin.otherDesc")}
              badge={t("settings:splits.builtin.lastBadge")}
            />
          </SettingsGroup>
        </>
      )}
    </section>
  );
}

/** A fixed, non-reorderable bucket (Important / Other) inside the tab list. */
function BuiltinRow({
  name,
  desc,
  badge,
}: {
  name: string;
  desc: string;
  badge: string;
}) {
  return (
    <div className="flex items-center gap-2.5 bg-bg2/60">
      <span className="text-base text-ink-muted">{name}</span>
      <span className="text-xs text-ink-faint">{desc}</span>
      <span className="ms-auto rounded bg-bg3 px-1.5 py-px text-2xs font-semibold tracking-wide text-ink-faint uppercase">
        {badge}
      </span>
    </div>
  );
}

function OrderButton({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={
        dir === "up"
          ? t("settings:splits.moveUp")
          : t("settings:splits.moveDown")
      }
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-7 items-center justify-center rounded text-ink-faint hover:bg-bg2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <Icon name={dir === "up" ? "chevronUp" : "chevronDown"} size={12} />
    </button>
  );
}

/** Labeled chip editor. Not a <label>: the chips' delete buttons would otherwise
 *  swallow the field's accessible name (same reason the Mail type row isn't one). */
function LabeledChips({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-faint">{label}</span>
      <ChipInput
        values={values}
        onChange={onChange}
        placeholder={placeholder}
        ariaLabel={label}
        removeLabel={t("settings:splits.removeToken")}
      />
    </div>
  );
}

function SplitForm({
  rule,
  nextPosition,
  onDone,
}: {
  rule: SplitRule | null;
  nextPosition: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: labels } = useLabels();
  const { data: splits } = useSplits();
  const autoLabels = (labels ?? []).filter((l) => l.isAuto);
  const userLabels = (labels ?? []).filter((l) => !l.isAuto);
  const [name, setName] = useState(rule?.name ?? "");
  const [senders, setSenders] = useState<string[]>(rule?.query.senders ?? []);
  const [excludeSenders, setExcludeSenders] = useState<string[]>(
    rule?.query.excludeSenders ?? [],
  );
  const [recipients, setRecipients] = useState<string[]>(
    rule?.query.recipients ?? [],
  );
  const [subjects, setSubjects] = useState<string[]>(
    rule?.query.subjectContains ?? [],
  );
  const [labelIds, setLabelIds] = useState<number[]>(rule?.query.labels ?? []);
  const [automated, setAutomated] = useState<Automated>(
    rule?.query.isAutomated === true
      ? "automated"
      : rule?.query.isAutomated === false
        ? "human"
        : "any",
  );
  const [hasAttachment, setHasAttachment] = useState(
    rule?.query.hasAttachment === true,
  );
  // "" = the rule is its own tab; otherwise a route key routed into an existing tab.
  const [target, setTarget] = useState<string>(rule?.target ?? "");
  const [countAll, setCountAll] = useState(rule?.countAll === true);
  const [busy, setBusy] = useState(false);
  // Optional AI check (decision model): with no condition it alone decides.
  const [aiInstruction, setAiInstruction] = useState(rule?.ai?.instruction ?? "");
  const [aiMin, setAiMin] = useState<number | null>(rule?.ai?.minConfidence ?? null);
  const hasAi = aiInstruction.trim() !== "";
  // Advanced mode edits a typed condition tree (AND/OR/NOT, more operators);
  // rules saved with one always reopen in it.
  const [mode, setMode] = useState<EditMode>(
    rule?.condition ? "advanced" : "simple",
  );
  const [tree, setTree] = useState<GroupCondition>(() =>
    asGroup(rule?.condition ?? null),
  );

  const buildQuery = (): SplitRuleQuery => {
    const query: SplitRuleQuery = {};
    if (senders.length > 0) query.senders = senders;
    // Excludes alone can't make a rule match; keep them out of hasCondition.
    if (excludeSenders.length > 0) query.excludeSenders = excludeSenders;
    if (recipients.length > 0) query.recipients = recipients;
    if (subjects.length > 0) query.subjectContains = subjects;
    // Drop stale ids so a deleted label can't leave a dead condition behind.
    const validLabelIds = labelIds.filter((id) =>
      userLabels.some((l) => l.id === id),
    );
    if (validLabelIds.length > 0) query.labels = validLabelIds;
    if (automated !== "any") query.isAutomated = automated === "automated";
    if (hasAttachment) query.hasAttachment = true;
    return query;
  };

  // The condition the backend will evaluate, for validation and the live preview.
  const effective: RuleCondition =
    mode === "advanced" ? simplify(tree) : queryToCondition(buildQuery());
  const problems = mode === "advanced" ? conditionProblems(effective) : [];
  const hasCondition =
    mode === "advanced"
      ? problems.length === 0
      : senders.length > 0 ||
        recipients.length > 0 ||
        subjects.length > 0 ||
        labelIds.length > 0 ||
        automated !== "any" ||
        hasAttachment;
  const preview = useConditionPreview(hasCondition ? effective : null);

  // Soft warnings (saving still works): another tab with the same name, and
  // senders another rule already claims (the higher rule would win them).
  const otherRules = (splits ?? []).filter((s) => s.id !== rule?.id);
  const nameKey = norm(name);
  const duplicateName =
    nameKey !== "" &&
    [
      ...otherRules.map((s) => s.name),
      ...autoLabels.map((l) => l.name),
      t("inbox:split.important"),
      t("inbox:split.other"),
    ].some((n) => norm(n) === nameKey);
  const senderOwners = new Map<string, string>();
  for (const other of otherRules) {
    for (const sender of other.query.senders ?? []) {
      if (!senderOwners.has(norm(sender))) senderOwners.set(norm(sender), other.name);
    }
  }
  const duplicateSenders =
    mode === "simple"
      ? senders.flatMap((sender) => {
          const owner = senderOwners.get(norm(sender));
          return owner != null ? [{ sender, owner }] : [];
        })
      : [];

  const switchMode = (next: EditMode) => {
    // Carry the simple fields over so switching never loses work; the reverse
    // keeps the simple fields as they were (a tree can't flatten in general).
    if (next === "advanced" && !rule?.condition && tree.of.length === 0) {
      setTree(asGroup(queryToCondition(buildQuery())));
    }
    setMode(next);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const query = buildQuery();
      const saved = await call("save_split", {
        split: {
          id: rule?.id ?? null,
          name: name.trim(),
          position: rule?.position ?? nextPosition,
          query,
          condition: mode === "advanced" ? effective : null,
          target: target || null,
          ai: hasAi
            ? { instruction: aiInstruction.trim(), minConfidence: aiMin }
            : null,
          // A targeted rule owns no tab, so the flag would be dead state.
          countAll: target ? false : countAll,
        },
      });
      // Routing an existing rule elsewhere removes its tab; don't leave the
      // inbox pointed at it.
      if (saved.target != null && useUi.getState().splitId === saved.id) {
        useUi
          .getState()
          .set({
            splitId: SPLIT_IMPORTANT,
            selectedIndex: 0,
            selectedThreadId: null,
            selection: [],
          });
      }
      invalidateSplitViews();
      onDone();
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.saveFailed", { detail: errorMessage(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Esc backs out of the form; a second Esc closes the panel.
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <FormField label={t("settings:splits.nameLabel")}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings:splits.namePlaceholder")}
          maxLength={NAME_MAX_LENGTH}
          autoFocus
          spellCheck={false}
        />
      </FormField>
      {duplicateName && (
        <p className="-mt-1 text-xs text-ink-muted" role="status">
          {t("settings:splits.duplicateName", { name: name.trim() })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Segmented<EditMode>
          value={mode}
          options={[
            { value: "simple", label: t("settings:splits.mode.simple") },
            { value: "advanced", label: t("settings:splits.mode.advanced") },
          ]}
          onChange={switchMode}
        />
        <span className="text-xs text-ink-faint">
          {t(`settings:splits.mode.${mode}Hint`)}
        </span>
      </div>
      {mode === "advanced" ? (
        <ConditionBuilder
          value={tree}
          onChange={setTree}
          userLabels={userLabels}
        />
      ) : (
        <>
          <LabeledChips
            label={t("settings:splits.senderLabel")}
            values={senders}
            onChange={setSenders}
            placeholder={t("settings:splits.senderPlaceholder")}
          />
          {duplicateSenders.length > 0 && (
            <p className="-mt-1 text-xs text-ink-muted" role="status">
              {duplicateSenders
                .map(({ sender, owner }) =>
                  t("settings:splits.duplicateSender", { sender, name: owner }),
                )
                .join(" ")}
            </p>
          )}
          <LabeledChips
            label={t("settings:splits.excludeSenderLabel")}
            values={excludeSenders}
            onChange={setExcludeSenders}
            placeholder={t("settings:splits.excludeSenderPlaceholder")}
          />
          <LabeledChips
            label={t("settings:splits.recipientLabel")}
            values={recipients}
            onChange={setRecipients}
            placeholder={t("settings:splits.recipientPlaceholder")}
          />
          <LabeledChips
            label={t("settings:splits.subjectLabel")}
            values={subjects}
            onChange={setSubjects}
            placeholder={t("settings:splits.subjectPlaceholder")}
          />
          {userLabels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-ink-faint">
                {t("settings:splits.labelLabel")}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {userLabels.map((l) => {
                  const on = labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setLabelIds((ids) =>
                          ids.includes(l.id)
                            ? ids.filter((x) => x !== l.id)
                            : [...ids, l.id],
                        )
                      }
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        on
                          ? "border-transparent"
                          : "border-hairline text-ink-muted hover:bg-bg2"
                      }`}
                      style={
                        on
                          ? { background: `${l.color}22`, color: l.color }
                          : undefined
                      }
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-ink-faint">
                {t("settings:splits.labelHint")}
              </span>
            </div>
          )}
          {/* not a <label>: it would swallow the segmented buttons' accessible names */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-faint">
              {t("settings:splits.automatedLabel")}
            </span>
            <div className="self-start">
              <Segmented<Automated>
                value={automated}
                options={[
                  { value: "any", label: t("settings:splits.automated.any") },
                  {
                    value: "automated",
                    label: t("settings:splits.automated.automated"),
                  },
                  {
                    value: "human",
                    label: t("settings:splits.automated.human"),
                  },
                ]}
                onChange={setAutomated}
              />
            </div>
            <span className="text-xs text-ink-faint">
              {t("settings:splits.automatedHint")}
            </span>
          </div>
          <div className="self-start">
            <Checkbox
              checked={hasAttachment}
              onChange={setHasAttachment}
              label={t("settings:splits.hasAttachmentLabel")}
            />
          </div>
        </>
      )}
      <AiCheckField
        instruction={aiInstruction}
        onInstruction={setAiInstruction}
        minConfidence={aiMin}
        onMinConfidence={setAiMin}
        hasCondition={hasCondition}
        feature="splits"
      />
      {/* Only a rule that owns a tab has a badge to change; a targeted rule's
          mail is counted by the tab it routes into. */}
      {!target && (
        <div className="self-start">
          <Checkbox
            checked={countAll}
            onChange={setCountAll}
            label={t("settings:splits.countAllLabel")}
            hint={t("settings:splits.countAllHint")}
          />
        </div>
      )}
      <FormField label={t("settings:splits.targetLabel")}>
        <Select
          className="self-start"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{t("settings:splits.target.ownTab")}</option>
          <option value="important">{t("inbox:split.important")}</option>
          <option value="other">{t("inbox:split.other")}</option>
          {autoLabels.map((l) => (
            <option key={l.id} value={`label:${l.id}`}>
              {l.name}
            </option>
          ))}
        </Select>
      </FormField>
      <p className="-mt-1 text-xs text-ink-faint">
        {t("settings:splits.targetHint")}
      </p>
      {!hasCondition && !(hasAi && problems.length === 0) && (
        <p className="text-xs text-ink-faint">
          {problems.length > 0
            ? problems
                .map((p) => t(`settings:splits.cond.problems.${p}`))
                .join(" ")
            : t("settings:splits.addCondition")}
        </p>
      )}
      {hasCondition && preview && (
        <p className="text-xs text-ink-faint">
          {t("settings:splits.preview.matches", {
            count: preview.total,
            scanned: preview.scanned,
          })}
          {preview.samples.length > 0 &&
            ` — ${preview.samples.map((s) => s.subject || s.fromAddr).join(" · ")}`}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!name.trim() || !(hasCondition || (hasAi && problems.length === 0))}
        >
          {busy
            ? t("settings:splits.saving")
            : rule
              ? t("settings:splits.saveChanges")
              : t("settings:splits.create")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("settings:splits.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function asGroup(c: RuleCondition | null): GroupCondition {
  if (!c) return { kind: "all", of: [] };
  return isGroup(c) ? c : { kind: "all", of: [c] };
}

/** Debounced dry-run of a draft condition against recent mail. */
export function useConditionPreview(
  condition: RuleCondition | null,
): ConditionPreview | null {
  const key = useMemo(
    () => (condition ? JSON.stringify(condition) : null),
    [condition],
  );
  const [result, setResult] = useState<ConditionPreview | null>(null);
  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      call("preview_split_condition", {
        condition: JSON.parse(key) as RuleCondition,
        limit: 3,
      })
        .then((r) => {
          if (!cancelled) setResult(r);
        })
        .catch(() => {
          if (!cancelled) setResult(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);
  return result;
}
