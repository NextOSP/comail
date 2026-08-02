import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { flattenThreads, useAccounts, useFolders, useLabels, useSettings, useThreads } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { accountColor, accountShortName } from "../../lib/format";
import { folderLeafName } from "../../lib/folders";
import { ReauthBanner } from "../common/ReauthBanner";
import { InboxZero } from "./InboxZero";
import { SplitTabs } from "./SplitTabs";
import { ThreadList } from "./ThreadList";

export function InboxScreen() {
  const { t } = useTranslation();
  const view = useUi((s) => s.view);
  const splitId = useUi((s) => s.splitId);
  const accountFilter = useUi((s) => s.accountFilter);
  const labelFilter = useUi((s) => s.labelFilter);
  const folderFilter = useUi((s) => s.folderFilter);

  const { data: accounts } = useAccounts();
  const { data: labels } = useLabels();
  const { data: settings } = useSettings();
  const { data: folders } = useFolders(accountFilter);
  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const labelMap = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  // Per-account color + short name so unified-inbox rows show which account a
  // thread belongs to. Omitted with a single account or when filtered to one.
  const accountColors = settings?.accountColors;
  const accountShortNames = settings?.accountShortNames;
  const accountMeta = useMemo(() => {
    if ((accounts ?? []).length < 2) return undefined;
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
  }, [accounts, accountColors, accountShortNames]);

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

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const empty = !query.isLoading && threads.length === 0;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <ReauthBanner />
      {view === "inbox" && <SplitTabs />}

      {empty ? (
        <InboxZero viewTitle={viewTitle} />
      ) : (
        <ThreadList
          threads={threads}
          selfEmails={selfEmails}
          labelMap={labelMap}
          accountMeta={accountFilter == null ? accountMeta : undefined}
          onEndReached={onEndReached}
          isFetchingMore={query.isFetchingNextPage}
          groupByDate={settings?.groupByDate ?? true}
        />
      )}
    </div>
  );
}
