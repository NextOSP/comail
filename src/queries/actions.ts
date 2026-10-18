import type { InfiniteData } from "@tanstack/react-query";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import type {
  ActionKind,
  SearchResults,
  ThreadDetail,
  ThreadPage,
  ThreadSummary,
} from "../ipc/types";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

/** Action kinds that remove the thread from most views. */
const REMOVAL_KINDS: ActionKind[] = ["archive", "unarchive", "trash", "spam", "not_spam", "snooze", "unsnooze", "move"];

function patchSummary(
  s: ThreadSummary,
  kind: ActionKind,
  params?: { wakeAt?: number; labelId?: number },
): ThreadSummary {
  switch (kind) {
    case "star":
      return { ...s, isStarred: true };
    case "unstar":
      return { ...s, isStarred: false };
    case "mark_read":
      return { ...s, unreadCount: 0 };
    case "mark_unread":
      return { ...s, unreadCount: Math.max(1, s.unreadCount) };
    case "snooze":
      return { ...s, snoozedUntil: params?.wakeAt ?? null };
    case "unsnooze":
      return { ...s, snoozedUntil: null };
    case "add_label":
      return params?.labelId != null && !s.labels.includes(params.labelId)
        ? { ...s, labels: [...s.labels, params.labelId] }
        : s;
    case "remove_label":
      return params?.labelId != null
        ? { ...s, labels: s.labels.filter((id) => id !== params.labelId) }
        : s;
    default:
      return s;
  }
}

/** Optimistically update every cached thread list + thread detail. */
export function applyOptimistic(
  kind: ActionKind,
  threadIds: number[],
  params?: { wakeAt?: number; labelId?: number },
) {
  const ids = new Set(threadIds);
  const removes = REMOVAL_KINDS.includes(kind);

  queryClient.setQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        threads: removes
          ? p.threads.filter((t) => !ids.has(t.id))
          : p.threads.map((t) => (ids.has(t.id) ? patchSummary(t, kind, params) : t)),
      })),
    };
  });

  // Preserve search metadata and keep hits aligned with threads when an action
  // removes results. Read/star changes update summaries until the next refetch.
  queryClient.setQueriesData<SearchResults>({ queryKey: ["search"] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      threads: removes
        ? data.threads.filter((t) => !ids.has(t.id))
        : data.threads.map((t) => (ids.has(t.id) ? patchSummary(t, kind, params) : t)),
      hits: removes ? data.hits.filter((h) => !ids.has(h.threadId)) : data.hits,
    };
  });

  for (const id of threadIds) {
    queryClient.setQueryData<ThreadDetail>(["thread", id], (d) => {
      if (!d) return d;
      const thread = patchSummary(d.thread, kind, params);
      const messages =
        kind === "mark_read"
          ? d.messages.map((m) => ({ ...m, isRead: true }))
          : d.messages;
      return { ...d, thread, messages };
    });
  }
}

function refetchLists() {
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["bundles"] });
  void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
}

/**
 * Optimistic thread action: cache updates immediately, network follows.
 * Returns the fire-and-forget backend promise.
 */
export function performThreadAction(
  kind: ActionKind,
  threadIds: number[],
  params?: { wakeAt?: number; targetFolderId?: number; labelId?: number },
): Promise<void> {
  applyOptimistic(kind, threadIds, params);
  return call("perform_action", { args: { kind, threadIds, params } })
    .then(() => {
      // reconcile in the background: labels/counts may have shifted, and
      // operator filters (is:unread, in:...) must re-apply on the backend
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    })
    .catch((err: unknown) => {
      useUi.getState().pushToast({
        kind: "error",
        message: i18n.t("commands:actionFailed", { detail: errorMessage(err) }),
      });
      refetchLists();
    });
}

/** Undo the most recent backend action and refetch. */
export async function undoLastAction(): Promise<boolean> {
  try {
    const { undone } = await call("undo_last", {});
    refetchLists();
    void queryClient.invalidateQueries({ queryKey: ["thread"] });
    return undone;
  } catch {
    refetchLists();
    return false;
  }
}

/**
 * Delete drafts by message id. Only the drafts go: the rest of each thread
 * (the mail being replied to) stays where it is. Throws on the first failure.
 */
export async function deleteDrafts(draftIds: number[]): Promise<void> {
  if (draftIds.length === 0) return;
  const gone = new Set(draftIds);
  try {
    for (const draftId of draftIds) await call("delete_draft", { draftId });
  } finally {
    queryClient.setQueriesData<ThreadDetail>({ queryKey: ["thread"] }, (detail) =>
      detail
        ? { ...detail, messages: detail.messages.filter((m) => !gone.has(m.id)) }
        : detail,
    );
    refetchLists();
    void queryClient.invalidateQueries({ queryKey: ["thread"] });
  }
}

/** Delete every draft in the given threads (the Drafts view's trash). */
export async function deleteThreadDrafts(threadIds: number[]): Promise<number> {
  const details = await Promise.all(
    threadIds.map(
      (threadId) =>
        queryClient.getQueryData<ThreadDetail>(["thread", threadId]) ??
        call("get_thread", { threadId }),
    ),
  );
  const draftIds = details.flatMap((d) => d.messages.filter((m) => m.isDraft).map((m) => m.id));
  await deleteDrafts(draftIds);
  return draftIds.length;
}

/** Look up a thread summary anywhere in the cache. */
export function findCachedSummary(threadId: number): ThreadSummary | undefined {
  const detail = queryClient.getQueryData<ThreadDetail>(["thread", threadId]);
  if (detail) return detail.thread;
  const lists = queryClient.getQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] });
  for (const [, data] of lists) {
    const hit = data?.pages.flatMap((p) => p.threads).find((t) => t.id === threadId);
    if (hit) return hit;
  }
  const searches = queryClient.getQueriesData<SearchResults>({ queryKey: ["search"] });
  for (const [, data] of searches) {
    const hit = data?.threads.find((t) => t.id === threadId);
    if (hit) return hit;
  }
  return undefined;
}
