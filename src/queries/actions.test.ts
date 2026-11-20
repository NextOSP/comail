import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "../ipc/commands";
import type { SearchResults, ThreadSummary } from "../ipc/types";
import { buildCommandContext } from "../keyboard/context";
import { useUi } from "../stores/ui";
import { applyOptimistic, findCachedSummary, performThreadAction } from "./actions";
import { queryClient } from "./client";

vi.mock("../ipc/commands", () => ({ call: vi.fn() }));

function thread(id: number, unreadCount = 1): ThreadSummary {
  return {
    id,
    accountId: 1,
    accountEmail: "me@example.com",
    subject: `Thread ${id}`,
    snippet: "",
    participants: [],
    lastMessageAt: 0,
    messageCount: unreadCount || 1,
    unreadCount,
    isStarred: false,
    hasAttachments: false,
    snoozedUntil: null,
    labels: [],
  };
}

function results(threads: ThreadSummary[]): SearchResults {
  return {
    threads,
    hits: threads.map((t) => ({ threadId: t.id, tier: 1, reason: "filter" })),
    explain: {
      chips: [{ kind: "is", value: "unread", start: 0, end: 9 }],
      warnings: [],
      terms: [],
      afterMs: null,
      beforeMs: null,
      sort: "newest",
    },
  };
}

const searchKey = ["search", "is:unread", null] as const;

beforeEach(() => {
  queryClient.clear();
  vi.mocked(call).mockReset();
  vi.mocked(call).mockResolvedValue({ actionIds: [1, 2] });
  useUi.setState({ selection: [], openThreadId: null, toasts: [], lastUndo: null });
});

afterEach(() => queryClient.clear());

describe("trash destination caches", () => {
  it.each(["spam", "move"] as const)("waits for authoritative membership for %s", async (kind) => {
    const data = { pages: [{ threads: [thread(1)], nextCursor: null }], pageParams: [null] };
    const keys = [
      ["threads", "all", null, 1, null, null],
      ["threads", "trash", null, 1, null, null],
      ["threads", "spam", null, 1, null, null],
      ["threads", "all", null, 1, null, 42],
    ];
    for (const key of keys) queryClient.setQueryData(key, data);
    queryClient.setQueryData(searchKey, results([thread(1)]));
    applyOptimistic(kind, [1]);
    for (const key of keys) expect(queryClient.getQueryData(key)).toEqual(data);
    expect(queryClient.getQueryData<SearchResults>(searchKey)!.threads).toHaveLength(1);
    await performThreadAction(kind, [1], { targetFolderId: 42 });
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("removes from normal lists but preserves existing Trash rows", () => {
    const data = { pages: [{ threads: [thread(1), thread(2)], nextCursor: null }], pageParams: [null] };
    for (const view of ["all", "starred", "trash", "spam"]) {
      queryClient.setQueryData(["threads", view], data);
    }
    applyOptimistic("trash", [1]);
    for (const view of ["all", "starred", "spam"]) {
      expect(queryClient.getQueryData<typeof data>(["threads", view])!.pages[0].threads.map(t => t.id)).toEqual([2]);
    }
    expect(queryClient.getQueryData(["threads", "trash"])).toEqual(data);
  });

  it("reconciles destination lists even without a native event", async () => {
    queryClient.setQueryData(["threads", "trash"], { pages: [], pageParams: [] });
    await performThreadAction("trash", [1]);
    expect(queryClient.getQueryState(["threads", "trash"])?.isInvalidated).toBe(true);
  });
});

describe("category labels are inbox tabs (#103)", () => {
  type Page = { pages: { threads: ThreadSummary[]; nextCursor: null }[]; pageParams: null[] };
  const page = (...threads: ThreadSummary[]): Page => ({
    pages: [{ threads, nextCursor: null }],
    pageParams: [null],
  });
  const inbox = (splitId: number | null, labelId: number | null = null) =>
    ["threads", "inbox", splitId, null, labelId, null] as const;
  const important = inbox(-1);
  const newsletters = inbox(null, 5);
  const whole = inbox(null);
  const work = ["threads", "all", null, null, 7, null] as const;
  const rows = (key: readonly unknown[]) =>
    queryClient.getQueryData<Page>(key)!.pages[0].threads.map((t) => [t.id, t.labels]);

  beforeEach(() => {
    queryClient.setQueryData(["labels"], [
      { id: 5, name: "Newsletters", color: "#888", keyword: "k5", position: 0, isAuto: true },
      { id: 6, name: "Invites", color: "#888", keyword: "k6", position: 1, isAuto: true },
      { id: 7, name: "Work", color: "#888", keyword: "Work", position: 2, isAuto: false },
    ]);
    const filed = { ...thread(1), labels: [6, 7] };
    queryClient.setQueryData(important, page(filed, thread(2)));
    queryClient.setQueryData(newsletters, page(thread(3)));
    queryClient.setQueryData(whole, page(filed, thread(2), thread(3)));
    queryClient.setQueryData(work, page(filed));
  });

  it("files the conversation under the category's tab right away", async () => {
    await performThreadAction("add_label", [1], { labelId: 5 });
    expect(rows(important)).toEqual([[2, []]]);
    // The whole inbox and plain-label views keep it, with one category chip.
    expect(rows(whole)[0]).toEqual([1, [7, 5]]);
    expect(rows(work)).toEqual([[1, [7, 5]]]);
    // The destination tab comes from the backend.
    expect(queryClient.getQueryState(newsletters)?.isInvalidated).toBe(true);
  });

  it("takes it out of that tab when the label comes off", () => {
    applyOptimistic("remove_label", [3], { labelId: 5 });
    expect(rows(newsletters)).toEqual([]);
    expect(rows(whole).map(([id]) => id)).toEqual([1, 2, 3]);
  });

  it("leaves plain labels, and categories with tabs off, as tags", () => {
    applyOptimistic("add_label", [2], { labelId: 7 });
    queryClient.setQueryData(["settings"], { autoLabelsEnabled: false });
    applyOptimistic("add_label", [2], { labelId: 5 });
    expect(rows(important)).toEqual([
      [1, [6, 7]],
      [2, [7, 5]],
    ]);
  });
});

describe("actions on search results", () => {
  it("finds a thread cached only in search results", () => {
    const data = results([thread(1), thread(2, 3)]);
    queryClient.setQueryData(searchKey, data);

    expect(findCachedSummary(2)).toEqual(data.threads[1]);
    expect(findCachedSummary(99)).toBeUndefined();
  });

  it("marks a batch read in every search cache and preserves search metadata", () => {
    const data = results([thread(1), thread(2, 3), thread(3)]);
    queryClient.setQueryData(searchKey, data);
    const accountKey = ["search", "from:sender", 1];
    queryClient.setQueryData(accountKey, data);

    applyOptimistic("mark_read", [1, 2]);

    for (const key of [searchKey, accountKey]) {
      const updated = queryClient.getQueryData<SearchResults>(key)!;
      expect(updated.threads.map((t) => t.unreadCount)).toEqual([0, 0, 1]);
      expect(updated.hits).toEqual(data.hits);
      expect(updated.explain).toEqual(data.explain);
    }
    expect(data.threads.map((t) => t.unreadCount)).toEqual([1, 3, 1]);
  });

  it("removes archived threads and their matching search hits together", () => {
    const data = results([thread(1), thread(2), thread(3)]);
    queryClient.setQueryData(searchKey, data);

    applyOptimistic("archive", [1, 3]);

    const updated = queryClient.getQueryData<SearchResults>(searchKey)!;
    expect(updated.threads.map((t) => t.id)).toEqual([2]);
    expect(updated.hits).toEqual([data.hits[1]]);
    expect(updated.explain).toEqual(data.explain);
  });

  it("submits the bulk read command for threads absent from the inbox cache", async () => {
    queryClient.setQueryData(searchKey, results([thread(1), thread(2)]));
    useUi.getState().setSelection([1, 2]);

    buildCommandContext().toggleRead();

    expect(call).toHaveBeenCalledWith("perform_action", {
      args: { kind: "mark_read", threadIds: [1, 2], params: undefined },
    });
    expect(useUi.getState().selection).toEqual([]);
    await vi.waitFor(() => expect(queryClient.getQueryState(searchKey)?.isInvalidated).toBe(true));
  });

  it("refreshes is:unread after the action so read threads disappear", async () => {
    const initial = results([thread(1), thread(2), thread(3)]);
    const remaining = results([thread(3)]);
    queryClient.setQueryData(searchKey, initial);
    const fetchResults = vi.fn().mockResolvedValue(remaining);
    const observer = new QueryObserver(queryClient, {
      queryKey: searchKey,
      queryFn: fetchResults,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(fetchResults).not.toHaveBeenCalled();

      await performThreadAction("mark_read", [1, 2]);

      expect(call).toHaveBeenCalledWith("perform_action", {
        args: { kind: "mark_read", threadIds: [1, 2], params: undefined },
      });
      await vi.waitFor(() => expect(queryClient.getQueryData(searchKey)).toEqual(remaining));
      expect(fetchResults).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
