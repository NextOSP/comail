import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import { onEvent } from "../ipc/events";
import type { AskCitation, AttachmentPreview, ThreadPage, ThreadSummary, View } from "../ipc/types";
import type { BundleTab } from "../lib/listItems";
import { HIDDEN_LOCAL_CALENDAR, useUi } from "../stores/ui";
import { queryClient } from "./client";

const PAGE_SIZE = 50;

export const threadsKey = (
  view: View,
  splitId: number | null,
  accountId: number | null,
  labelId: number | null = null,
  folderId: number | null = null,
) => ["threads", view, splitId, accountId, labelId, folderId] as const;

/** Infinite thread list for a view (+ inbox split, + optional label/folder filter). */
export function useThreads(
  view: View,
  splitId: number | null,
  accountId: number | null,
  labelId: number | null = null,
  folderId: number | null = null,
) {
  return useInfiniteQuery({
    queryKey: threadsKey(view, splitId, accountId, labelId, folderId),
    queryFn: ({ pageParam }) =>
      call("list_threads", {
        view,
        splitId: view === "inbox" ? splitId : null,
        accountId,
        labelId,
        folderId,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: ThreadPage) => last.nextCursor,
  });
}

/** First few threads of each tab, for the comfortable list's bundle rows.
 *  Plain (non-infinite) queries under their own key, so the optimistic updaters
 *  that walk every ["threads"] page cache never see this shape. */
export function useInboxBundles(tabs: BundleTab[], accountId: number | null, enabled: boolean) {
  return useQueries({
    queries: tabs.map((tab) => ({
      queryKey: ["bundles", tab.splitId ?? null, tab.labelId ?? null, accountId],
      queryFn: () =>
        call("list_threads", {
          view: "inbox" as View,
          splitId: tab.splitId ?? null,
          accountId,
          labelId: tab.labelId ?? null,
          folderId: null,
          cursor: null,
          limit: 12,
        }),
      enabled,
      staleTime: 5_000,
    })),
    combine: bundlePages,
  });
}

// Module-level so useQueries keeps the combined array stable between renders.
const bundlePages = (results: { data?: ThreadPage }[]) => results.map((r) => r.data);

/** Resolved sender picture (data URL) or null; one lookup per address per session. */
export function useSenderAvatar(email: string, enabled: boolean) {
  return useQuery({
    queryKey: ["senderAvatar", email.trim().toLowerCase()],
    queryFn: () => call("sender_avatar", { email }),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

export function flattenThreads(data: { pages: ThreadPage[] } | undefined): ThreadSummary[] {
  return data?.pages.flatMap((p) => p.threads) ?? [];
}

const THREAD_STALE_MS = 10_000;

function fetchThread(threadId: number) {
  if (!import.meta.env.DEV) return call("get_thread", { threadId });
  const t0 = performance.now();
  return call("get_thread", { threadId }).then((data) => {
    performance.measure(`thread-data:${threadId}`, { start: t0, end: performance.now() });
    return data;
  });
}

export function useThread(threadId: number | null) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => fetchThread(threadId!),
    enabled: threadId != null,
    staleTime: THREAD_STALE_MS,
  });
}

// Preview payloads can be tens of MB (base64 PDFs), so they don't linger long
// once the viewer moves on; attachments are immutable so they never go stale.
const PREVIEW_GC_MS = 60_000;

const previewQuery = (attachmentId: number) => ({
  queryKey: ["attachmentPreview", attachmentId],
  queryFn: (): Promise<AttachmentPreview> => call("preview_attachment", { attachmentId }),
  staleTime: Infinity,
  gcTime: PREVIEW_GC_MS,
  retry: false,
});

/** Safe preview payload for one attachment (see comail-core/src/preview.rs). */
export function useAttachmentPreview(attachmentId: number | null, enabled = true) {
  return useQuery({ ...previewQuery(attachmentId ?? -1), enabled: enabled && attachmentId != null });
}

/** Warm a neighbouring attachment so paging through the viewer feels instant. */
export function prefetchAttachmentPreview(attachmentId: number) {
  void queryClient.prefetchQuery(previewQuery(attachmentId));
}

/** Warm the thread cache (hover intent, keyboard selection) so opening it
 *  paints from cache instead of paying the IPC round-trip on click. */
export function prefetchThread(threadId: number) {
  void queryClient.prefetchQuery({
    queryKey: ["thread", threadId],
    queryFn: () => fetchThread(threadId),
    staleTime: THREAD_STALE_MS,
  });
}

export function useSearch(query: string, accountId: number | null = null) {
  return useQuery({
    queryKey: ["search", query, accountId],
    queryFn: () => call("search", { args: { query, accountId, limit: 60 } }),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

/** Live "what will this search do" summary. Parse-only and cheap, so it runs
 *  on every keystroke (no debounce) and keeps the last answer on screen. */
export function useSearchExplain(query: string) {
  return useQuery({
    queryKey: ["search-explain", query],
    queryFn: () => call("explain_search", { query }),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
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
    // accountId null lists folders across every account (backend handles null).
    queryFn: () => call("list_folders", { accountId }),
    staleTime: 60_000,
  });
}

export function useCalendars(accountId: number | null = null) {
  return useQuery({
    queryKey: ["calendars", accountId],
    queryFn: () => call("list_calendars", { accountId }),
    staleTime: 30_000,
  });
}

export function useSetCalendarColor() {
  return useMutation({
    mutationFn: (vars: { calendarId: number; color: string | null }) =>
      call("set_calendar_color", vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendars"] }),
  });
}

export function useSetDefaultCalendar() {
  return useMutation({
    mutationFn: (vars: { calendarId: number }) => call("set_default_calendar", vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendars"] }),
  });
}

export function useCalendarEvents(startMs: number, endMs: number, enabled = true) {
  return useQuery({
    queryKey: ["events", startMs, endMs],
    queryFn: () => call("list_events", { startMs, endMs }),
    enabled,
    staleTime: 30_000,
    // Paging weeks/months keeps the old range on screen until the new one
    // lands, instead of flashing an empty grid.
    placeholderData: keepPreviousData,
  });
}

/** Calendar-view events minus the calendars hidden in the sidebar. */
export function useVisibleCalendarEvents(startMs: number, endMs: number, enabled = true) {
  const query = useCalendarEvents(startMs, endMs, enabled);
  const hidden = useUi((s) => s.calendarHidden);
  const data = useMemo(() => {
    if (!query.data || hidden.length === 0) return query.data;
    const set = new Set(hidden);
    return query.data.filter((ev) => !set.has(ev.calendarId ?? HIDDEN_LOCAL_CALENDAR));
  }, [query.data, hidden]);
  return { ...query, data };
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

export function useAiUsage() {
  return useQuery({
    queryKey: ["aiUsage"],
    queryFn: () => call("ai_usage_stats", {}),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useEmailStats() {
  return useQuery({
    queryKey: ["emailStats"],
    queryFn: () => call("email_stats", {}),
    staleTime: 30_000,
    refetchInterval: 60_000,
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
  const [reasoning, setReasoning] = useState("");
  const [citations, setCitations] = useState<AskCitation[]>([]);
  const [status, setStatus] = useState<AskStatus>("idle");
  const [error, setError] = useState("");
  const activeId = useRef<string>("");
  // Tracks streamed answer text so a late failure (e.g. the endpoint dropping
  // the connection after the answer completed) doesn't discard a good answer.
  const streamed = useRef("");

  const run = useCallback((question: string, accountId: number | null = null) => {
    const requestId = crypto.randomUUID();
    activeId.current = requestId;
    streamed.current = "";
    setAnswer("");
    setReasoning("");
    setCitations([]);
    setError("");
    setStatus("pending");

    const isCurrent = (id: string) => activeId.current === requestId && id === requestId;

    const offCitations = onEvent("ai:ask:citations", (p) => {
      if (isCurrent(p.requestId)) setCitations(p.citations);
    });
    const offToken = onEvent("ai:ask:token", (p) => {
      if (!isCurrent(p.requestId)) return;
      streamed.current += p.delta;
      setStatus("streaming");
      setAnswer((prev) => prev + p.delta);
    });
    const offReasoning = onEvent("ai:ask:reasoning", (p) => {
      if (isCurrent(p.requestId)) setReasoning((prev) => prev + p.delta);
    });
    // Text streamed as an answer was a preamble to a tool call: drop it.
    const offReset = onEvent("ai:ask:reset", (p) => {
      if (!isCurrent(p.requestId)) return;
      streamed.current = "";
      setAnswer("");
      setStatus("pending");
    });

    call("ai_ask", { question, requestId, accountId })
      .then((res) => {
        if (activeId.current !== requestId) return;
        setAnswer(res.answer);
        setCitations(res.citations);
        setStatus("done");
      })
      .catch((e) => {
        if (activeId.current !== requestId) return;
        // If the answer already streamed in, keep it - a failure on the final
        // response shouldn't erase a complete, visible answer.
        if (streamed.current.trim() !== "") {
          setStatus("done");
          return;
        }
        setError(errorMessage(e));
        setStatus("error");
      })
      .finally(() => {
        offCitations();
        offToken();
        offReasoning();
        offReset();
      });
  }, []);

  const reset = useCallback(() => {
    activeId.current = "";
    setAnswer("");
    setReasoning("");
    setCitations([]);
    setError("");
    setStatus("idle");
  }, []);

  return { run, reset, answer, reasoning, citations, status, error };
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
