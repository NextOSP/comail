import i18n from "../i18n";
import type { ActionStateEvent } from "../ipc/types";
import { useUi } from "../stores/ui";
import { queryClient } from "./client";

const actionStates = new Map<number, ActionStateEvent["state"]>();
const queuedToasts = new Map<number, number>();
const requestedBatches = new Map<string, { remaining: Set<number>; failed: boolean }>();
const settledBatches = new Set<string>();

function settleRequestedBatches(event?: ActionStateEvent): void {
  for (const [key, batch] of requestedBatches) {
    if (event && batch.remaining.has(event.actionId)) {
      if (event.state === "failed") batch.failed = true;
      if (event.state === "done") batch.remaining.delete(event.actionId);
    }
    if (!batch.failed && batch.remaining.size) continue;
    requestedBatches.delete(key);
    settledBatches.add(key);
    if (!batch.failed) {
      useUi.getState().pushToast({ kind: "info", message: i18n.t("common:permanentDelete.done") });
    }
  }
  if (settledBatches.size > 1000) settledBatches.delete(settledBatches.values().next().value!);
}

const mailKeys = ["threads", "thread", "bundles", "unreadCounts", "search", "accounts", "emailStats"];
let refreshRun: Promise<void> | null = null;
let refreshAgain = false;

/** Cancel pre-enqueue snapshots, including first loads, before reading tombstones.
 *  Bursts of action events (one per message) coalesce: at most one run is active
 *  and one trailing run covers everything that arrived meanwhile. */
export function refreshPermanentDeleteQueries(): Promise<void> {
  if (refreshRun) {
    refreshAgain = true;
    return refreshRun;
  }
  refreshRun = (async () => {
    do {
      refreshAgain = false;
      await Promise.all(mailKeys.map((key) => queryClient.cancelQueries({ queryKey: [key] })));
      await Promise.all(mailKeys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    } while (refreshAgain);
  })().finally(() => {
    refreshRun = null;
  });
  return refreshRun;
}

/** One toast per distinct status message, shared by every action reporting it,
 *  so a many-message batch cannot flood the UI. */
const sharedToasts = new Map<string, { toast: number; ids: Set<number> }>();
const toastKeyByAction = new Map<number, string>();

function clearActionToast(actionId: number): void {
  const key = toastKeyByAction.get(actionId);
  if (key == null) return;
  toastKeyByAction.delete(actionId);
  const entry = sharedToasts.get(key);
  if (!entry) return;
  entry.ids.delete(actionId);
  if (entry.ids.size === 0) {
    useUi.getState().dismissToast(entry.toast);
    sharedToasts.delete(key);
  }
}

function showActionToast(actionId: number, kind: "error" | "info", message: string): void {
  const key = `${kind}:${message}`;
  if (toastKeyByAction.get(actionId) === key) return;
  clearActionToast(actionId);
  let entry = sharedToasts.get(key);
  // The user may have dismissed the shared toast; show it again for new events.
  if (entry && !useUi.getState().toasts.some((t) => t.id === entry!.toast)) entry = undefined;
  if (!entry) {
    entry = { toast: useUi.getState().pushToast({ kind, message }), ids: new Set() };
    sharedToasts.set(key, entry);
  }
  entry.ids.add(actionId);
  toastKeyByAction.set(actionId, key);
}

/** Enqueue can resolve after a fast worker's terminal event. Never regress its status. */
export function notifyPermanentDeleteQueued(actionIds: number[]): void {
  if (!actionIds.length) return;
  const ids = [...new Set(actionIds)].sort((a, b) => a - b);
  const key = ids.join(",");
  if (settledBatches.has(key) || requestedBatches.has(key)) return;
  requestedBatches.set(key, {
    remaining: new Set(ids.filter((id) => actionStates.get(id) !== "done")),
    failed: ids.some((id) => actionStates.get(id) === "failed"),
  });
  if (requestedBatches.size > 1000) requestedBatches.delete(requestedBatches.keys().next().value!);
  settleRequestedBatches();
  const pendingIds = actionIds.filter((id) =>
    (!actionStates.has(id) || ["pending", "inflight"].includes(actionStates.get(id)!)) &&
    !toastKeyByAction.has(id),
  );
  if (!pendingIds.length) return;
  const ui = useUi.getState();
  const toast = ui.pushToast({
    kind: "info",
    message: i18n.t(ui.offline ? "common:permanentDelete.offline" : "common:permanentDelete.pending"),
  });
  for (const id of pendingIds) queuedToasts.set(id, toast);
}

/** Shared by UI and MCP actions; retries are not terminal failures. */
export function handlePermanentDeleteState(event: ActionStateEvent): void {
  const { actionId, state, error } = event;
  void refreshPermanentDeleteQueries();
  const previous = actionStates.get(actionId);
  const retryDetail = state === "pending" && error ? error : null;
  // A pending event that newly carries an error is a visible retry, not a duplicate.
  if (previous === "done" || (previous === state && retryDetail == null)) return;
  actionStates.set(actionId, state);
  const ui = useUi.getState();
  if (state !== "pending" || retryDetail != null) {
    const queued = queuedToasts.get(actionId);
    if (queued != null) {
      ui.dismissToast(queued);
      for (const [id, toast] of queuedToasts) {
        if (toast === queued) queuedToasts.delete(id);
      }
    }
  }
  // Keep enough recent states for enqueue/event races without retaining every
  // completed action for the lifetime of a long-running desktop session.
  if (actionStates.size > 1000) {
    const oldest = actionStates.keys().next().value!;
    actionStates.delete(oldest);
    clearActionToast(oldest);
    queuedToasts.delete(oldest);
  }
  // The mail stays hidden while a retry is pending: the remote outcome is
  // unknown, so tell the user instead of silently looping.
  if (state === "failed") {
    showActionToast(actionId, "error", i18n.t("common:permanentDelete.failed", { detail: error ?? state }));
  } else if (state === "paused") {
    showActionToast(actionId, "info", i18n.t("common:permanentDelete.paused"));
  } else if (retryDetail != null) {
    showActionToast(actionId, "info", i18n.t("common:permanentDelete.retrying", { detail: retryDetail }));
  } else {
    clearActionToast(actionId);
  }
  settleRequestedBatches(event);
  // Completion feedback follows confirmed action states, while backend snapshots
  // preserve Inbox/Sent messages in mixed threads instead of removing whole rows.
}
