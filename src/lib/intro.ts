/**
 * First-run intro tracking.
 *
 * The "into space" onboarding flythrough plays exactly once - on the very first
 * launch. We persist a flag the same way the rest of the app does (a plain
 * localStorage key, cf. `comail:theme`, `comail:fpsMeter`) rather than in the
 * Zustand store, which isn't persisted. Every access is guarded so these work in
 * the node test environment (and any headless context) where the browser globals
 * are absent.
 */

const STORAGE_KEY = "comail:introSeen";

export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore - not fatal if we replay the intro once */
  }
}

/** Honors the OS "reduce motion" setting, matching the global CSS guard. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
