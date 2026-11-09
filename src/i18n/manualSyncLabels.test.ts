import { describe, expect, it } from "vitest";
import threadListSource from "../components/inbox/ThreadList.tsx?raw";
import en from "./locales/en/common.json";
import es from "./locales/es/common.json";
import fr from "./locales/fr/common.json";
import vi from "./locales/vi/common.json";
import zh from "./locales/zh/common.json";

const catalogs = { en, es, fr, vi, zh };
const placeholders = (text: string) => [...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort();

describe("selection and manual sync labels", () => {
  it("translates the bulk-bar deselect action as its own string in every locale", () => {
    expect(vi.action.deselect).toBe("Bỏ chọn");
    for (const [lng, common] of Object.entries(catalogs)) {
      expect(common.action.deselect, lng).toBeTruthy();
      expect(common.action.deselect, lng).not.toBe(common.action.clear);
    }
  });

  it.each(["syncMail", "syncMailAccount", "syncFailed", "switchAccount"] as const)(
    "%s exists in every locale with the English placeholders",
    (key) => {
      for (const [lng, common] of Object.entries(catalogs)) {
        expect(common.topbar[key], `${lng}.${key}`).toBeTruthy();
        expect(placeholders(common.topbar[key]), `${lng}.${key}`).toEqual(placeholders(en.topbar[key]));
      }
    },
  );
});

describe("bulk bar trailing action", () => {
  it("uses the deselect label and the store's clearSelection", () => {
    const bulk = threadListSource.slice(threadListSource.indexOf("function BulkBar"));
    expect(bulk).toContain('t("common:action.deselect")');
    expect(bulk).not.toContain('t("common:action.clear")');
    expect(threadListSource).toContain("onClear={clearSelection}");
  });
});
