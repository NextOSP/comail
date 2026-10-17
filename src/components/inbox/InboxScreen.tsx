import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  flattenThreads,
  splitCount,
  useAccounts,
  useFolders,
  useInboxBundles,
  useLabels,
  useSettings,
  useSplits,
  useThreads,
  useUnreadCounts,
} from "../../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../../stores/ui";
import { accountColor, accountShortName } from "../../lib/format";
import { folderLeafName } from "../../lib/folders";
import { inboxTabOrder } from "../../lib/splitOrder";
import type { Bundle, BundleTab } from "../../lib/listItems";
import { ReauthBanner } from "../common/ReauthBanner";
import { InboxZero } from "./InboxZero";
import { SplitTabs } from "./SplitTabs";
import { ThreadList } from "./ThreadList";
import { TipsBar } from "./TipsBar";

export function InboxScreen() {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const accountFilter = useUi((s) => s.accountFilter);
  const labelFilter = useUi((s) => s.labelFilter);
  const folderFilter = useUi((s) => s.folderFilter);
  const selectInboxTab = useUi((s) => s.selectInboxTab);

  const { data: accounts } = useAccounts();
  const { data: labels } = useLabels();
  const { data: settings } = useSettings();
  const { data: folders } = useFolders(accountFilter);
  const { data: splits } = useSplits();
  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const labelMap = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  // Per-account color + short name so unified-inbox rows show which account a
  // thread belongs to. Omitted with a single account or when filtered to one.
  const accountColors = settings?.accountColors;
  const accountShortNames = settings?.accountShortNames;
  const showAccountBadges = settings?.showAccountBadges ?? true;
  const accountMeta = useMemo(() => {
    if (!showAccountBadges || (accounts ?? []).length < 2) return undefined;
    return new Map(
      (accounts ?? []).map((a) => [
        a.id,
        {
          color: accountColor(a, accountColors),
          name: accountShortName(a, accountShortNames),
          email: a.email,
        },
      ]),
    );
  }, [accounts, accountColors, accountShortNames, showAccountBadges]);

  const query = useThreads(
    view,
    view === "inbox" ? splitId : null,
    accountFilter,
    labelFilter,
    folderFilter,
  );
  const threads = useMemo(() => flattenThreads(query.data), [query.data]);

  const activeFolder = folders?.find((f) => f.id === folderFilter);
  const viewTitle = activeFolder ? folderLeafName(activeFolder) : t(`common:view.${view}`);
  // Inbox zero names the tab the user is looking at ("Nothing in Newsletters"),
  // falling back to the view name for the unsplit inbox.
  const emptyTitle = useMemo(() => {
    if (view !== "inbox" || activeFolder) return viewTitle;
    if (labelFilter != null) return labels?.find((l) => l.id === labelFilter)?.name ?? viewTitle;
    if (splitId === SPLIT_IMPORTANT) return t("inbox:split.important");
    if (splitId === SPLIT_OTHER) return t("inbox:split.other");
    if (splitId != null) return splits?.find((s) => s.id === splitId)?.name ?? viewTitle;
    return viewTitle;
  }, [view, activeFolder, viewTitle, labelFilter, labels, splitId, splits, t]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Avatar inbox UI: every other tab collapses into a bundle row at the top of
  // the Important list (Settings → Show other tabs at the top turns it off).
  const avatarUi = settings?.inboxUi === "avatar";
  const showBundles =
    avatarUi &&
    settings?.showBundles !== false &&
    view === "inbox" &&
    splitId === SPLIT_IMPORTANT &&
    labelFilter == null &&
    folderFilter == null;
  const autoLabelsEnabled = settings?.autoLabelsEnabled !== false;
  const bundleTabs = useMemo<BundleTab[]>(() => {
    if (!showBundles) return [];
    return inboxTabOrder(splits, labels, autoLabelsEnabled).flatMap((item): BundleTab[] => {
      if (item.kind === "important") return [];
      if (item.kind === "other") return [{ key: "other", name: t("inbox:split.other"), splitId: SPLIT_OTHER }];
      if (item.kind === "split") return [{ key: `s${item.id}`, name: item.name, splitId: item.id }];
      return [{ key: `l${item.id}`, name: item.name, labelId: item.id }];
    });
  }, [showBundles, splits, labels, autoLabelsEnabled, t]);
  const bundleData = useInboxBundles(bundleTabs, accountFilter, showBundles);
  const { data: counts } = useUnreadCounts(accountFilter, showBundles);
  const bundles = useMemo<Bundle[]>(
    () =>
      bundleTabs.flatMap((tab, i) => {
        const page = bundleData[i];
        if (!page || page.threads.length === 0) return [];
        const unread =
          tab.labelId != null ? counts?.labels[String(tab.labelId)] : splitCount(counts, tab.splitId ?? null);
        return [{ ...tab, unread, threads: page.threads }];
      }),
    [bundleTabs, bundleData, counts],
  );
  const openBundle = useCallback((b: Bundle) => selectInboxTab(b), [selectInboxTab]);

  const empty = !query.isLoading && threads.length === 0 && bundles.length === 0;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <ReauthBanner />
      {view === "inbox" && <SplitTabs />}

      {empty ? (
        <InboxZero viewTitle={emptyTitle} />
      ) : (
        <ThreadList
          threads={threads}
          selfEmails={selfEmails}
          labelMap={labelMap}
          accountMeta={accountFilter == null ? accountMeta : undefined}
          onEndReached={onEndReached}
          isFetchingMore={query.isFetchingNextPage}
          groupByDate={settings?.groupByDate ?? true}
          layout={settings?.inboxUi}
          photos={avatarUi && (settings?.showSenderPhotos ?? true)}
          bundles={showBundles ? bundles : undefined}
          onOpenBundle={openBundle}
        />
      )}
      {view === "inbox" && <TipsBar />}
    </div>
  );
}
