import { describe, expect, it } from "vitest";
import { heatmapLevel } from "./heatmap";

describe("heatmapLevel", () => {
  it("keeps zero and invalid values unfilled", () => {
    expect(heatmapLevel(0, [0, 1, 2])).toBe(0);
    expect(heatmapLevel(Number.NaN, [1, 2])).toBe(0);
  });

  it("uses log scaling so ordinary days remain distinguishable", () => {
    const days = [1, 2, 4, 8, 16, 32];
    expect(heatmapLevel(1, days)).toBeLessThan(heatmapLevel(4, days));
    expect(heatmapLevel(4, days)).toBeLessThan(heatmapLevel(16, days));
  });

  it("caps exceptional outliers instead of flattening the rest of the year", () => {
    const days = [...Array.from({ length: 99 }, (_, index) => index + 1), 10_000];
    expect(heatmapLevel(25, days)).toBeGreaterThan(1);
    expect(heatmapLevel(100, days)).toBe(4);
    expect(heatmapLevel(10_000, days)).toBe(4);
  });
});
