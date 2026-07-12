import { useTranslation } from "react-i18next";
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

  const tabs: { key: string; name: string; splitId?: number; labelId?: number }[] = [
    { key: "important", name: t("inbox:split.important"), splitId: SPLIT_IMPORTANT },
    { key: "other", name: t("inbox:split.other"), splitId: SPLIT_OTHER },
    ...(splits ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ key: `s${s.id}`, name: s.name, splitId: s.id })),
    ...(settings?.autoLabelsEnabled !== false
      ? (labels ?? [])
          .filter((l) => l.isAuto)
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ key: `l${l.id}`, name: l.name, labelId: l.id }))
      : []),
  ];

  const activeKey =
    labelFilter != null
      ? `l${labelFilter}`
      : splitId === SPLIT_OTHER
        ? "other"
        : splitId != null && splitId > 0
          ? `s${splitId}`
          : "important";

  return (
    <div className="co-hairline-b flex shrink-0 items-center gap-1 overflow-x-auto px-4">
      {tabs.map((tab) => (
        <SplitTab
          key={tab.key}
          name={tab.name}
          unread={
            tab.labelId != null
              ? counts?.labels[String(tab.labelId)]
              : splitCount(counts, tab.splitId ?? null)
          }
          active={activeKey === tab.key}
          onClick={() =>
            set({
              splitId: tab.splitId ?? null,
              labelFilter: tab.labelId ?? null,
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
  active,
  onClick,
}: {
  name: string;
  unread: number | undefined;
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
      {(unread ?? 0) > 0 && (
        <span
          className={`min-w-[18px] rounded-full px-1.5 py-px text-center text-[10.5px] font-semibold tabular-nums ${
            active ? "bg-accent/15 text-accent" : "bg-bg2 text-ink-faint"
          }`}
        >
          {unread}
        </span>
      )}
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent" />
      )}
    </button>
  );
}
