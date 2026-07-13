import { describe, expect, it } from "vitest";
import type { SyncStatus } from "../ipc/types";
import { aggregateSyncStatuses, normalizeSyncStatus, syncStatusMap } from "./syncStatus";

const status = (overrides: Partial<SyncStatus> & Pick<SyncStatus, "accountId">): SyncStatus => ({
  state: "idle",
  foregroundPhase: "idle",
  background: null,
  ...overrides,
});

describe("sync status", () => {
  it("normalizes the legacy status response", () => {
    expect(normalizeSyncStatus({ accountId: 7, state: "syncing", progress: 0.4 })).toEqual({
      accountId: 7,
      state: "syncing",
      foregroundPhase: "inbox",
      background: null,
    });
  });

  it("uses explicit foreground idle even if account state is stale", () => {
    const aggregate = aggregateSyncStatuses(
      syncStatusMap([status({ accountId: 1, state: "syncing", foregroundPhase: "idle" })]),
      null,
    );
    expect(aggregate.foregroundSyncing).toBe(false);
  });

  it("aggregates background work across accounts", () => {
    const aggregate = aggregateSyncStatuses(
      syncStatusMap([
        status({
          accountId: 1,
          background: { phase: "content", done: 20, total: 100, failed: 1 },
        }),
        status({
          accountId: 2,
          background: { phase: "indexing", done: 15, total: 40, failed: 2 },
        }),
      ]),
      null,
    );
    expect(aggregate.background).toEqual({
      phase: "mixed",
      done: 35,
      total: 140,
      failed: 3,
    });
  });

  it("limits aggregation to the selected account", () => {
    const aggregate = aggregateSyncStatuses(
      syncStatusMap([
        status({ accountId: 1, foregroundPhase: "inbox", state: "syncing" }),
        status({ accountId: 2 }),
      ]),
      2,
    );
    expect(aggregate.foregroundSyncing).toBe(false);
  });

  it("does not label blocked accounts as up to date", () => {
    const aggregate = aggregateSyncStatuses(
      syncStatusMap([
        status({
          accountId: 1,
          state: "needs_reauth",
          background: { phase: "content", done: 20, total: 100, failed: 0 },
        }),
      ]),
      null,
    );
    expect(aggregate.background).toBeNull();
  });
});
