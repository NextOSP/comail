import { useTranslation } from "react-i18next";
import { buildCommandContext } from "../../keyboard/context";
import { performThreadAction } from "../../queries/actions";
import { useUi } from "../../stores/ui";
import { TimePopover } from "./TimePopover";

/** Global snooze popover, opened by H (targets stored in the ui store). */
export function SnoozePopover() {
  const { t } = useTranslation();
  const target = useUi((s) => s.snoozeTarget);
  const set = useUi((s) => s.set);

  if (!target) return null;

  return (
    <TimePopover
      title={t("common:snoozePopover.snoozeUntil")}
      verb={t("common:snoozePopover.snoozeUntil")}
      onClose={() => set({ snoozeTarget: null })}
      onPick={(at, label) => {
        const ids = target;
        set({ snoozeTarget: null });
        // Route through the shared context so auto-advance + undo toast apply.
        const ctx = buildCommandContext();
        const untilLabel = t("common:snoozePopover.snoozedUntil", { label });
        if (ctx.targets.length > 0 && ids.every((id) => ctx.targets.includes(id))) {
          ctx.act("snooze", { wakeAt: at }, untilLabel);
        } else {
          void performThreadAction("snooze", ids, { wakeAt: at });
          useUi.getState().set({ lastUndo: { type: "action", label: t("common:snoozePopover.snoozed") } });
          useUi.getState().pushToast({
            kind: "info",
            message: t("common:undoSuffix", { label: untilLabel }),
          });
        }
      }}
    />
  );
}
