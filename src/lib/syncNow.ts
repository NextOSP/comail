import { useSyncExternalStore } from "react";
import { call } from "../ipc/commands";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";
import { normalizeSyncStatus } from "./syncStatus";

/**
 * The single "check mail now" path shared by the command palette, the top bar
 * button and Settings. `null` means every account.
 *
 * `sync_now` resolves only after the requested foreground Inbox pass settles,
 * so the cache invalidation and the authoritative status snapshot below cannot
 * race ahead of new headers.
 */
const inflight = new Map<number | null, Promise<void>>();
const listeners = new Set<() => void>();
// useSyncExternalStore needs a referentially stable snapshot between changes.
let snapshot: readonly (number | null)[] = [];

function publish() {
  snapshot = [...inflight.keys()];
  for (const notify of listeners) notify();
}

/** Whether a manual pass already covers `accountId` ("all" covers every account). */
export function isManualSyncBusy(accountId: number | null, active: readonly (number | null)[] = snapshot) {
  if (active.length === 0) return false;
  // An all-accounts pass overlaps every account, and vice versa.
  return accountId == null || active.includes(null) || active.includes(accountId);
}

/** Reactive busy flag for the given account scope. */
export function useManualSyncBusy(accountId: number | null): boolean {
  const active = useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => snapshot,
    () => snapshot,
  );
  return isManualSyncBusy(accountId, active);
}

/**
 * Run one foreground sync pass and refresh dependent caches. A request whose
 * scope is covered by a pass already running joins that pass. An all-accounts
 * request cannot join a single-account pass. Rejects with the backend error so each caller can word its own
 * failure feedback.
 */
export function syncNowAndRefresh(accountId: number | null): Promise<void> {
  const overlapping = [...inflight.entries()].find(([key]) => key === null || key === accountId);
  if (overlapping) return overlapping[1];

  const run = (async () => {
    await call("sync_now", { accountId });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["threads"] }),
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] }),
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    ]);
    const statuses = (await call("get_sync_status", {}))
      .map(normalizeSyncStatus)
      .filter((status): status is NonNullable<typeof status> => status != null);
    useUi.getState().replaceSyncStatuses(statuses);
  })().finally(() => {
    inflight.delete(accountId);
    publish();
  });
  inflight.set(accountId, run);
  publish();
  return run;
}
