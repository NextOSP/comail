import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasSeenIntro, markIntroSeen } from "./intro";

/** Minimal in-memory localStorage; the node test env has no browser globals. */
function installMockStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("intro flag", () => {
  beforeEach(() => installMockStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is unseen on first launch", () => {
    expect(hasSeenIntro()).toBe(false);
  });

  it("marks the intro as seen and persists across reads", () => {
    markIntroSeen();
    expect(hasSeenIntro()).toBe(true);
    expect(hasSeenIntro()).toBe(true);
  });

  it("does not throw when storage is unavailable", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(hasSeenIntro()).toBe(false);
    expect(() => markIntroSeen()).not.toThrow();
  });
});
