import { create } from "zustand";

/**
 * Per-tab unread count as of the last time the user looked at that tab, keyed
 * by account scope ("all" or the account id) then tab key. A tab whose current
 * unread count is above its seen count has mail that arrived since, which the
 * tab bar marks with a "new" dot. Persisted in localStorage so mail that
 * arrived in a background tab is still flagged after a relaunch.
 */
type SeenMap = Record<string, Record<string, number>>;

const STORAGE_KEY = "comail:tabSeen";

function loadSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* storage unavailable or full - the dots just reset next launch */
  }
}

/**
 * Fold the latest counts into one scope's seen map. The active tab is always
 * caught up; other tabs only move down (mail read or moved elsewhere), so a
 * later arrival still registers. Tabs seen for the first time take their
 * current count, so the initial load never lights every tab up.
 */
export function reconcileSeen(
  seen: Record<string, number> | undefined,
  counts: Record<string, number>,
  activeKey: string,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    const prev = seen?.[key];
    next[key] = key === activeKey || prev == null ? count : Math.min(prev, count);
  }
  return next;
}

/** Whether a tab gained unread mail since the user last viewed it. */
export function hasNewMail(
  seen: Record<string, number> | undefined,
  key: string,
  count: number,
): boolean {
  const prev = seen?.[key];
  return prev != null && count > prev;
}

export const useTabSeen = create<{
  seen: SeenMap;
  reconcile: (scope: string, counts: Record<string, number>, activeKey: string) => void;
}>((set) => ({
  seen: loadSeen(),
  reconcile: (scope, counts, activeKey) =>
    set((s) => {
      const prev = s.seen[scope];
      const next = reconcileSeen(prev, counts, activeKey);
      // Skip the store update (and re-render) when nothing moved.
      const unchanged =
        prev != null &&
        Object.keys(next).length === Object.keys(prev).length &&
        Object.entries(next).every(([k, v]) => prev[k] === v);
      if (unchanged) return s;
      const seen = { ...s.seen, [scope]: next };
      saveSeen(seen);
      return { seen };
    }),
}));
