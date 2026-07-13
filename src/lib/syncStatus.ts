import type {
  SyncBackgroundProgress,
  SyncBackgroundPhase,
  SyncState,
  SyncStatus,
} from "../ipc/types";

const SYNC_STATES = new Set<SyncState>([
  "idle",
  "syncing",
  "error",
  "needs_reauth",
  "offline",
]);

const BACKGROUND_PHASES = new Set<SyncBackgroundPhase>([
  "headers",
  "content",
  "indexing",
  "retrying",
]);

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Normalize the IPC response at the frontend boundary. Older backends only
 * returned `{ accountId, state, progress }`; treating their syncing state as
 * an Inbox pass keeps mixed-version development builds functional.
 */
export function normalizeSyncStatus(value: unknown): SyncStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.accountId !== "number" || !Number.isFinite(raw.accountId)) return null;

  const state = SYNC_STATES.has(raw.state as SyncState) ? (raw.state as SyncState) : "idle";
  const foregroundPhase =
    raw.foregroundPhase === "inbox" || raw.foregroundPhase === "idle"
      ? raw.foregroundPhase
      : state === "syncing"
        ? "inbox"
        : "idle";

  let background: SyncBackgroundProgress | null = null;
  if (raw.background && typeof raw.background === "object") {
    const candidate = raw.background as Record<string, unknown>;
    if (BACKGROUND_PHASES.has(candidate.phase as SyncBackgroundPhase)) {
      background = {
        phase: candidate.phase as SyncBackgroundPhase,
        done: finiteCount(candidate.done),
        total: finiteCount(candidate.total),
        failed: finiteCount(candidate.failed),
      };
    }
  }

  return {
    accountId: raw.accountId,
    state,
    foregroundPhase,
    background,
  };
}

export function syncStatusMap(statuses: readonly SyncStatus[]): Record<number, SyncStatus> {
  return Object.fromEntries(statuses.map((status) => [status.accountId, status]));
}

export type AggregateBackgroundPhase = SyncBackgroundPhase | "mixed";

export interface AggregateSyncStatus {
  foregroundSyncing: boolean;
  background: (Omit<SyncBackgroundProgress, "phase"> & { phase: AggregateBackgroundPhase }) | null;
}

/** Aggregate either all accounts or the account selected in the top bar. */
export function aggregateSyncStatuses(
  statuses: Record<number, SyncStatus>,
  accountId: number | null,
): AggregateSyncStatus {
  const selected = Object.values(statuses).filter(
    (status) => accountId == null || status.accountId === accountId,
  );
  const activeBackground = selected
    // A blocked account is not "up to date" even if it still has persisted
    // background counters. Its error/offline UI takes precedence.
    .filter((status) => status.state === "idle")
    .map((status) => status.background)
    .filter((background): background is SyncBackgroundProgress => background != null);
  const phases = new Set(activeBackground.map((background) => background.phase));

  return {
    // foregroundPhase is the authoritative spinner signal. An explicit idle
    // therefore clears a stale account `state` immediately.
    foregroundSyncing: selected.some((status) => status.foregroundPhase === "inbox"),
    background:
      activeBackground.length === 0
        ? null
        : {
            phase: phases.size === 1 ? activeBackground[0].phase : "mixed",
            done: activeBackground.reduce((sum, progress) => sum + progress.done, 0),
            total: activeBackground.reduce((sum, progress) => sum + progress.total, 0),
            failed: activeBackground.reduce((sum, progress) => sum + progress.failed, 0),
          },
  };
}
