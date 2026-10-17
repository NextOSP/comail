import { describe, expect, it } from "vitest";
import type { RuleCondition } from "../ipc/types";
import {
  type ConditionSubject,
  conditionProblems,
  isMatchable,
  matches,
  queryToCondition,
  simplify,
} from "./ruleCondition";

const subject: ConditionSubject = {
  senders: ["noreply@github.com"],
  recipients: ["dev@acme.io"],
  subjects: ["[CI] Hóa đơn"],
  labelIds: [3],
  isAutomated: true,
  hasAttachment: false,
};

const sender = (
  value: string,
  op: "contains" | "endsWith" = "contains",
): RuleCondition => ({
  kind: "sender",
  op,
  value,
});

describe("queryToCondition", () => {
  it("keeps legacy semantics: AND of fields, OR within, exclusions veto", () => {
    expect(
      matches(queryToCondition({ senders: ["gitlab", "github"] }), subject),
    ).toBe(true);
    expect(
      matches(
        queryToCondition({ senders: ["github"], excludeSenders: ["noreply@"] }),
        subject,
      ),
    ).toBe(false);
    expect(
      matches(queryToCondition({ excludeSenders: ["nobody"] }), subject),
    ).toBe(false);
    expect(matches(queryToCondition({}), subject)).toBe(false);
    expect(
      matches(queryToCondition({ subjectContains: ["hoa don"] }), subject),
    ).toBe(true);
    expect(
      matches(queryToCondition({ labels: [9, 3], isAutomated: true }), subject),
    ).toBe(true);
  });
});

describe("condition tree", () => {
  it("supports any / not and requires a positive criterion", () => {
    const tree: RuleCondition = {
      kind: "all",
      of: [
        {
          kind: "any",
          of: [sender("@gitlab.com", "endsWith"), { kind: "label", id: 3 }],
        },
        { kind: "not", cond: { kind: "hasAttachment", value: true } },
      ],
    };
    expect(matches(tree, subject)).toBe(true);
    const onlyNot: RuleCondition = { kind: "not", cond: sender("nobody") };
    expect(isMatchable(onlyNot)).toBe(false);
    expect(matches(onlyNot, subject)).toBe(false);
  });

  it("reports problems and simplifies empty groups away", () => {
    const bad: RuleCondition = {
      kind: "all",
      of: [sender(" "), { kind: "any", of: [] }],
    };
    expect(conditionProblems(bad)).toEqual(
      expect.arrayContaining(["emptyValue", "emptyGroup"]),
    );
    expect(simplify(bad)).toEqual({ kind: "all", of: [sender(" ")] });
    expect(conditionProblems(sender("x"))).toEqual([]);
  });
});
