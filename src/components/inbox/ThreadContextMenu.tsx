import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { buildCommandContext, type CommandCtx } from "../../keyboard/context";
import { useUi } from "../../stores/ui";

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
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const close = () => set({ contextMenu: null });

  // Clamp the menu into the viewport once we know its measured size.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(menu.x, window.innerWidth - width - pad);
    const top = Math.min(menu.y, window.innerHeight - height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [menu]);

  // Close on scroll or resize (the anchor row would move out from under it).
  useEffect(() => {
    if (!menu) return;
    const onScroll = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  if (!menu) return null;

  const targets = menu.targets;
  // Run a command-context verb against the menu's targets, then dismiss.
  const run = (fn: (ctx: CommandCtx) => void) => () => {
    close();
    fn(buildCommandContext(targets));
  };

  const single = targets.length === 1;

  return (
    <div className="fixed inset-0 z-50" onMouseDown={close} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="co-pop-in absolute min-w-[190px] rounded-lg border border-hairline bg-bg1 py-1"
        style={{
          left: pos?.left ?? menu.x,
          top: pos?.top ?? menu.y,
          visibility: pos ? "visible" : "hidden",
          boxShadow: "var(--elev-2)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
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
        <Item label={t("common:contextMenu.trash")} kbd="#" onClick={run((c) => c.act("trash"))} />
        <Item label={t("common:contextMenu.spam")} kbd="!" onClick={run((c) => c.act("spam"))} />
      </div>
    </div>
  );
}

function Item({ label, kbd, onClick }: { label: ReactNode; kbd?: string; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-bg2"
      onClick={onClick}
    >
      <span>{label}</span>
      {kbd && <kbd className="co-kbd !h-[1.35em] !text-[10px]">{kbd}</kbd>}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-hairline" />;
}
