import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "../../ipc/types";
import { buildFolderTree, type FolderNode } from "../../lib/folders";
import { inboxTabOrder } from "../../lib/splitOrder";
import {
  splitCount,
  useAccounts,
  useFolders,
  useLabels,
  useSettings,
  useSplits,
  useUnreadCounts,
} from "../../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi, type PanelKind } from "../../stores/ui";
import { Icon } from "../ui/Icon";

const VIEWS: View[] = ["starred", "snoozed", "drafts", "sent", "done", "spam", "trash", "all"];

/** Left drawer: mailboxes, splits, and management panels. */
export function Sidebar({ docked = false }: { docked?: boolean }) {
  const { t } = useTranslation();
  const drawerOpen = useUi((s) => s.sidebarOpen);
  const pinned = useUi((s) => s.sidebarPinned);
  const open = docked || drawerOpen;
  // Undocking keeps the visible panel in place until the pointer leaves it.
  // This is distinct from opening a fresh drawer via the toolbar.
  const [unpinPreview, setUnpinPreview] = useState(false);
  useEffect(() => {
    if (!open || docked) setUnpinPreview(false);
  }, [open, docked]);
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const accountFilter = useUi((s) => s.accountFilter);
  const labelFilter = useUi((s) => s.labelFilter);
  const folderFilter = useUi((s) => s.folderFilter);
  const setView = useUi((s) => s.setView);
  const selectLabel = useUi((s) => s.selectLabel);
  const selectFolder = useUi((s) => s.selectFolder);
  const openThread = useUi((s) => s.openThread);
  const set = useUi((s) => s.set);
  const { data: accounts } = useAccounts();
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const { data: settings } = useSettings();
  const autoLabelsEnabled = settings?.autoLabelsEnabled !== false;
  const { data: folders } = useFolders(accountFilter);
  const { data: counts } = useUnreadCounts(accountFilter, open);

  const folderTree = useMemo(() => buildFolderTree(folders ?? []), [folders]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const asideRef = useRef<HTMLElement>(null);
  // Docking consumes the temporary drawer state; shrinking must not unexpectedly
  // resurrect a modal overlay. Keep the persisted pin preference untouched.
  useEffect(() => {
    if (docked) set({ sidebarOpen: false });
  }, [docked, set]);
  // Keyboard: the drawer takes focus on open (on the current view's row) and
  // owns the navigation keys while open, so ↑/↓ (or J/K) walk its rows
  // instead of the thread list behind it. Enter opens the row, →/← expand and
  // collapse a folder, Esc closes. Captured on window so the global registry
  // never sees these keys.
  useEffect(() => {
    if (!open) return;
    const rows = () =>
      Array.from(asideRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav]") ?? []);
    const raf = docked || unpinPreview ? null : requestAnimationFrame(() => {
      const list = rows();
      (list.find((b) => b.dataset.active === "true") ?? list[1] ?? list[0])?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      if (docked && !asideRef.current?.contains(activeElement)) return;
      // The header remains interactive while the drawer is open.
      if (!docked && activeElement?.closest("header") && e.key !== "Escape") {
        if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
        return;
      }
      if (e.key === "Escape") {
        if (docked) return;
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().set({ sidebarOpen: false });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The pin control is not a mailbox row. Preserve its native Enter/Space
      // activation, without leaking those keys to mail-list shortcuts.
      if (activeElement?.closest("[data-sidebar-control]")) {
        e.stopPropagation();
        return;
      }
      const list = rows();
      if (list.length === 0) return;
      const focused = list.indexOf(document.activeElement as HTMLButtonElement);
      const current = focused >= 0 ? focused : list.findIndex((b) => b.dataset.active === "true");
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let next: number | null = null;
      if (key === "ArrowDown" || key === "j") next = current < 0 ? 0 : Math.min(list.length - 1, current + 1);
      else if (key === "ArrowUp" || key === "k") next = current < 0 ? 0 : Math.max(0, current - 1);
      else if (key === "Home") next = 0;
      else if (key === "End") next = list.length - 1;
      else if (key === "Enter") {
        if (current < 0) return;
        e.preventDefault();
        e.stopPropagation();
        list[current].click();
        return;
      } else if ((key === "ArrowRight" || key === "ArrowLeft") && current >= 0) {
        const row = list[current];
        const collapsed = row.dataset.collapsed;
        if (collapsed && (collapsed === "true") === (key === "ArrowRight")) {
          e.preventDefault();
          e.stopPropagation();
          row.querySelector<HTMLElement>("[data-toggle]")?.click();
        }
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      list[next].focus();
      list[next].scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, docked, unpinPreview]);

  if (!open) return null;

  const close = () => set({ sidebarOpen: false });
  const go = (v: View, sid?: number | null) => {
    openThread(null);
    set({ searchOpen: false, searchQuery: "" });
    setView(v, sid);
    close();
  };
  const openPanel = (panel: PanelKind) => {
    set({ panel, sidebarOpen: false });
  };
  const goLabel = (id: number) => {
    openThread(null);
    set({ searchOpen: false, searchQuery: "" });
    selectLabel(id);
    close();
  };
  const goFolder = (id: number) => {
    openThread(null);
    set({ searchOpen: false, searchQuery: "" });
    selectFolder(id);
    close();
  };

  const active = accounts?.find((a) => a.id === accountFilter);
  const inboxActive = view === "inbox";

  return (
    <div className={docked ? "relative z-20 h-full w-[272px] shrink-0" : "absolute inset-0 z-40 overflow-hidden"} onMouseDown={docked ? undefined : close}>
      {!docked && <div className="absolute inset-0 bg-bg0/40" />}
      <aside
        ref={asideRef}
        aria-label={t("common:topbar.menu")}
        className={`relative flex h-full w-[272px] max-w-full flex-col overflow-hidden border-r border-hairline bg-bg1 ${docked ? "" : unpinPreview ? "shadow-elev-2" : "co-sidebar-enter shadow-elev-2"}`}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerLeave={(e) => {
          if (unpinPreview && !docked && e.pointerType !== "touch") close();
        }}
      >
        <div data-sidebar-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
        <button
          data-nav
          className={`mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-bg2 ${NAV_FOCUS}`}
          title={t("common:sidebar.accountSettings")}
          onClick={() => set({ panel: "settings", settingsTab: "accounts", sidebarOpen: false })}
        >
          <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">
            {active ? active.email : t("common:topbar.allAccounts")}
          </span>
          <Icon name="chevronRight" size={12} className="shrink-0 text-ink-faint" />
        </button>

        {/* Inbox + splits */}
        <SideRow
          label={t("common:view.inbox")}
          active={inboxActive && splitId == null && labelFilter == null}
          badge={counts?.inbox || undefined}
          onClick={() => go("inbox", null)}
        />
        {/* Same order as the tab bar (lib/splitOrder). Rules routed into an
            existing tab own no tab, so they get no row either. */}
        <div className="mb-1">
          {inboxTabOrder(splits, labels, autoLabelsEnabled).map((item) => {
            if (item.kind === "important" || item.kind === "other") {
              const sid = item.kind === "important" ? SPLIT_IMPORTANT : SPLIT_OTHER;
              return (
                <SideRow
                  key={item.kind}
                  label={t(`inbox:split.${item.kind}`)}
                  active={inboxActive && labelFilter == null && splitId === sid}
                  badge={counts?.[item.kind] || undefined}
                  indent
                  onClick={() => go("inbox", sid)}
                />
              );
            }
            if (item.kind === "split") {
              return (
                <SideRow
                  key={`split-${item.id}`}
                  label={item.name}
                  active={inboxActive && labelFilter == null && splitId === item.id}
                  badge={splitCount(counts, item.id) || undefined}
                  indent
                  onClick={() => go("inbox", item.id)}
                />
              );
            }
            return (
              <SideRow
                key={`auto-${item.id}`}
                label={item.name}
                active={inboxActive && labelFilter === item.id}
                dotColor={item.label.color}
                badge={counts?.labels[String(item.id)] || undefined}
                indent
                onClick={() => {
                  openThread(null);
                  set({
                    calendarScreen: false,
                    view: "inbox",
                    splitId: null,
                    labelFilter: item.id,
                    folderFilter: null,
                    searchOpen: false,
                    searchQuery: "",
                    selection: [],
                    selectedIndex: 0,
                    selectedThreadId: null,
                    sidebarOpen: false,
                  });
                }}
              />
            );
          })}
        </div>

        {VIEWS.map((v) => (
          <SideRow
            key={v}
            label={t(`common:view.${v}`)}
            active={view === v && labelFilter == null && folderFilter == null}
            badge={counts?.views[v] || undefined}
            onClick={() => go(v)}
          />
        ))}

        {folderTree.length > 0 && (
          <>
            <div className="co-hairline-b mx-4 my-2.5" />
            <div className="px-4 pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {t("common:sidebar.folders")}
            </div>
            <FolderTree
              nodes={folderTree}
              depth={0}
              folderFilter={folderFilter}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
              onSelect={goFolder}
            />
          </>
        )}

        <div className="co-hairline-b mx-4 my-2.5" />
        <div className="px-4 pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
          {t("common:sidebar.calendar")}
        </div>
        <SideRow
          label={t("calendar:today")}
          kbd="0"
          onClick={() => set({ calendarDrawer: "day", calendarFocusDay: null, sidebarOpen: false })}
        />
        <SideRow
          label={t("calendar:thisWeek")}
          kbd="2"
          onClick={() =>
            set({
              calendarScreen: true,
              calendarDrawer: null,
              calendarFocusDay: null,
              sidebarOpen: false,
            })
          }
        />
        <SideRow
          label={t("calendar:create.title")}
          kbd="B"
          onClick={() => set({ eventCreate: {}, sidebarOpen: false })}
        />

        {(labels ?? []).filter((l) => !l.isAuto).length > 0 && (
          <>
            <div className="co-hairline-b mx-4 my-2.5" />
            <div className="px-4 pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {t("common:sidebar.labels")}
            </div>
            {(labels ?? []).filter((l) => !l.isAuto).map((l) => (
              <SideRow
                key={l.id}
                label={l.name}
                active={labelFilter === l.id}
                dotColor={l.color}
                badge={counts?.labels[String(l.id)] || undefined}
                onClick={() => goLabel(l.id)}
              />
            ))}
          </>
        )}

        <div className="co-hairline-b mx-4 my-2.5" />

        <SideRow
          label={t("common:sidebar.snippets")}
          onClick={() => set({ panel: "settings", settingsTab: "snippets", sidebarOpen: false })}
        />
        <SideRow
          label={t("common:sidebar.splits")}
          onClick={() => set({ panel: "settings", settingsTab: "splits", sidebarOpen: false })}
        />
        <SideRow
          label={t("common:sidebar.manageLabels")}
          onClick={() => set({ panel: "settings", settingsTab: "labels", sidebarOpen: false })}
        />
        <SideRow label={t("common:sidebar.settings")} onClick={() => openPanel("settings")} />
        </div>
        <div className="shrink-0 border-t border-hairline bg-bg1 p-2">
          <button
            type="button"
            data-sidebar-control
            aria-pressed={pinned}
            title={t(pinned ? "common:sidebar.unpin" : "common:sidebar.pin")}
            className={`flex w-full items-center gap-2 rounded-control px-2 py-2 text-sm text-ink-muted hover:bg-bg2 ${NAV_FOCUS}`}
            onClick={() => {
              setUnpinPreview(docked && pinned);
              set({ sidebarPinned: !pinned, sidebarOpen: true });
            }}
          >
            <Icon name={pinned ? "pushpinOff" : "pushpin"} size={16} />
            {t(pinned ? "common:sidebar.unpin" : "common:sidebar.pin")}
          </button>
        </div>
      </aside>
    </div>
  );
}

// Keyboard-focus ring for drawer rows (keeps the active row's own background).
const NAV_FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-accent/60";

function SideRow({
  label,
  active,
  indent,
  badge,
  dotColor,
  kbd,
  onClick,
}: {
  label: string;
  active?: boolean;
  indent?: boolean;
  badge?: number;
  dotColor?: string;
  /** keyboard hint shown on the right */
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <button
      data-nav
      data-active={active ? "true" : undefined}
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-control py-1.5 pe-3 text-start text-base ${NAV_FOCUS} ${
        indent ? "ps-7" : "ps-3"
      } ${
        active
          ? "bg-[var(--selected-bg)] font-medium text-ink"
          : "text-ink-muted hover:bg-bg2 hover:text-ink"
      }`}
      onClick={onClick}
    >
      {dotColor && (
        <span className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 text-xs text-ink-faint tabular-nums">{badge}</span>
      )}
      {kbd && <span className="co-kbd shrink-0">{kbd}</span>}
    </button>
  );
}

/** Recursive nested list of user IMAP folders. */
function FolderTree({
  nodes,
  depth,
  folderFilter,
  collapsed,
  onToggle,
  onSelect,
}: {
  nodes: FolderNode[];
  depth: number;
  folderFilter: number | null;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (folderId: number) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.key);
        return (
          <div key={node.key}>
            <FolderRow
              name={node.name}
              depth={depth}
              active={node.folder != null && folderFilter === node.folder.id}
              expandable={hasChildren}
              collapsed={isCollapsed}
              onToggle={() => onToggle(node.key)}
              onClick={() => {
                if (node.folder) onSelect(node.folder.id);
                else if (hasChildren) onToggle(node.key);
              }}
            />
            {hasChildren && !isCollapsed && (
              <FolderTree
                nodes={node.children}
                depth={depth + 1}
                folderFilter={folderFilter}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FolderRow({
  name,
  depth,
  active,
  expandable,
  collapsed,
  onToggle,
  onClick,
}: {
  name: string;
  depth: number;
  active: boolean;
  expandable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
}) {
  return (
    <button
      data-nav
      data-active={active ? "true" : undefined}
      data-collapsed={expandable ? String(collapsed) : undefined}
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-control py-1.5 pr-3 text-left text-base ${NAV_FOCUS} ${
        active
          ? "bg-[var(--selected-bg)] font-medium text-ink"
          : "text-ink-muted hover:bg-bg2 hover:text-ink"
      }`}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={onClick}
    >
      {expandable ? (
        <span
          role="button"
          data-toggle
          tabIndex={-1}
          aria-label="Toggle folder"
          className="grid size-4 shrink-0 place-items-center rounded text-ink-faint hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <Icon name="chevronRight" size={10} className={collapsed ? undefined : "rotate-90"} />
        </span>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <Icon name="folder" size={13} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </button>
  );
}
