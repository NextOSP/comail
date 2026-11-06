import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "./mock";
import { emitMockEvent, subscribeMockEvent } from "./mockEvents";
import type { ActionResult, ActionStateEvent, ThreadPage } from "./types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function invoke<T>(command: Parameters<typeof mockInvoke>[0], args: Record<string, unknown>): Promise<T> {
  const result = mockInvoke(command, args);
  await vi.advanceTimersByTimeAsync(75);
  return result as Promise<T>;
}

describe("mock permanent deletion", () => {
  it("enqueues message-level actions, hides Trash immediately, deduplicates and emits completion separately", async () => {
    const events: ActionStateEvent[] = [];
    const off = subscribeMockEvent("action:state", (event) => events.push(event));
    const page = await invoke<ThreadPage>("list_threads", { view: "inbox", limit: 100 });
    const target = page.threads[0];
    expect(target).toBeDefined();
    await invoke<ActionResult>("perform_action", { args: { kind: "trash", threadIds: [target.id] } });
    const result = await invoke<ActionResult>("perform_action", { args: { kind: "delete_permanently", threadIds: [target.id] } });
    expect(result.actionIds).toHaveLength(target.messageCount);
    expect(events.filter((event) => event.state === "pending")).toHaveLength(result.actionIds.length);
    expect(events.some((event) => event.state === "done")).toBe(false);
    const duplicate = await invoke<ActionResult>("perform_action", { args: { kind: "delete_permanently", threadIds: [target.id, target.id] } });
    expect(duplicate).toEqual(result);
    const remaining = await invoke<ThreadPage>("list_threads", { view: "trash", limit: 100 });
    expect(remaining.threads.some((thread) => thread.id === target.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(events.filter((event) => event.state === "inflight")).toHaveLength(result.actionIds.length);
    expect(events.filter((event) => event.state === "done")).toHaveLength(result.actionIds.length);
    expect(events.every((event) => event.kind === "delete_permanently")).toBe(true);
    off();
  });

  it("rejects non-Trash deletion without mutating Inbox", async () => {
    const page = await invoke<ThreadPage>("list_threads", { view: "inbox", limit: 100 });
    const target = page.threads[0];
    await expect(mockInvoke("perform_action", { args: { kind: "delete_permanently", threadIds: [target.id] } })).rejects.toThrow("Trash");
    const remaining = await invoke<ThreadPage>("list_threads", { view: "inbox", limit: 100 });
    expect(remaining.threads.some((thread) => thread.id === target.id)).toBe(true);
  });

  it("unsubscribes mock events", () => {
    const listener = vi.fn();
    const off = subscribeMockEvent("action:state", listener);
    off();
    emitMockEvent("action:state", { actionId: 1, kind: "delete_permanently", state: "done", error: null });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("MCP permanent-delete permission default", () => {
  it("is off by default, independent of the general actions permission", async () => {
    const s = await invoke<{ mcpAllowActions: boolean; mcpAllowPermanentDelete: boolean }>("get_settings", {});
    expect(s.mcpAllowPermanentDelete).toBe(false);
    expect(s.mcpAllowActions).toBe(false);
  });
});
