import { useTranslation } from "react-i18next";
import { buildCommandContext, type CommandCtx } from "../../keyboard/context";
import { useUi } from "../../stores/ui";
import { MenuDivider as Divider, MenuItem as Item, Popover } from "../ui/Menu";

/**
 * Right-click context menu for a thread row. Opened from ThreadList (targets +
 * pointer position stored in the ui store) and mounted globally in App. Every
 * action routes through the shared command context so auto-advance, undo toasts
 * and optimistic updates match the keyboard shortcuts exactly.
 */
export function ThreadContextMenu() {
  const { t } = useTranslation();
  const menu = useUi((s) => s.contextMenu);
  const set = useUi((s) => s.set);
  const close = () => set({ contextMenu: null });

  if (!menu) return null;

  const targets = menu.targets;
  // Run a command-context verb against the menu's targets, then dismiss.
  const run = (fn: (ctx: CommandCtx) => void) => () => {
    close();
    fn(buildCommandContext(targets));
  };

  const single = targets.length === 1;

  return (
    <Popover x={menu.x} y={menu.y} onClose={close}>
      {single && (
        <>
          <Item
            label={t("common:contextMenu.open")}
            kbd="↵"
            onClick={() => {
              close();
              useUi.getState().openThread(targets[0]);
            }}
          />
          <Divider />
        </>
      )}
      <Item
        label={menu.unread ? t("common:contextMenu.markRead") : t("common:contextMenu.markUnread")}
        kbd="U"
        onClick={run((c) => c.toggleRead())}
      />
      <Item
        label={menu.starred ? t("common:contextMenu.unstar") : t("common:contextMenu.star")}
        kbd="S"
        onClick={run((c) => c.toggleStar())}
      />
      <Divider />
      <Item label={t("common:contextMenu.archive")} kbd="E" onClick={run((c) => c.act("archive"))} />
      <Item label={t("common:contextMenu.snooze")} kbd="H" onClick={run((c) => c.openSnooze())} />
      <Item label={t("common:contextMenu.move")} kbd="V" onClick={run((c) => c.openMove())} />
      <Item label={t("common:contextMenu.label")} kbd="L" onClick={run((c) => c.openLabel())} />
      <Divider />
      <Item danger label={t("common:contextMenu.trash")} kbd="#" onClick={run((c) => c.act("trash"))} />
      <Item label={t("common:contextMenu.spam")} kbd="!" onClick={run((c) => c.act("spam"))} />
    </Popover>
  );
}
