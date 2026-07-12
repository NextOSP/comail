import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import { onEvent } from "../ipc/events";
import type { AskCitation, ThreadPage, ThreadSummary, View } from "../ipc/types";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

const PAGE_SIZE = 50;

export const threadsKey = (
  view: View,
  splitId: number | null,
  accountId: number | null,
  labelId: number | null = null,
) => ["threads", view, splitId, accountId, labelId] as const;

/** Infinite thread list for a view (+ inbox split, + optional label filter). */
export function useThreads(
  view: View,
  splitId: number | null,
  accountId: number | null,
  labelId: number | null = null,
) {
  return useInfiniteQuery({
    queryKey: threadsKey(view, splitId, accountId, labelId),
    queryFn: ({ pageParam }) =>
      call("list_threads", {
        view,
        splitId: view === "inbox" ? splitId : null,
        accountId,
        labelId,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: ThreadPage) => last.nextCursor,
  });
}

export function flattenThreads(data: { pages: ThreadPage[] } | undefined): ThreadSummary[] {
  return data?.pages.flatMap((p) => p.threads) ?? [];
}

export function useThread(threadId: number | null) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => call("get_thread", { threadId: threadId! }),
    enabled: threadId != null,
    staleTime: 10_000,
  });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ["search", query],
    queryFn: () => call("search", { args: { query, limit: 60 } }),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

/** Affinity-ranked contact suggestions shown above search results. */
export function useContactSuggestions(query: string) {
  return useQuery({
    queryKey: ["contact-suggestions", query],
    queryFn: () => call("suggest_contacts", { query, limit: 4 }),
    enabled: query.trim().length > 1,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => call("list_accounts", {}),
    staleTime: 60_000,
  });
}

export function useSnippets() {
  return useQuery({
    queryKey: ["snippets"],
    queryFn: () => call("list_snippets", {}),
    staleTime: 60_000,
  });
}

export function useLabels() {
  return useQuery({
    queryKey: ["labels"],
    queryFn: () => call("list_labels", {}),
    staleTime: 60_000,
  });
}

export function useSplits() {
  return useQuery({
    queryKey: ["splits"],
    queryFn: () => call("list_splits", {}),
    staleTime: 60_000,
  });
}

export function useFolders(accountId: number | null) {
  return useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => call("list_folders", { accountId }),
    enabled: accountId != null,
    staleTime: 60_000,
  });
}

export function useCalendarEvents(startMs: number, endMs: number, enabled = true) {
  return useQuery({
    queryKey: ["events", startMs, endMs],
    queryFn: () => call("list_events", { startMs, endMs }),
    enabled,
    staleTime: 30_000,
  });
}

/** Invite events carried by one message (thread invite card). */
export function useMessageEvents(messageId: number, enabled = true) {
  return useQuery({
    queryKey: ["messageEvents", messageId],
    queryFn: () => call("events_for_message", { messageId }),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateEvent() {
  return useMutation({
    mutationFn: (args: import("../ipc/types").CreateEventArgs) =>
      call("create_event", { args }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["events"] }),
  });
}

export function useUpdateEvent() {
  return useMutation({
    mutationFn: (args: import("../ipc/types").UpdateEventArgs) =>
      call("update_event", { args }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
    },
  });
}

export function useDeleteEvent() {
  return useMutation({
    mutationFn: (vars: { eventId: number; notify?: boolean }) => call("delete_event", vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
    },
  });
}

/**
 * Drag move/resize: same backend call as useUpdateEvent, but with an
 * optimistic patch of every cached `["events", …]` range so the block lands
 * where it was dropped instead of snapping back until the refetch.
 */
export function useMoveEvent() {
  type EventList = import("../ipc/types").CalendarEvent[];
  return useMutation({
    mutationFn: (args: import("../ipc/types").UpdateEventArgs) =>
      call("update_event", { args }),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["events"] });
      const snapshot = queryClient.getQueriesData<EventList>({ queryKey: ["events"] });
      for (const [key, list] of snapshot) {
        if (!list) continue;
        queryClient.setQueryData<EventList>(
          key,
          list.map((ev) =>
            ev.id === args.eventId
              ? {
                  ...ev,
                  startsAt: args.startsAt,
                  endsAt: args.endsAt,
                  allDay: args.allDay ?? ev.allDay,
                }
              : ev,
          ),
        );
      }
      return { snapshot };
    },
    onError: (err, _args, ctx) => {
      for (const [key, list] of ctx?.snapshot ?? []) {
        queryClient.setQueryData(key, list);
      }
      useUi.getState().pushToast({ kind: "error", message: errorMessage(err) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
    },
  });
}

export function useRsvpEvent() {
  return useMutation({
    mutationFn: (vars: { eventId: number; response: import("../ipc/types").RsvpResponse }) =>
      call("rsvp_event", { args: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["messageEvents"] });
    },
  });
}

export function useAiStatus() {
  return useQuery({
    queryKey: ["aiStatus"],
    queryFn: () => call("ai_status", {}),
    staleTime: 60_000,
  });
}

/** Model ids from the AI endpoint; refetches when the base URL changes. */
export function useAiModels(baseUrl: string) {
  return useQuery({
    queryKey: ["aiModels", baseUrl],
    queryFn: () => call("ai_list_models", {}),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Semantic index progress; polls while indexing is in flight. */
export function useEmbeddingStatus() {
  return useQuery({
    queryKey: ["embeddingStatus"],
    queryFn: () => call("embedding_status", {}),
    refetchInterval: (q) => (q.state.data?.pending ? 2_000 : 15_000),
    staleTime: 1_000,
  });
}

export type AskStatus = "idle" | "pending" | "streaming" | "done" | "error";

/**
 * RAG "ask your inbox". Surfaces source citations as soon as they're retrieved
 * and streams the answer token-by-token via `ai:ask:*` events, with the
 * resolved `ai_ask` call as the authoritative final state. Only the latest
 * question's events are applied (stale requests are ignored).
 */
export function useAsk() {
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<AskCitation[]>([]);
  const [status, setStatus] = useState<AskStatus>("idle");
  const activeId = useRef<string>("");

  const run = useCallback((question: string) => {
    const requestId = crypto.randomUUID();
    activeId.current = requestId;
    setAnswer("");
    setCitations([]);
    setStatus("pending");

    const isCurrent = (id: string) => activeId.current === requestId && id === requestId;

    const offCitations = onEvent("ai:ask:citations", (p) => {
      if (isCurrent(p.requestId)) setCitations(p.citations);
    });
    const offToken = onEvent("ai:ask:token", (p) => {
      if (!isCurrent(p.requestId)) return;
      setStatus("streaming");
      setAnswer((prev) => prev + p.delta);
    });

    call("ai_ask", { question, requestId })
      .then((res) => {
        if (activeId.current !== requestId) return;
        setAnswer(res.answer);
        setCitations(res.citations);
        setStatus("done");
      })
      .catch(() => {
        if (activeId.current === requestId) setStatus("error");
      })
      .finally(() => {
        offCitations();
        offToken();
      });
  }, []);

  const reset = useCallback(() => {
    activeId.current = "";
    setAnswer("");
    setCitations([]);
    setStatus("idle");
  }, []);

  return { run, reset, answer, citations, status };
}

/** Learn the user's writing voice from sent mail; refreshes settings on success. */
export function useLearnVoice() {
  return useMutation({
    mutationFn: () => call("ai_learn_voice", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => call("get_settings", {}),
    staleTime: Infinity,
  });
}

/** Exact unread counts for every split tab and sidebar row (one backend call). */
export function useUnreadCounts(accountId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["unreadCounts", accountId],
    queryFn: () => call("unread_counts", { accountId }),
    enabled,
    staleTime: 5_000,
  });
}

/** Badge count for a split tab out of the shared counts result. */
export function splitCount(
  counts: import("../ipc/types").UnreadCounts | undefined,
  splitId: number | null,
): number | undefined {
  if (!counts) return undefined;
  if (splitId == null) return counts.inbox;
  if (splitId === -1) return counts.important;
  if (splitId === -2) return counts.other;
  return counts.splits[String(splitId)] ?? 0;
}
