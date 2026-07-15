import { useTranslation } from "react-i18next";
import { inboxTabOrder } from "../../lib/splitOrder";
import { useModHeld } from "../../lib/useModHeld";
import { splitCount, useLabels, useSettings, useSplits, useUnreadCounts } from "../../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../../stores/ui";

export function SplitTabs() {
  const { t } = useTranslation();
  const splitId = useUi((s) => s.splitId);
  const labelFilter = useUi((s) => s.labelFilter);
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const { data: settings } = useSettings();
  const { data: counts } = useUnreadCounts(accountFilter);
  // While ⌘/Ctrl is held, reveal each tab's jump-to number (Cmd+1..9).
  const modHeld = useModHeld();

  const tabs: { key: string; name: string; splitId?: number; labelId?: number }[] = inboxTabOrder(
    splits,
    labels,
    settings?.autoLabelsEnabled !== false,
  ).map((item) => {
    if (item.kind === "important")
      return { key: "important", name: t("inbox:split.important"), splitId: SPLIT_IMPORTANT };
    if (item.kind === "other")
      return { key: "other", name: t("inbox:split.other"), splitId: SPLIT_OTHER };
    if (item.kind === "split")
      return { key: `s${item.id}`, name: item.name, splitId: item.id };
    return { key: `l${item.id}`, name: item.name, labelId: item.id };
  });

  const activeKey =
    labelFilter != null
      ? `l${labelFilter}`
      : splitId === SPLIT_OTHER
        ? "other"
        : splitId != null && splitId > 0
          ? `s${splitId}`
          : "important";

  return (
    <div className="co-glass relative z-10 flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden px-4">
      {tabs.map((tab, index) => (
        <SplitTab
          key={tab.key}
          name={tab.name}
          unread={
            tab.labelId != null
              ? counts?.labels[String(tab.labelId)]
              : splitCount(counts, tab.splitId ?? null)
          }
          keyHint={modHeld && index < 9 ? String(index + 1) : undefined}
          active={activeKey === tab.key}
          onClick={() =>
            set({
              splitId: tab.splitId ?? null,
              labelFilter: tab.labelId ?? null,
              folderFilter: null,
              selectedIndex: 0,
              selectedThreadId: null,
              selection: [],
            })
          }
        />
      ))}
      <span className="ml-auto pb-1 text-[11px] whitespace-nowrap text-ink-faint">{t("common:splitTabs.tabToSwitch")}</span>
    </div>
  );
}

function SplitTab({
  name,
  unread,
  keyHint,
  active,
  onClick,
}: {
  name: string;
  unread: number | undefined;
  /** jump-to number shown (in place of the unread count) while ⌘/Ctrl is held */
  keyHint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      tabIndex={-1}
      className={`relative flex items-center gap-1.5 px-3 pt-2.5 pb-2 text-[13px] transition-colors ${
        active ? "font-semibold text-ink" : "text-ink-faint hover:text-ink-muted"
      }`}
    >
      {name}
      {keyHint ? (
        <span className="co-kbd">{keyHint}</span>
      ) : (
        (unread ?? 0) > 0 && (
          <span
            className={`min-w-[18px] rounded-full px-1.5 py-px text-center text-[10.5px] font-semibold tabular-nums ${
              active ? "bg-accent/15 text-accent" : "bg-bg2 text-ink-faint"
            }`}
          >
            {unread}
          </span>
        )
      )}
      {active && (
        <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />
      )}
    </button>
  );
}
