import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en/settings.json";
import es from "../i18n/locales/es/settings.json";
import fr from "../i18n/locales/fr/settings.json";
import vi from "../i18n/locales/vi/settings.json";
import zh from "../i18n/locales/zh/settings.json";
import type { AiAutomationAction, AiAutomationRule } from "../ipc/types";
import { automationRisk, automationRiskMessage } from "./automationRisk";

const rule = (actions: AiAutomationAction["kind"][], extra: Partial<AiAutomationRule> = {}): AiAutomationRule => ({
  id: actions.join("-"),
  name: "r",
  sourcePrompt: "",
  instruction: "",
  enabled: true,
  actions: actions.map((kind) => ({ kind, value: "" })),
  condition: { kind: "sender", op: "contains", value: "github.com" },
  ...extra,
});

describe("Run automations confirmation", () => {
  it("runs filing-only rules without asking", () => {
    expect(automationRisk([])).toBeNull();
    expect(automationRisk([rule(["route_to"]), rule(["add_label", "remove_label"])])).toBeNull();
  });

  it("asks for actions that change mail and for AI checks", () => {
    expect(automationRisk([rule(["route_to", "archive"]), rule(["trash", "archive"])])).toEqual({
      actions: ["archive", "trash"],
      ai: false,
    });
    expect(automationRisk([rule(["mark_read"])])?.actions).toEqual(["mark_read"]);
    expect(automationRisk([rule(["route_to"], { instruction: "It is a notification" })])).toEqual({
      actions: [],
      ai: true,
    });
  });

  it("ignores rules the core would not run", () => {
    const off = [
      rule(["trash"], { enabled: false }),
      rule(["trash"], { condition: null }),
      rule([], { instruction: "anything" }),
    ];
    expect(automationRisk(off)).toBeNull();
  });

  for (const [lng, settings] of Object.entries({ en, es, fr, vi, zh })) {
    it(`states the count, the actions and the AI cost in ${lng}`, async () => {
      const i18n = createInstance();
      await i18n.init({ lng, fallbackLng: false, resources: { [lng]: { settings } }, defaultNS: "settings" });
      const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);
      const ai = settings.ai;
      const message = automationRiskMessage({ actions: ["archive", "trash"], ai: true }, 42, t);
      expect(message).toContain(ai.resortConfirm_other.replace("{{count}}", "42"));
      expect(message).toContain(ai.actions.archive);
      expect(message).toContain(ai.actions.trash);
      expect(message).toContain(ai.resortConfirmAi);
      expect(message).not.toMatch(/settings:|\{\{/);

      const one = automationRiskMessage({ actions: [], ai: true }, 1, t);
      const singular = ["vi", "zh"].includes(lng) ? ai.resortConfirm_other : ai.resortConfirm_one;
      expect(one).toBe(`${singular.replace("{{count}}", "1")} ${ai.resortConfirmAi}`);
      expect(automationRiskMessage({ actions: ["star"], ai: false }, undefined, t)).toContain(
        ai.resortConfirmEvery,
      );
      expect(ai.resortConfirmRun.trim()).not.toBe("");
    });
  }
});
