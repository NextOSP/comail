import { describe, expect, it } from "vitest";
import { fileKind } from "./fileKind";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centered,
  clampPan,
  columnName,
  currentPageIndex,
  fitScale,
  stepZoom,
  zoomAt,
} from "./viewer";

describe("stepZoom", () => {
  it("moves to the neighbouring stop", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
  });
  it("snaps an off-stop value to the next stop in that direction", () => {
    expect(stepZoom(0.8, 1)).toBe(0.9);
    expect(stepZoom(0.8, -1)).toBe(0.75);
  });
  it("clamps at the ends", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("fitScale", () => {
  it("never upscales", () => expect(fitScale(100, 100, 1000, 1000)).toBe(1));
  it("fits the tighter axis", () => expect(fitScale(2000, 1000, 1000, 1000)).toBe(0.5));
});

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed", () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    // content point (100, 50) was at screen (100, 50); still is.
    expect(100 * v.scale + v.x).toBe(100);
    expect(50 * v.scale + v.y).toBe(50);
  });
});

describe("clampPan", () => {
  it("centers content smaller than the box", () => {
    expect(clampPan({ scale: 1, x: 999, y: -999 }, 100, 50, 300, 150)).toEqual({ scale: 1, x: 100, y: 50 });
  });
  it("prevents gutters when content is larger", () => {
    expect(clampPan({ scale: 2, x: 50, y: -1000 }, 100, 100, 100, 100)).toEqual({ scale: 2, x: 0, y: -100 });
  });
  it("centered() lands in the middle", () => {
    expect(centered(0.5, 200, 200, 300, 300)).toEqual({ scale: 0.5, x: 100, y: 100 });
  });
});

describe("columnName", () => {
  it("handles single and double letters", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(27)).toBe("AB");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
  });
});

describe("currentPageIndex", () => {
  const tops = [0, 1000, 2000, 3000];
  it("is the first page at the top", () => expect(currentPageIndex(tops, 0, 800)).toBe(0));
  it("switches once a page crosses the reading line", () => {
    expect(currentPageIndex(tops, 600, 800)).toBe(0);
    expect(currentPageIndex(tops, 700, 800)).toBe(1);
    expect(currentPageIndex(tops, 5000, 800)).toBe(3);
  });
});

describe("fileKind", () => {
  it("detects by extension", () => {
    expect(fileKind("deck.pptx", null).family).toBe("slides");
    expect(fileKind("data.csv", null)).toMatchObject({ family: "csv", label: "CSV" });
    expect(fileKind("photo.JPG", null).family).toBe("image");
  });
  it("falls back to mime", () => {
    expect(fileKind("download", "application/pdf").family).toBe("pdf");
    expect(fileKind(null, "image/png").family).toBe("image");
  });
  it("uses the extension as label for unknown types", () => {
    expect(fileKind("thing.sketch", null)).toMatchObject({ family: "other", label: "SKET" });
    expect(fileKind("README", null)).toMatchObject({ family: "other", label: "FILE", ext: "" });
  });
});
