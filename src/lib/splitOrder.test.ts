import { describe, expect, it } from "vitest";
import type { Label, SplitRule } from "../ipc/types";
import { inboxTabOrder } from "./splitOrder";

function split(id: number, name: string, position: number): SplitRule {
  return { id, name, position, query: {} };
}

function autoLabel(id: number, name: string, position: number): Label {
  return {
    id,
    name,
    position,
    color: "#000000",
    keyword: `ComailAuto${name}`,
    isAuto: true,
  };
}

describe("inboxTabOrder", () => {
  it("uses the arranged interleaved order between fixed endpoints", () => {
    const tabs = inboxTabOrder(
      [split(1, "Ads", 0), split(2, "Xcode", 2)],
      [autoLabel(101, "News", 1), autoLabel(102, "Social", 3)],
      true,
    );

    expect(tabs.map((tab) => tab.kind)).toEqual([
      "important",
      "split",
      "label",
      "split",
      "label",
      "other",
    ]);
    expect(tabs.map((tab) => "name" in tab ? tab.name : tab.kind)).toEqual([
      "important",
      "Ads",
      "News",
      "Xcode",
      "Social",
      "other",
    ]);
  });

  it("keeps the legacy grouped order while positions still collide", () => {
    const tabs = inboxTabOrder(
      [split(1, "Ads", 0)],
      [autoLabel(101, "News", 0)],
      true,
    );
    expect(tabs.map((tab) => "name" in tab ? tab.name : tab.kind)).toEqual([
      "important",
      "Ads",
      "News",
      "other",
    ]);
  });

  it("omits auto labels when the feature is disabled", () => {
    const tabs = inboxTabOrder(
      [split(1, "Ads", 0)],
      [autoLabel(101, "News", 1)],
      false,
    );
    expect(tabs.map((tab) => "name" in tab ? tab.name : tab.kind)).toEqual([
      "important",
      "Ads",
      "other",
    ]);
  });
});
