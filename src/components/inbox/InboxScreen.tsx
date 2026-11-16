import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  flattenThreads,
  useAccounts,
  useFolders,
  useLabels,
  useSettings,
  useSplits,
  useThreads,
} from "../../queries/hooks";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "../../stores/ui";
import { accountColor, accountShortName } from "../../lib/format";
import { folderLeafName } from "../../lib/folders";
import { inlineThreadOrder, type Bundle } from "../../lib/listItems";
import { useBundles } from "../../lib/useBundles";
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

  const avatarUi = settings?.inboxUi === "avatar";
  const { bundles, show: showBundles, inline } = useBundles();
  const expandedBundles = useUi((s) => s.expandedBundles);
  const toggleBundle = useUi((s) => s.toggleBundle);
  // Inline: expanded bundles' threads join the list, in display order, so the
  // cursor, selection and J/K treat them like any other row.
  const listThreads = useMemo(
    () => (inline ? inlineThreadOrder(threads, bundles, expandedBundles) : threads),
    [inline, threads, bundles, expandedBundles],
  );
  const openBundle = useCallback(
    (b: Bundle) => (inline ? toggleBundle(b.key) : selectInboxTab(b)),
    [inline, toggleBundle, selectInboxTab],
  );

  const empty = !query.isLoading && threads.length === 0 && bundles.length === 0;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <ReauthBanner />
      {view === "inbox" && !inline && <SplitTabs />}

      {empty ? (
        <InboxZero viewTitle={emptyTitle} />
      ) : (
        <ThreadList
          threads={listThreads}
          selfEmails={selfEmails}
          labelMap={labelMap}
          accountMeta={accountFilter == null ? accountMeta : undefined}
          onEndReached={onEndReached}
          isFetchingMore={query.isFetchingNextPage}
          groupByDate={settings?.groupByDate ?? true}
          layout={settings?.inboxUi}
          photos={avatarUi && (settings?.showSenderPhotos ?? true)}
          bundles={showBundles ? bundles : undefined}
          inlineBundles={inline ? expandedBundles : undefined}
          onOpenBundle={openBundle}
          onShowAllBundle={selectInboxTab}
        />
      )}
      {view === "inbox" && <TipsBar />}
    </div>
  );
}
