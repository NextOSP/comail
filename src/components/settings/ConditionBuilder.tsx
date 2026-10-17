import { useTranslation } from "react-i18next";
import type { Label, RuleCondition, TextOp } from "../../ipc/types";
import {
  emptyLeaf,
  isGroup,
  RULE_MAX_DEPTH,
  type LeafKind,
} from "../../lib/ruleCondition";
import { Button, IconButton, inputCls, Segmented, Select } from "./panelKit";

type Group = Extract<RuleCondition, { kind: "all" | "any" }>;

const LEAF_KINDS: LeafKind[] = [
  "sender",
  "recipient",
  "subject",
  "label",
  "isAutomated",
  "hasAttachment",
];
const TEXT_OPS: TextOp[] = ["contains", "equals", "startsWith", "endsWith"];

/** Editor for a typed split-rule condition tree. The root is always a group;
 *  each child can be negated, and groups nest up to RULE_MAX_DEPTH. */
export function ConditionBuilder({
  value,
  onChange,
  userLabels,
}: {
  value: Group;
  onChange: (c: Group) => void;
  userLabels: Label[];
}) {
  return (
    <GroupEditor
      group={value}
      onChange={onChange}
      userLabels={userLabels}
      depth={1}
    />
  );
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  userLabels,
  depth,
}: {
  group: Group;
  onChange: (g: Group) => void;
  onRemove?: () => void;
  userLabels: Label[];
  depth: number;
}) {
  const { t } = useTranslation();
  const setChild = (i: number, c: RuleCondition) =>
    onChange({ ...group, of: group.of.map((x, j) => (j === i ? c : x)) });
  const removeChild = (i: number) =>
    onChange({ ...group, of: group.of.filter((_, j) => j !== i) });

  return (
    <div
      className={`flex flex-col gap-2 rounded-control ${depth > 1 ? "border border-hairline bg-bg2/40 p-2.5" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Segmented<"all" | "any">
          value={group.kind}
          options={[
            { value: "all", label: t("settings:splits.cond.all") },
            { value: "any", label: t("settings:splits.cond.any") },
          ]}
          onChange={(kind) => onChange({ ...group, kind })}
        />
        <span className="text-xs text-ink-faint">
          {t("settings:splits.cond.ofTheseHint")}
        </span>
        {onRemove && (
          <span className="ml-auto">
            <IconButton
              icon="close"
              size="xs"
              label={t("settings:splits.cond.remove")}
              onClick={onRemove}
            />
          </span>
        )}
      </div>
      {group.of.map((child, i) => (
        <ChildEditor
          key={i}
          cond={child}
          onChange={(c) => setChild(i, c)}
          onRemove={() => removeChild(i)}
          userLabels={userLabels}
          depth={depth}
        />
      ))}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          onClick={() =>
            onChange({ ...group, of: [...group.of, emptyLeaf("sender")] })
          }
        >
          {t("settings:splits.cond.addCondition")}
        </Button>
        {depth < RULE_MAX_DEPTH - 1 && (
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() =>
              onChange({
                ...group,
                of: [
                  ...group.of,
                  {
                    kind: group.kind === "all" ? "any" : "all",
                    of: [emptyLeaf("sender")],
                  },
                ],
              })
            }
          >
            {t("settings:splits.cond.addGroup")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** One child of a group: an optional `not` wrapper around a leaf or subgroup. */
function ChildEditor({
  cond,
  onChange,
  onRemove,
  userLabels,
  depth,
}: {
  cond: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
  userLabels: Label[];
  depth: number;
}) {
  const { t } = useTranslation();
  const negated = cond.kind === "not";
  const inner = cond.kind === "not" ? cond.cond : cond;
  const wrap = (c: RuleCondition): RuleCondition =>
    negated ? { kind: "not", cond: c } : c;
  const toggleNot = () =>
    onChange(negated ? inner : { kind: "not", cond: inner });

  const notButton = (
    <button
      type="button"
      aria-pressed={negated}
      title={t("settings:splits.cond.notHint")}
      onClick={toggleNot}
      className={`h-7 shrink-0 rounded-control border px-2 text-xs font-semibold tracking-wide uppercase transition-colors ${
        negated
          ? "border-transparent bg-danger/15 text-danger"
          : "border-hairline text-ink-faint hover:bg-bg2"
      }`}
    >
      {t("settings:splits.cond.not")}
    </button>
  );

  if (isGroup(inner)) {
    return (
      <div className="flex items-start gap-1.5">
        {notButton}
        <div className="min-w-0 flex-1">
          <GroupEditor
            group={inner}
            onChange={(g) => onChange(wrap(g))}
            onRemove={onRemove}
            userLabels={userLabels}
            depth={depth + 1}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {notButton}
      <Select
        aria-label={t("settings:splits.cond.field")}
        value={inner.kind}
        onChange={(e) =>
          onChange(
            wrap(emptyLeaf(e.target.value as LeafKind, userLabels[0]?.id)),
          )
        }
      >
        {LEAF_KINDS.filter(
          (k) =>
            k !== "label" || userLabels.length > 0 || inner.kind === "label",
        ).map((k) => (
          <option key={k} value={k}>
            {t(`settings:splits.cond.fields.${k}`)}
          </option>
        ))}
      </Select>
      <LeafValue
        leaf={inner}
        onChange={(c) => onChange(wrap(c))}
        userLabels={userLabels}
      />
      <IconButton
        icon="close"
        size="xs"
        label={t("settings:splits.cond.remove")}
        onClick={onRemove}
      />
    </div>
  );
}

function LeafValue({
  leaf,
  onChange,
  userLabels,
}: {
  leaf: RuleCondition;
  onChange: (c: RuleCondition) => void;
  userLabels: Label[];
}) {
  const { t } = useTranslation();
  switch (leaf.kind) {
    case "sender":
    case "recipient":
    case "subject":
      return (
        <>
          <Select
            aria-label={t("settings:splits.cond.op")}
            value={leaf.op}
            onChange={(e) =>
              onChange({ ...leaf, op: e.target.value as TextOp })
            }
          >
            {TEXT_OPS.map((op) => (
              <option key={op} value={op}>
                {t(`settings:splits.cond.ops.${op}`)}
              </option>
            ))}
          </Select>
          <input
            className={`${inputCls} min-w-32 flex-1`}
            aria-label={t("settings:splits.cond.value")}
            value={leaf.value}
            spellCheck={false}
            placeholder={t(`settings:splits.cond.placeholders.${leaf.kind}`)}
            onChange={(e) => onChange({ ...leaf, value: e.target.value })}
          />
        </>
      );
    case "label":
      return (
        <Select
          aria-label={t("settings:splits.cond.value")}
          value={String(leaf.id)}
          onChange={(e) =>
            onChange({ kind: "label", id: Number(e.target.value) })
          }
        >
          {!userLabels.some((l) => l.id === leaf.id) && (
            <option value={String(leaf.id)}>#{leaf.id}</option>
          )}
          {userLabels.map((l) => (
            <option key={l.id} value={String(l.id)}>
              {l.name}
            </option>
          ))}
        </Select>
      );
    case "isAutomated":
    case "hasAttachment":
      return (
        <Select
          aria-label={t("settings:splits.cond.value")}
          value={leaf.value ? "yes" : "no"}
          onChange={(e) =>
            onChange({ ...leaf, value: e.target.value === "yes" })
          }
        >
          <option value="yes">{t("settings:splits.cond.yes")}</option>
          <option value="no">{t("settings:splits.cond.no")}</option>
        </Select>
      );
    default:
      return null;
  }
}

/** One-line human summary of a condition tree, for the rule list. */
export function describeCondition(
  c: RuleCondition,
  t: (key: string, opts?: Record<string, unknown>) => string,
  labels: { id: number; name: string }[],
): string {
  const leaf = (n: RuleCondition): string => {
    switch (n.kind) {
      case "all":
      case "any": {
        const parts = n.of.map(leaf);
        const joined = parts.join(
          n.kind === "all"
            ? ` ${t("settings:splits.cond.and")} `
            : ` ${t("settings:splits.cond.or")} `,
        );
        return parts.length > 1 ? `(${joined})` : joined;
      }
      case "not":
        return `${t("settings:splits.cond.not")} ${leaf(n.cond)}`;
      case "sender":
      case "recipient":
      case "subject":
        return `${t(`settings:splits.cond.fields.${n.kind}`)} ${t(`settings:splits.cond.ops.${n.op}`)} "${n.value}"`;
      case "label":
        return `${t("settings:splits.cond.fields.label")} ${labels.find((l) => l.id === n.id)?.name ?? `#${n.id}`}`;
      case "isAutomated":
      case "hasAttachment":
        return `${t(`settings:splits.cond.fields.${n.kind}`)}: ${t(n.value ? "settings:splits.cond.yes" : "settings:splits.cond.no")}`;
    }
  };
  const s = leaf(c);
  return s.startsWith("(") && s.endsWith(")")
    ? s.slice(1, -1)
    : s || t("settings:splits.describe.nothing");
}
