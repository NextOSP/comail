import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";

const call = vi.fn();
vi.mock("../ipc/commands", () => ({ call: (...args: unknown[]) => call(...args) }));

const { isManualSyncBusy, syncNowAndRefresh } = await import("./syncNow");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  call.mockReset();
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isManualSyncBusy", () => {
  it("scopes account passes and lets an all-accounts pass cover everything", () => {
    expect(isManualSyncBusy(1, [])).toBe(false);
    expect(isManualSyncBusy(1, [1])).toBe(true);
    expect(isManualSyncBusy(2, [1])).toBe(false);
    expect(isManualSyncBusy(null, [1])).toBe(true);
    expect(isManualSyncBusy(2, [null])).toBe(true);
  });
});

describe("syncNowAndRefresh", () => {
  it("awaits the foreground pass before invalidating caches and replacing statuses", async () => {
    const pass = deferred();
    const order: string[] = [];
    call.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === "sync_now") await pass.promise;
      if (cmd === "get_sync_status") {
        return [{ accountId: 5, state: "idle", foregroundPhase: "idle", background: null }];
      }
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (filter) => {
      order.push(`invalidate:${String((filter as { queryKey: string[] }).queryKey[0])}`);
    });

    const run = syncNowAndRefresh(5);
    await Promise.resolve();
    expect(call).toHaveBeenCalledWith("sync_now", { accountId: 5 });
    expect(invalidate).not.toHaveBeenCalled();
    expect(useUi.getState().syncStatuses).toEqual({});

    pass.resolve();
    await run;
    expect(order[0]).toBe("sync_now");
    expect(order.filter((step) => step.startsWith("invalidate:")).sort()).toEqual([
      "invalidate:accounts",
      "invalidate:threads",
      "invalidate:unreadCounts",
    ]);
    expect(order).toContain("get_sync_status");
    expect(useUi.getState().syncStatuses[5]).toMatchObject({ accountId: 5, foregroundPhase: "idle" });
  });

  it("passes null for the all-accounts scope", async () => {
    call.mockResolvedValue([]);
    await syncNowAndRefresh(null);
    expect(call).toHaveBeenCalledWith("sync_now", { accountId: null });
  });

  it("joins the same scope but does not drop an all-accounts request", async () => {
    const pass = deferred();
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") await pass.promise;
      return [];
    });
    const first = syncNowAndRefresh(7);
    const repeat = syncNowAndRefresh(7);
    const all = syncNowAndRefresh(null);
    expect(repeat).toBe(first);
    expect(all).not.toBe(first);
    expect(call).toHaveBeenCalledWith("sync_now", { accountId: null });
    expect(call.mock.calls.filter(([cmd]) => cmd === "sync_now")).toHaveLength(2);
    expect(syncNowAndRefresh(8)).toBe(all);
    expect(isManualSyncBusy(7)).toBe(true);
    expect(isManualSyncBusy(8)).toBe(true);
    pass.resolve();
    await Promise.all([first, repeat, all]);
    expect(isManualSyncBusy(7)).toBe(false);

    await syncNowAndRefresh(7);
    expect(call.mock.calls.filter(([cmd]) => cmd === "sync_now")).toHaveLength(3);
  });

  it("rejects with the backend error, skips the refresh for one account and clears the busy state", async () => {
    call.mockRejectedValue(new Error("imap down"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await expect(syncNowAndRefresh(3)).rejects.toThrow("imap down");
    expect(invalidate).not.toHaveBeenCalled();
    expect(isManualSyncBusy(3)).toBe(false);
  });

  it("still refreshes after a failed all-accounts pass and keeps the original error", async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") throw new Error("account 2 offline");
      return [{ accountId: 1, state: "idle", foregroundPhase: "idle", background: null }];
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    await expect(syncNowAndRefresh(null)).rejects.toThrow("account 2 offline");
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(useUi.getState().syncStatuses[1]).toMatchObject({ accountId: 1 });
    expect(isManualSyncBusy(null)).toBe(false);
  });

  it("keeps the backend error when the post-failure refresh itself fails", async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") throw new Error("account 2 offline");
      throw new Error("status unavailable");
    });
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    await expect(syncNowAndRefresh(null)).rejects.toThrow("account 2 offline");
  });

  it("loads the status snapshot while cache refetches are still running", async () => {
    const refetch = deferred();
    call.mockImplementation(async (cmd: string) => (cmd === "get_sync_status"
      ? [{ accountId: 5, state: "idle", foregroundPhase: "idle", background: null }]
      : undefined));
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => refetch.promise);
    const run = syncNowAndRefresh(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).toHaveBeenCalledWith("get_sync_status", {});
    expect(isManualSyncBusy(null)).toBe(true);
    const snapshot = useUi.getState().syncStatuses[5];
    expect(snapshot.foregroundPhase).toBe("idle");
    useUi.getState().upsertSyncStatus({ ...snapshot, state: "syncing" });
    refetch.resolve();
    await run;
    expect(isManualSyncBusy(null)).toBe(false);
    expect(useUi.getState().syncStatuses[5].state).toBe("syncing");
  });
});
