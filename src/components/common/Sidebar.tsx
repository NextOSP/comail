import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "../../ipc/types";
import { buildFolderTree, type FolderNode } from "../../lib/folders";
import {
  splitCount,
  useAccounts,
  useFolders,
  useLabels,
  useSplits,
  useUnreadCounts,
} from "../../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi, type PanelKind } from "../../stores/ui";

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
        className="co-fade-in relative flex h-full w-[272px] flex-col overflow-y-auto border-r border-hairline bg-bg1 py-3"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
          title={t("common:sidebar.accountSettings")}
          onClick={() => set({ panel: "settings", settingsTab: "accounts", sidebarOpen: false })}
        >
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {active ? active.email : t("common:topbar.allAccounts")}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-faint">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        {/* Inbox + splits */}
        <SideRow
          label={t("common:view.inbox")}
          active={inboxActive && splitId == null}
          badge={counts?.inbox || undefined}
          onClick={() => go("inbox", null)}
        />
        <div className="mb-1">
          <SideRow
            label={t("inbox:split.important")}
            active={inboxActive && splitId === SPLIT_IMPORTANT}
            badge={counts?.important || undefined}
            indent
            onClick={() => go("inbox", SPLIT_IMPORTANT)}
          />
          <SideRow
            label={t("inbox:split.other")}
            active={inboxActive && splitId === SPLIT_OTHER}
            badge={counts?.other || undefined}
            indent
            onClick={() => go("inbox", SPLIT_OTHER)}
          />
          {(splits ?? []).map((s) => (
            <SideRow
              key={s.id}
              label={s.name}
              active={inboxActive && splitId === s.id}
              badge={splitCount(counts, s.id) || undefined}
              indent
              onClick={() => go("inbox", s.id)}
            />
          ))}
          {(labels ?? [])
            .filter((l) => l.isAuto)
            .map((l) => (
              <SideRow
                key={`auto-${l.id}`}
                label={l.name}
                active={inboxActive && labelFilter === l.id}
                dotColor={l.color}
                badge={counts?.labels[String(l.id)] || undefined}
                indent
                onClick={() => {
                  openThread(null);
                  set({
                    view: "inbox",
                    splitId: null,
                    labelFilter: l.id,
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
            ))}
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
            <div className="px-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
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
        <div className="px-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
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
            <div className="px-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
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
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-md py-1.5 pr-3 text-left text-[13px] ${
        indent ? "pl-7" : "pl-3"
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
        <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">{badge}</span>
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
      className={`mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-md py-1.5 pr-3 text-left text-[13px] ${
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
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: collapsed ? "none" : "rotate(90deg)" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-ink-faint"
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </button>
  );
}
