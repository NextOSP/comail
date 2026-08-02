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
import { useUi } from "../stores/ui";

/** Latest message carrying a List-Unsubscribe header, or null. */
export function latestUnsubscribeMessage(messages: MessageDetail[]): MessageDetail | null {
  const withHeader = messages.filter((m) => m.listUnsubscribe);
  if (withHeader.length === 0) return null;
  return withHeader.reduce((a, b) => (b.date >= a.date ? b : a));
}

/** Run the unsubscribe for one message and toast what actually happened. */
export async function unsubscribeFromMessage(msg: MessageDetail): Promise<void> {
  const push = useUi.getState().pushToast;
  try {
    const outcome = await call("unsubscribe_message", { messageId: msg.id });
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
