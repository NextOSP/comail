// Executes the structured intent the AI parsed from a natural-language
// palette query. Event creation opens the prefilled modal (user confirms
// before anything is sent); nothing here performs irreversible actions.

import i18n from "../i18n";
import { call } from "../ipc/commands";
import { errorMessage } from "../ipc/errors";
import type { AiIntent, View } from "../ipc/types";
import { useUi } from "../stores/ui";

const VIEWS: View[] = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "done",
  "trash",
  "spam",
  "all",
];

export async function runAiCommand(query: string): Promise<void> {
  const ui = useUi.getState();
  let intent: AiIntent;
  try {
    intent = await call("ai_command", { query });
  } catch (err) {
    ui.pushToast({ kind: "error", message: errorMessage(err) });
    return;
  }

  switch (intent.kind) {
    case "create_event": {
      const startsAt = intent.startsAt ?? Date.now() + 60 * 60 * 1000;
      ui.set({
        paletteOpen: false,
        eventCreate: {
          prefill: {
            summary: intent.summary ?? query,
            startsAt,
            endsAt: intent.endsAt ?? startsAt + 60 * 60 * 1000,
            description: intent.location
              ? i18n.t("commands:aiIntent.locationNote", { location: intent.location })
              : undefined,
          },
        },
      });
      return;
    }
    case "compose": {
      ui.set({ paletteOpen: false });
      ui.openComposer({
        mode: "new",
        initial: {
          to: (intent.to ?? []).map((email) => ({ name: null, email })),
          subject: intent.subject ?? "",
          body: intent.body ?? "",
        },
      });
      return;
    }
    case "search": {
      ui.set({
        paletteOpen: false,
        searchOpen: true,
        searchQuery: intent.query ?? query,
        openThreadId: null,
      });
      return;
    }
    case "go_to": {
      const view = VIEWS.find((v) => v === intent.view);
      if (view) {
        ui.set({ paletteOpen: false });
        ui.setView(view);
        return;
      }
      break;
    }
  }
  ui.pushToast({
    kind: "info",
    message: i18n.t("commands:aiIntent.notUnderstood"),
    durationMs: 4000,
  });
}
