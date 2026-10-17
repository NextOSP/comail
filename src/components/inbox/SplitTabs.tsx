import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { activeInboxTabKey, inboxTabOrder } from "../../lib/splitOrder";
import { useModHeld } from "../../lib/useModHeld";
import { splitCount, useLabels, useSettings, useSplits, useUnreadCounts } from "../../queries/hooks";
import { hasNewMail, useTabSeen } from "../../stores/tabSeen";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../../stores/ui";

export function SplitTabs() {
  const { t } = useTranslation();
  const splitId = useUi((s) => s.splitId);
  const labelFilter = useUi((s) => s.labelFilter);
  const accountFilter = useUi((s) => s.accountFilter);
  const selectInboxTab = useUi((s) => s.selectInboxTab);
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const { data: settings } = useSettings();
  const { data: counts } = useUnreadCounts(accountFilter);
  // While ⌘/Ctrl is held, reveal each tab's jump-to number (Cmd+1..9).
  const modHeld = useModHeld();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const autoLabels = settings?.autoLabelsEnabled !== false;
  const tabs = useMemo<{ key: string; name: string; splitId?: number; labelId?: number }[]>(
    () =>
      inboxTabOrder(splits, labels, autoLabels).map((item) => {
        if (item.kind === "important")
          return { key: "important", name: t("inbox:split.important"), splitId: SPLIT_IMPORTANT };
        if (item.kind === "other")
          return { key: "other", name: t("inbox:split.other"), splitId: SPLIT_OTHER };
        if (item.kind === "split")
          return { key: `s${item.id}`, name: item.name, splitId: item.id };
        return { key: `l${item.id}`, name: item.name, labelId: item.id };
      }),
    [splits, labels, autoLabels, t],
  );

  // null = the sidebar's unsplit "Inbox": no tab is highlighted (see activeInboxTabKey).
  const activeKey = activeInboxTabKey(splitId, labelFilter);
  // Roving tabindex: the active tab, or the first one while none is active.
  const focusKey = activeKey != null && tabs.some((tab) => tab.key === activeKey) ? activeKey : tabs[0]?.key;

  // Current unread per tab; only tabs whose count is known take part.
  const tabCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tab of tabs) {
      const n =
        tab.labelId != null
          ? counts?.labels[String(tab.labelId)]
          : splitCount(counts, tab.splitId ?? null);
      if (n != null) out[tab.key] = n;
    }
    return out;
  }, [tabs, counts]);

  // Remember what each tab's count was when last viewed, so mail landing in a
  // background tab (Other, Marketing, ...) gets a "new" dot until it's opened.
  const seenScope = accountFilter == null ? "all" : String(accountFilter);
  const seen = useTabSeen((s) => s.seen[seenScope]);
  const reconcile = useTabSeen((s) => s.reconcile);
  useEffect(() => {
    if (counts) reconcile(seenScope, tabCounts, activeKey ?? "");
  }, [counts, tabCounts, seenScope, activeKey, reconcile]);

  // Keep the active tab visible when switching by keyboard with many tabs.
  useEffect(() => {
    if (activeKey == null) return;
    tabRefs.current.get(activeKey)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  // WAI-ARIA tabs: arrows / Home / End move between tabs (and select them).
  // Handled here, with propagation stopped, so the global arrow-key thread
  // navigation doesn't also fire while a tab has focus.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = tabs.findIndex((tab) => tab.key === focusKey);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let next: number;
    if (e.key === "ArrowRight") next = cur + (rtl ? -1 : 1);
    else if (e.key === "ArrowLeft") next = cur + (rtl ? 1 : -1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const tab = tabs[(next + tabs.length) % tabs.length];
    if (!tab) return;
    selectInboxTab(tab);
    tabRefs.current.get(tab.key)?.focus();
  };

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden bg-bg1 px-5">
      <div
        role="tablist"
        aria-label={t("common:splitTabs.label")}
        className="flex items-center gap-1"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab, index) => (
          <SplitTab
            key={tab.key}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.key, el);
              else tabRefs.current.delete(tab.key);
            }}
            name={tab.name}
            unread={tabCounts[tab.key]}
            hasNew={activeKey !== tab.key && hasNewMail(seen, tab.key, tabCounts[tab.key] ?? 0)}
            keyHint={index < 9 ? String(index + 1) : undefined}
            showKeyHint={modHeld}
            active={activeKey === tab.key}
            focusable={focusKey === tab.key}
            onClick={() => selectInboxTab(tab)}
          />
        ))}
      </div>
      {/* Hidden on narrow windows, where the tabs need the room. */}
      <span className="ms-auto hidden pb-1 text-xs whitespace-nowrap text-ink-faint min-[900px]:inline">
        {t("common:splitTabs.tabToSwitch")}
      </span>
    </div>
  );
}

function SplitTab({
  ref,
  name,
  unread,
  hasNew,
  keyHint,
  showKeyHint,
  active,
  focusable,
  onClick,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  name: string;
  unread: number | undefined;
  /** mail arrived since the user last viewed this tab */
  hasNew: boolean;
  /** jump-to number (Cmd+1..9) */
  keyHint?: string;
  /** show the jump-to number in place of the unread count (⌘/Ctrl held) */
  showKeyHint: boolean;
  active: boolean;
  /** the roving-tabindex stop of the tablist */
  focusable: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const count = unread ?? 0;
  const hint = showKeyHint && keyHint;
  return (
    <button
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={focusable ? 0 : -1}
      title={name}
      // A click selects without moving focus, so Tab keeps cycling splits.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`relative flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-2.5 text-md whitespace-nowrap transition-colors ${
        active
          ? "text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
          : hasNew
            ? "text-ink-muted"
            : "text-ink-faint hover:text-ink-muted"
      }`}
    >
      {hasNew && (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="sr-only">{t("common:splitTabs.newMail")}</span>
        </>
      )}
      <span className="max-w-[16ch] truncate">{name}</span>
      {/* At rest a tab is just name + count. With a count, the jump-to number
          overlays it in one grid cell so holding ⌘/Ctrl doesn't shift tabs;
          a count-less tab shows the number only while held, so it never
          carries a blank placeholder. */}
      {count > 0 ? (
        <span className="grid shrink-0 items-center justify-items-end" aria-hidden>
          <span
            className={`text-sm text-ink-faint tabular-nums [grid-area:1/1] ${hint ? "invisible" : ""}`}
          >
            {count}
          </span>
          {keyHint && (
            <span className={`co-kbd [grid-area:1/1] ${hint ? "" : "invisible"}`}>{keyHint}</span>
          )}
        </span>
      ) : (
        hint && (
          <span className="co-kbd shrink-0" aria-hidden>
            {keyHint}
          </span>
        )
      )}
      {count > 0 && <span className="sr-only">{t("common:splitTabs.unread", { count })}</span>}
    </button>
  );
}
