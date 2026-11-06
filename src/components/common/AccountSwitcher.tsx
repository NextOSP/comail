import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { displayShortcut } from "../../keyboard/registry";
import { accountLabel, IS_MAC } from "../../lib/format";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Menu";

/** Marker the sidebar's key handler uses to stand down while the menu is open. */
export const ACCOUNT_MENU_ATTR = "data-account-menu";

const NAV_FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-accent/60";

/**
 * Account scope picker at the head of the sidebar (drawer or docked). The
 * Ctrl/Alt+0-9 shortcuts live in the command registry and keep working with the
 * menu open; this is the pointer/keyboard path to the same switch.
 */
export function AccountSwitcher({ onSelected }: { onSelected?: () => void }) {
  const { t } = useTranslation();
  const accountFilter = useUi((s) => s.accountFilter);
  const setAccountFilter = useUi((s) => s.setAccountFilter);
  const { data: accounts } = useAccounts();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = accounts?.find((a) => a.id === accountFilter);
  const open = menuAt != null;

  const close = (restoreFocus = true) => {
    setMenuAt(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  // Focus the current choice on open, then own the navigation keys until close.
  // Captured on window (like the drawer's handler) so list/global shortcuts
  // such as E or J never fire behind the menu; modified keys still pass through
  // so Ctrl/Alt+N can switch accounts while it is open.
  useEffect(() => {
    if (!open) return;
    const items = () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitemradio'], button[role='menuitem']") ?? []);
    const raf = requestAnimationFrame(() => {
      const list = items();
      (list.find((b) => b.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      const list = items();
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let next: number | null = null;
      if (key === "ArrowDown" || key === "j") next = current < 0 ? 0 : Math.min(list.length - 1, current + 1);
      else if (key === "ArrowUp" || key === "k") next = current < 0 ? 0 : Math.max(0, current - 1);
      else if (key === "Home") next = 0;
      else if (key === "End") next = list.length - 1;
      // Enter/Space keep their native button activation; just hide them from
      // the global registry.
      e.stopPropagation();
      if (next == null) return;
      e.preventDefault();
      list[next]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (accountId: number | null) => {
    setAccountFilter(accountId);
    close();
    onSelected?.();
  };

  return (
    <>
      <button
        ref={triggerRef}
        data-nav
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-bg2 ${NAV_FOCUS}`}
        title={active ? active.email : t("common:topbar.switchAccount")}
        onClick={(e) => {
          if (open) {
            close(false);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 4, width: r.width });
        }}
      >
        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">
          {active ? accountLabel(active) : t("common:topbar.allAccounts")}
        </span>
        <Icon name="chevronDown" size={12} className="shrink-0 text-ink-faint" />
      </button>
      {menuAt &&
        createPortal(
          <Popover x={menuAt.x} y={menuAt.y} minWidth={Math.max(menuAt.width, 240)} onClose={() => close(false)}>
            <div ref={menuRef} role="group" aria-label={t("common:topbar.switchAccount")} {...{ [ACCOUNT_MENU_ATTR]: "" }}>
              <AccountItem
                label={t("common:topbar.allAccounts")}
                hint={displayShortcut(IS_MAC ? "ctrl+0" : "alt+0")}
                selected={accountFilter == null}
                onClick={() => choose(null)}
              />
              {(accounts ?? []).map((a, i) => (
                <AccountItem
                  key={a.id}
                  label={accountLabel(a)}
                  detail={a.displayName?.trim() ? a.email : undefined}
                  hint={i < 9 ? displayShortcut(IS_MAC ? `ctrl+${i + 1}` : `alt+${i + 1}`) : undefined}
                  sub={a.syncState !== "idle" ? t(`common:syncState.${a.syncState}`) : undefined}
                  selected={accountFilter === a.id}
                  onClick={() => choose(a.id)}
                />
              ))}
              <div role="separator" className="my-1 border-t border-hairline" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-base text-ink hover:bg-bg2 ${NAV_FOCUS}`}
                onClick={() => {
                  close(false);
                  useUi.getState().set({ panel: "settings", settingsTab: "accounts", sidebarOpen: false });
                }}
              >
                <span aria-hidden="true">+</span>
                {t("onboarding:titleAddAccount")}
              </button>
            </div>
          </Popover>,
          document.body,
        )}
    </>
  );
}

function AccountItem({
  label,
  detail,
  sub,
  hint,
  selected,
  onClick,
}: {
  label: string;
  /** secondary line (e.g. the email when the label is a display name) */
  detail?: string;
  /** right-aligned status text (e.g. "Syncing") */
  sub?: string;
  /** keyboard hint chip, e.g. "⌃1" */
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      tabIndex={-1}
      className={`flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-base ${NAV_FOCUS} ${selected ? "bg-bg2" : "hover:bg-bg2"}`}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${selected ? "font-medium text-ink" : "text-ink"}`}>{label}</span>
        {detail && <span className="truncate text-xs text-ink-faint">{detail}</span>}
      </span>
      {sub && <span className="shrink-0 text-xs text-ink-faint">{sub}</span>}
      {hint && <kbd className="co-kbd shrink-0 tabular-nums">{hint}</kbd>}
    </button>
  );
}
