import type { RuleCondition, SplitRuleQuery, TextOp } from "../ipc/types";

/** Mirrors Rust `RULE_MAX_DEPTH` / `RULE_MAX_NODES`. */
export const RULE_MAX_DEPTH = 8;
export const RULE_MAX_NODES = 64;

export type LeafKind = Exclude<RuleCondition["kind"], "all" | "any" | "not">;

export function isGroup(
  c: RuleCondition,
): c is Extract<RuleCondition, { kind: "all" | "any" }> {
  return c.kind === "all" || c.kind === "any";
}

/** A fresh leaf of the given kind with neutral defaults. */
export function emptyLeaf(
  kind: LeafKind,
  firstLabelId?: number,
): RuleCondition {
  switch (kind) {
    case "sender":
    case "recipient":
    case "subject":
      return {
        kind,
        op: kind === "subject" ? "contains" : "endsWith",
        value: "",
      };
    case "label":
      return { kind, id: firstLabelId ?? 0 };
    case "isAutomated":
    case "hasAttachment":
      return { kind, value: true };
  }
}

/** The legacy flat query as a tree, same semantics as Rust
 *  `From<&SplitRuleQuery> for RuleCondition`. */
export function queryToCondition(q: SplitRuleQuery): RuleCondition {
  const texts = (
    vals: string[] | undefined,
    kind: "sender" | "recipient" | "subject",
  ) => {
    const of: RuleCondition[] = (vals ?? [])
      .filter((v) => v.trim() !== "")
      .map((value) => ({ kind, op: "contains" as TextOp, value }));
    return of.length > 0 ? ({ kind: "any", of } as RuleCondition) : null;
  };
  const all: RuleCondition[] = [];
  const excl = texts(q.excludeSenders, "sender");
  if (excl) all.push({ kind: "not", cond: excl });
  if (q.isAutomated != null)
    all.push({ kind: "isAutomated", value: q.isAutomated });
  for (const c of [
    texts(q.senders, "sender"),
    texts(q.recipients, "recipient"),
    texts(q.subjectContains, "subject"),
  ])
    if (c) all.push(c);
  const labels = (q.labels ?? []).filter((id) => id > 0);
  if (labels.length > 0)
    all.push({ kind: "any", of: labels.map((id) => ({ kind: "label", id })) });
  if (q.hasAttachment != null)
    all.push({ kind: "hasAttachment", value: q.hasAttachment });
  return { kind: "all", of: all };
}

/** True when some leaf sits under an even number of `not`s. */
export function isMatchable(c: RuleCondition, negated = false): boolean {
  if (isGroup(c)) return c.of.some((x) => isMatchable(x, negated));
  if (c.kind === "not") return isMatchable(c.cond, !negated);
  return !negated;
}

export type ConditionProblem =
  "tooDeep" | "tooLarge" | "emptyValue" | "emptyGroup" | "notMatchable";

/** Client-side mirror of Rust `RuleCondition::validate` (labels are checked server-side). */
export function conditionProblems(c: RuleCondition): ConditionProblem[] {
  const out = new Set<ConditionProblem>();
  const walk = (n: RuleCondition, depth: number): number => {
    if (depth > RULE_MAX_DEPTH) out.add("tooDeep");
    if (isGroup(n)) {
      if (n.of.length === 0) out.add("emptyGroup");
      return 1 + n.of.reduce((sum, x) => sum + walk(x, depth + 1), 0);
    }
    if (n.kind === "not") return 1 + walk(n.cond, depth + 1);
    if (
      (n.kind === "sender" || n.kind === "recipient" || n.kind === "subject") &&
      !n.value.trim()
    )
      out.add("emptyValue");
    return 1;
  };
  if (walk(c, 1) > RULE_MAX_NODES) out.add("tooLarge");
  if (!isMatchable(c)) out.add("notMatchable");
  return [...out];
}

/** Drop empty groups and single-child wrappers so a saved tree stays tidy. */
export function simplify(c: RuleCondition): RuleCondition {
  if (isGroup(c)) {
    const of = c.of
      .map(simplify)
      .filter((x) => !(isGroup(x) && x.of.length === 0));
    return { kind: c.kind, of };
  }
  if (c.kind === "not") return { kind: "not", cond: simplify(c.cond) };
  return c;
}

/** Facts a condition can test; enough for the browser mock and unit tests. */
export interface ConditionSubject {
  senders: string[];
  recipients: string[];
  subjects: string[];
  labelIds: number[];
  isAutomated: boolean | null;
  hasAttachment: boolean;
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();

function textMatches(op: TextOp, hay: string, needle: string): boolean {
  switch (op) {
    case "contains":
      return hay.includes(needle);
    case "equals":
      return hay === needle;
    case "startsWith":
      return hay.startsWith(needle);
    case "endsWith":
      return hay.endsWith(needle);
  }
}

export function evaluate(c: RuleCondition, s: ConditionSubject): boolean {
  switch (c.kind) {
    case "all":
      return c.of.every((x) => evaluate(x, s));
    case "any":
      return c.of.some((x) => evaluate(x, s));
    case "not":
      return !evaluate(c.cond, s);
    case "sender":
    case "recipient": {
      const v = c.value.trim().toLowerCase();
      const hays = c.kind === "sender" ? s.senders : s.recipients;
      return (
        v !== "" && hays.some((h) => textMatches(c.op, h.toLowerCase(), v))
      );
    }
    case "subject": {
      const v = fold(c.value.trim());
      return v !== "" && s.subjects.some((h) => textMatches(c.op, fold(h), v));
    }
    case "label":
      return s.labelIds.includes(c.id);
    case "isAutomated":
      return s.isAutomated === c.value;
    case "hasAttachment":
      return s.hasAttachment === c.value;
  }
}

export function matches(c: RuleCondition, s: ConditionSubject): boolean {
  return isMatchable(c) && evaluate(c, s);
}
