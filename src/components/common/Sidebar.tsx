import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "../../ipc/types";
import { splitCount, useAccounts, useLabels, useSplits, useUnreadCounts } from "../../queries/hooks";
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
  const setView = useUi((s) => s.setView);
  const selectLabel = useUi((s) => s.selectLabel);
  const openThread = useUi((s) => s.openThread);
  const set = useUi((s) => s.set);
  const { data: accounts } = useAccounts();
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const { data: counts } = useUnreadCounts(accountFilter, open);

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
          <span className="size-2 shrink-0 rounded-full" style={{ background: "var(--accent)" }} />
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
            active={view === v && labelFilter == null}
            badge={counts?.views[v] || undefined}
            onClick={() => go(v)}
          />
        ))}

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
