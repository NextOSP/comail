import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { buildCommandContext } from "../keyboard/context";
import { useUi } from "../stores/ui";
import { performPermanentDelete, performThreadAction } from "./actions";
import { queryClient } from "./client";
import { handlePermanentDeleteState, notifyPermanentDeleteQueued } from "./permanentDelete";

vi.mock("../ipc/commands", () => ({ call: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(call).mockReset();
  queryClient.clear();
  useUi.setState({ view: "trash", selection: [1, 2], openThreadId: null,
    permanentDeleteTarget: null, toasts: [], lastUndo: null, offline: false });
});
afterEach(() => { vi.useRealTimers(); queryClient.clear(); });

const mailKeys = ["threads", "thread", "bundles", "unreadCounts", "search", "accounts", "emailStats"];

describe("permanent deletion", () => {
  it("Trash command opens confirmation; cancellation makes no IPC call or undo", () => {
    buildCommandContext().act("trash");
    expect(useUi.getState().permanentDeleteTarget).toEqual([1, 2]);
    expect(useUi.getState().selection).toEqual([1, 2]);
    expect(useUi.getState().lastUndo).toBeNull();
    expect(call).not.toHaveBeenCalled();
    buildCommandContext().escape();
    expect(useUi.getState().permanentDeleteTarget).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("generic permanent-delete action also requires UI confirmation", async () => {
    await performThreadAction("delete_permanently", [3]);
    expect(useUi.getState().permanentDeleteTarget).toEqual([3]);
    expect(call).not.toHaveBeenCalled();
  });

  it("ordinary Inbox Trash still uses the reversible trash action", async () => {
    useUi.setState({ view: "inbox" });
    vi.mocked(call).mockResolvedValue({ actionIds: [9] });
    buildCommandContext().act("trash");
    expect(call).toHaveBeenCalledWith("perform_action", { args: { kind: "trash", threadIds: [1, 2], params: undefined } });
    expect(useUi.getState().permanentDeleteTarget).toBeNull();
    await Promise.resolve();
  });

  it("returns immediately after enqueue without polling, remote wait, success or undo", async () => {
    for (const key of mailKeys) queryClient.setQueryData([key], {});
    useUi.setState({ openThreadId: 1 });
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [10] });
    expect(await performPermanentDelete([1])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("perform_action", { args: { kind: "delete_permanently", threadIds: [1] } });
    for (const key of mailKeys) expect(queryClient.getQueryState([key])?.isInvalidated).toBe(true);
    expect(useUi.getState().selection).toEqual([2]);
    expect(useUi.getState().openThreadId).toBeNull();
    expect(useUi.getState().lastUndo).toBeNull();
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].message).toBe(i18n.t("common:permanentDelete.pending"));
    expect(useUi.getState().toasts[0].onAction).toBeUndefined();
  });

  it("uses reconnect wording only with observed offline evidence, then clears it on execution", async () => {
    useUi.setState({ offline: true });
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [600] });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.offline")]);
    useUi.setState({ offline: false });
    handlePermanentDeleteState({ actionId: 600, state: "inflight", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
    handlePermanentDeleteState({ actionId: 600, state: "done", error: null });
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.done")]);
  });

  it("waits for every action before showing one batch success, including duplicate events", async () => {
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [610, 611] });
    await performPermanentDelete([1, 2]);
    handlePermanentDeleteState({ actionId: 610, state: "done", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
    handlePermanentDeleteState({ actionId: 611, state: "done", error: null });
    handlePermanentDeleteState({ actionId: 611, state: "done", error: null });
    notifyPermanentDeleteQueued([611, 610]);
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.done")]);
  });

  it("never reports all-success for a partially failed batch", async () => {
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [620, 621] });
    await performPermanentDelete([1, 2]);
    handlePermanentDeleteState({ actionId: 620, state: "failed", error: "UIDPLUS required" });
    handlePermanentDeleteState({ actionId: 621, state: "done", error: null });
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].kind).toBe("error");
    expect(useUi.getState().toasts[0].message).toContain("UIDPLUS");
  });

  it("uses auth wording only after a paused event and replaces it on resumption", async () => {
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [630] });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts[0].message).toBe(i18n.t("common:permanentDelete.pending"));
    expect(useUi.getState().toasts[0].message).not.toMatch(/connect|offline|sign in/i);
    handlePermanentDeleteState({ actionId: 630, state: "paused", error: "Authentication required" });
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.paused")]);
    handlePermanentDeleteState({ actionId: 630, state: "inflight", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
    handlePermanentDeleteState({ actionId: 630, state: "failed", error: "server rejected deletion" });
    expect(useUi.getState().toasts[0].kind).toBe("error");
  });

  it("preserves an early retry notice rather than adding misleading queued feedback", async () => {
    vi.mocked(call).mockImplementationOnce(async () => {
      handlePermanentDeleteState({ actionId: 640, state: "pending", error: "timeout" });
      return { actionIds: [640] };
    });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].message).toContain("timeout");
  });

  it("coalesces duplicate confirms, including reordered IDs, while enqueue is outstanding", async () => {
    let resolve!: (value: { actionIds: number[] }) => void;
    vi.mocked(call).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const first = performPermanentDelete([2, 1]);
    const second = performPermanentDelete([1, 2, 1]);
    expect(second).toBe(first);
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ actionIds: [11, 12] });
    await first;
    expect(useUi.getState().toasts).toHaveLength(1);
  });

  it("preserves mixed Inbox/Sent threads and does not optimistically remove whole rows", async () => {
    const data = { pages: [{ threads: [{ id: 1 }], nextCursor: null }], pageParams: [null] };
    queryClient.setQueryData(["threads", "inbox"], data);
    queryClient.setQueryData(["search", "test"], { threads: [{ id: 1 }] });
    useUi.setState({ view: "inbox", openThreadId: 1 });
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [13] });
    await performPermanentDelete([1]);
    expect(queryClient.getQueryData(["threads", "inbox"])).toEqual(data);
    expect(queryClient.getQueryData(["search", "test"])).toEqual({ threads: [{ id: 1 }] });
    expect(useUi.getState().openThreadId).toBe(1);
  });

  it("surfaces enqueue rejection once, preserves selection, and allows retry", async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error("Wait for pending message actions"));
    expect(await performPermanentDelete([1])).toBe(false);
    expect(useUi.getState().toasts.filter((t) => t.kind === "error")).toHaveLength(1);
    expect(useUi.getState().selection).toEqual([1, 2]);
    expect(useUi.getState().lastUndo).toBeNull();
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [14] });
    expect(await performPermanentDelete([1])).toBe(true);
  });

  it("does not clear a new selection or close a different thread after delayed enqueue", async () => {
    let resolve!: (value: { actionIds: number[] }) => void;
    vi.mocked(call).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = performPermanentDelete([1]);
    useUi.setState({ selection: [3], openThreadId: 3 });
    resolve({ actionIds: [15] });
    await pending;
    expect(useUi.getState().selection).toEqual([3]);
    expect(useUi.getState().openThreadId).toBe(3);
  });

  it.each(["pending", "inflight", "done", "failed", "paused"] as const)("refreshes every mail cache on %s, including MCP actions", async (state) => {
    for (const key of mailKeys) queryClient.setQueryData([key], {});
    handlePermanentDeleteState({ actionId: 100 + ["pending", "inflight", "done", "failed", "paused"].indexOf(state), kind: "delete_permanently", state, error: null });
    await vi.advanceTimersByTimeAsync(0);
    for (const key of mailKeys) expect(queryClient.getQueryState([key])?.isInvalidated).toBe(true);
  });

  it("initial pending is silent; pending with an error is a visible retry, not a failure", () => {
    handlePermanentDeleteState({ actionId: 200, state: "pending", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
    handlePermanentDeleteState({ actionId: 201, state: "pending", error: "Connection reset" });
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].kind).toBe("info");
    expect(useUi.getState().toasts[0].message).toContain("Connection reset");
    handlePermanentDeleteState({ actionId: 201, state: "pending", error: "Connection reset" });
    expect(useUi.getState().toasts).toHaveLength(1);
    // Retry notice never touches cached mail, so uncertain deletions stay hidden/unchanged.
    handlePermanentDeleteState({ actionId: 201, state: "done", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("repeated terminal events produce only one toast", () => {
    handlePermanentDeleteState({ actionId: 210, state: "paused", error: "Authentication" });
    handlePermanentDeleteState({ actionId: 210, state: "paused", error: "Authentication" });
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].kind).toBe("info");
    handlePermanentDeleteState({ actionId: 210, state: "pending", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
    handlePermanentDeleteState({ actionId: 210, state: "failed", error: "UIDPLUS required" });
    handlePermanentDeleteState({ actionId: 210, state: "failed", error: "UIDPLUS required" });
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].message).toContain("UIDPLUS");
    expect(useUi.getState().toasts[0].kind).toBe("error");
  });

  it("a batch of messages sharing one outcome shows a single toast until all leave it", () => {
    for (const id of [220, 221, 222]) handlePermanentDeleteState({ actionId: id, state: "failed", error: "UIDPLUS required" });
    expect(useUi.getState().toasts).toHaveLength(1);
    handlePermanentDeleteState({ actionId: 220, state: "done", error: null });
    handlePermanentDeleteState({ actionId: 221, state: "done", error: null });
    expect(useUi.getState().toasts).toHaveLength(1);
    handlePermanentDeleteState({ actionId: 222, state: "done", error: null });
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("queued and retrying stay distinct from confirmed batch success", async () => {
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [230] });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.pending")]);
    handlePermanentDeleteState({ actionId: 230, state: "pending", error: "timeout" });
    expect(useUi.getState().toasts.some((t) => t.message.includes("timeout"))).toBe(true);
    handlePermanentDeleteState({ actionId: 230, state: "done", error: null });
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([i18n.t("common:permanentDelete.done")]);
  });

  it("coalesces a burst of action events into at most two refetch rounds", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const observer = new QueryObserver(queryClient, { queryKey: ["threads", "trash"], queryFn: fetch, staleTime: Infinity });
    const off = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockClear();
    for (let id = 500; id < 550; id++) handlePermanentDeleteState({ actionId: id, state: "done", error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    off();
  });

  it.each(["done", "failed", "paused"] as const)("does not show stale queued status when %s arrives before enqueue response", async (state) => {
    const actionId = 300 + ["done", "failed", "paused"].indexOf(state);
    vi.mocked(call).mockImplementationOnce(async () => {
      handlePermanentDeleteState({ actionId, kind: "delete_permanently", state, error: "server detail" });
      return { actionIds: [actionId] };
    });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts.some((t) => t.message === i18n.t("common:permanentDelete.pending"))).toBe(false);
    expect(useUi.getState().toasts.filter((t) => t.kind === "error")).toHaveLength(state === "failed" ? 1 : 0);
    expect(useUi.getState().toasts.filter((t) => t.message === i18n.t("common:permanentDelete.done"))).toHaveLength(state === "done" ? 1 : 0);
  });

  it("replaces queued feedback on failure and does not regress a confirmed completion", async () => {
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [350] });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts[0].message).toBe(i18n.t("common:permanentDelete.pending"));
    handlePermanentDeleteState({ actionId: 350, state: "failed", error: "UIDPLUS required" });
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0].kind).toBe("error");
    handlePermanentDeleteState({ actionId: 351, state: "done", error: null });
    handlePermanentDeleteState({ actionId: 351, state: "pending", error: null });
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [351] });
    await performPermanentDelete([1]);
    expect(useUi.getState().toasts.some((t) => t.message === i18n.t("common:permanentDelete.pending"))).toBe(false);
  });

  it("cancels an initial stale snapshot before refetching durable tombstones", async () => {
    let resolveOld!: (value: number[]) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<number[]>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue([]);
    const observer = new QueryObserver(queryClient, { queryKey: ["threads", "trash"], queryFn: fetch });
    const off = observer.subscribe(() => {});
    vi.mocked(call).mockResolvedValueOnce({ actionIds: [400] });
    await performPermanentDelete([1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data).toEqual([]);
    resolveOld([1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual([]);
    off();
  });
});
