import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import en from "./locales/en/common.json";
import es from "./locales/es/common.json";
import fr from "./locales/fr/common.json";
import vi from "./locales/vi/common.json";
import zh from "./locales/zh/common.json";

const catalogs = { en, es, fr, vi, zh };

describe("permanent-delete confirmation pluralization", () => {
  for (const [lng, common] of Object.entries(catalogs)) {
    it(`distinguishes progress, offline, auth pause and confirmed success in ${lng}`, async () => {
      const instance = createInstance();
      await instance.init({ lng, fallbackLng: false, resources: { [lng]: { common } }, defaultNS: "common" });
      const messages = ["pending", "offline", "paused", "done"].map((key) => instance.t(`permanentDelete.${key}`));
      expect(new Set(messages).size).toBe(4);
      for (const message of messages) {
        expect(message).not.toMatch(/^permanentDelete\./);
        expect(message.trim().length).toBeGreaterThan(0);
      }
      expect(instance.t("permanentDelete.pending")).toBe(common.permanentDelete.pending);
      expect(instance.t("permanentDelete.offline")).toBe(common.permanentDelete.offline);
      expect(instance.t("permanentDelete.done")).toBe(common.permanentDelete.done);
    });

    it(`resolves localized singular and plural counts in ${lng}`, async () => {
      const instance = createInstance();
      await instance.init({ lng, fallbackLng: false, resources: { [lng]: { common } }, defaultNS: "common" });
      for (const count of [1, 2]) {
        const expected = count === 1 && !["vi", "zh"].includes(lng)
          ? common.permanentDelete.confirm_one
          : common.permanentDelete.confirm_other;
        expect(instance.t("permanentDelete.confirm", { count })).toBe(expected.replace("{{count}}", String(count)));
        expect(instance.t("permanentDelete.confirm", { count })).not.toContain("(s)");
        expect(instance.t("permanentDelete.confirm", { count })).not.toContain("(es)");
      }
    });
  }
});
