// Shared unsubscribe path for the U / Cmd+U command and the thread header
// button. The backend does the real work (RFC 8058 one-click POST, mailto
// send, or handing back a URL); this module turns the outcome into honest
// toasts - "Unsubscribed" is only claimed when the one-click POST returned
// 2xx or the mailto request was actually sent.

import { openUrl } from "@tauri-apps/plugin-opener";
import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import { MOCK_MODE } from "../ipc/mock";
import type { MessageDetail } from "../ipc/types";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";

/** Latest message carrying a List-Unsubscribe header, or null. */
export function latestUnsubscribeMessage(messages: MessageDetail[]): MessageDetail | null {
  const withHeader = messages.filter((m) => m.listUnsubscribe);
  if (withHeader.length === 0) return null;
  return withHeader.reduce((a, b) => (b.date >= a.date ? b : a));
}

/**
 * Unsubscribe from a thread the user only has selected, not open.
 *
 * The backend resolves which message to act on: the cached thread detail is not
 * a reliable answer (it may not be loaded yet, and mail synced before v0.2.27
 * has no stored List-Unsubscribe even when its raw carries one), and answering
 * from it produced a false "No unsubscribe link".
 */
export async function unsubscribeThread(threadId: number): Promise<void> {
  const push = useUi.getState().pushToast;
  let messageId: number | null;
  try {
    messageId = await call("thread_unsubscribe_message", { threadId });
  } catch (err) {
    push({
      kind: "error",
      message: i18n.t("commands:toast.unsubscribeFailed", { detail: errorMessage(err) }),
    });
    return;
  }
  if (messageId == null) {
    push({ kind: "info", message: i18n.t("commands:toast.noUnsubscribeLink") });
    return;
  }
  // A backfilled header makes the thread's own unsubscribe button appear.
  void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
  await unsubscribeMessageId(messageId);
}

/** Run the unsubscribe for one message and toast what actually happened. */
export function unsubscribeFromMessage(msg: MessageDetail): Promise<void> {
  return unsubscribeMessageId(msg.id);
}

async function unsubscribeMessageId(messageId: number): Promise<void> {
  const push = useUi.getState().pushToast;
  try {
    const outcome = await call("unsubscribe_message", { messageId });
    switch (outcome.kind) {
      case "oneClick":
        push({ kind: "info", message: i18n.t("commands:toast.unsubscribed") });
        break;
      case "mailtoSent":
        push({ kind: "info", message: i18n.t("commands:toast.unsubscribeRequestSent") });
        break;
      case "needsBrowser":
        if (MOCK_MODE) {
          push({ kind: "info", message: i18n.t("commands:toast.unsubscribeWouldOpen", { url: outcome.url }) });
        } else {
          await openUrl(outcome.url);
          push({ kind: "info", message: i18n.t("commands:toast.unsubscribeOpenedBrowser") });
        }
        break;
    }
  } catch (err) {
    push({
      kind: "error",
      message: i18n.t("commands:toast.unsubscribeFailed", { detail: errorMessage(err) }),
    });
  }
}
