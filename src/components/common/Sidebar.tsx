import { useEffect, useMemo, useState } from "react";
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
export function Sidebar() {
  const { t } = useTranslation();
  const open = useUi((s) => s.sidebarOpen);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().set({ sidebarOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

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
    <div className="fixed inset-0 z-40" onMouseDown={close}>
      <div className="absolute inset-0 bg-bg0/40" />
      <aside
        className="co-fade-in relative flex h-full w-[272px] flex-col overflow-y-auto border-r border-hairline bg-bg1 py-3 shadow-elev-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-bg2"
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
      </aside>
    </div>
  );
}

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
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-control py-1.5 pe-3 text-start text-base ${
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
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-control py-1.5 pr-3 text-left text-base ${
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
