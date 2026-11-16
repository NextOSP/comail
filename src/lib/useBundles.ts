import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  splitCount,
  useInboxBundles,
  useLabels,
  useSettings,
  useSplits,
  useUnreadCounts,
} from "../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../stores/ui";
import type { Bundle, BundleTab } from "./listItems";
import { inboxTabOrder } from "./splitOrder";

/**
 * Avatar inbox UI: every other tab collapses into a bundle row inside the
 * Important list (Settings → Show other tabs as bundles turns it off). With
 * inline bundles on, bundles sit among the threads by their newest mail and
 * open in place. Shared by the list and ThreadOrderSync so J/K walks the
 * threads of expanded bundles in display order.
 */
export function useBundles(): { bundles: Bundle[]; show: boolean; inline: boolean } {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const accountFilter = useUi((s) => s.accountFilter);
  const labelFilter = useUi((s) => s.labelFilter);
  const folderFilter = useUi((s) => s.folderFilter);
  const { data: settings } = useSettings();
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();

  const show =
    settings?.inboxUi === "avatar" &&
    settings?.showBundles !== false &&
    view === "inbox" &&
    splitId === SPLIT_IMPORTANT &&
    labelFilter == null &&
    folderFilter == null;
  const autoLabelsEnabled = settings?.autoLabelsEnabled !== false;
  const tabs = useMemo<BundleTab[]>(() => {
    if (!show) return [];
    const labelColor = (id: number) => labels?.find((l) => l.id === id)?.color;
    return inboxTabOrder(splits, labels, autoLabelsEnabled).flatMap((item): BundleTab[] => {
      if (item.kind === "important") return [];
      if (item.kind === "other") return [{ key: "other", name: t("inbox:split.other"), splitId: SPLIT_OTHER }];
      if (item.kind === "split") {
        // A split filed by one label (e.g. an AI-applied topic) takes that label's color.
        const cond = item.rule.condition;
        const color = cond?.kind === "label" ? labelColor(cond.id) : undefined;
        return [{ key: `s${item.id}`, name: item.name, splitId: item.id, color }];
      }
      return [{ key: `l${item.id}`, name: item.name, labelId: item.id, color: item.label.color }];
    });
  }, [show, splits, labels, autoLabelsEnabled, t]);
  const pages = useInboxBundles(tabs, accountFilter, show);
  const { data: counts } = useUnreadCounts(accountFilter, show);
  const bundles = useMemo<Bundle[]>(
    () =>
      tabs.flatMap((tab, i) => {
        const page = pages[i];
        if (!page || page.threads.length === 0) return [];
        const count =
          tab.labelId != null ? counts?.labels[String(tab.labelId)] : splitCount(counts, tab.splitId ?? null);
        // A count-all split's badge includes read mail, so it can't say whether
        // anything is unread; the loaded threads can.
        const countAll = splits?.find((s) => s.id === tab.splitId)?.countAll === true;
        const unread = countAll ? page.threads.some((th) => th.unreadCount > 0) : (count ?? 0) > 0;
        return [{ ...tab, count, unread, threads: page.threads, hasMore: page.nextCursor != null }];
      }),
    [tabs, pages, counts, splits],
  );
  return { bundles, show, inline: show && settings?.inlineBundles === true };
}
