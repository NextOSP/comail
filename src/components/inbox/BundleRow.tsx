import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Address, ThreadSummary } from "../../ipc/types";
import { addressName, primaryCorrespondent } from "../../lib/format";
import type { Bundle } from "../../lib/listItems";
import { Icon } from "../ui/Icon";
import { Avatar } from "./Avatar";

const MAX_SENDERS = 5;

/** Distinct correspondents of the newest threads, newest first. */
function bundleSenders(
  threads: ThreadSummary[],
  selfEmails: Set<string>,
): { address: Address; unread: boolean }[] {
  const seen = new Map<string, { address: Address; unread: boolean }>();
  for (const th of threads) {
    const a = primaryCorrespondent(th.participants, selfEmails);
    if (!a) continue;
    const key = a.email.toLowerCase();
    const prev = seen.get(key);
    if (prev) {
      prev.unread ||= th.unreadCount > 0;
      continue;
    }
    if (seen.size >= MAX_SENDERS) continue;
    seen.set(key, { address: a, unread: th.unreadCount > 0 });
  }
  return [...seen.values()];
}

/** Newest subjects shown on an inline bundle row. */
const MAX_SUBJECTS = 3;

function BundleRowImpl({
  bundle,
  selfEmails,
  photos,
  expanded,
  onOpen,
}: {
  bundle: Bundle;
  selfEmails: Set<string>;
  photos: boolean;
  /** Inline bundles: whether the bundle is open in place. Undefined = the row
   *  opens the bundle's tab and previews its senders. */
  expanded?: boolean;
  onOpen: (bundle: Bundle) => void;
}) {
  const { t } = useTranslation();
  const { unread } = bundle;
  const count = bundle.count ?? 0;
  const inline = expanded !== undefined;

  return (
    <div
      role={inline ? "button" : undefined}
      aria-expanded={inline ? expanded : undefined}
      className="co-row flex h-full cursor-default items-center gap-3 pr-5 pl-4"
      onClick={() => onOpen(bundle)}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {unread && <span className="size-2 rounded-full bg-info" />}
      </span>
      <span className="flex size-6 shrink-0 items-center justify-center text-ink-muted">
        {inline && bundle.color ? (
          <span className="size-3 rounded-sm" style={{ backgroundColor: bundle.color }} aria-hidden />
        ) : (
          <Icon name={/news/i.test(bundle.name) ? "news" : "bell"} size={15} />
        )}
      </span>
      <span className="flex w-48 shrink-0 items-baseline gap-1.5 truncate">
        <span className={`truncate text-base ${unread ? "font-medium text-ink" : "text-ink-muted"}`}>
          {bundle.name}
        </span>
        {count > 0 && <span className="text-xs text-ink-faint tabular-nums">{count}</span>}
        {inline && (
          <span className="self-center text-ink-faint">
            <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
          </span>
        )}
      </span>
      {inline ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-base whitespace-nowrap">
          {bundle.threads.slice(0, MAX_SUBJECTS).map((th, i) => (
            <span key={th.id} className="flex min-w-0 shrink items-center gap-2">
              {i > 0 && <span className="text-ink-faint" aria-hidden>|</span>}
              <span className={`truncate ${th.unreadCount > 0 ? "font-medium text-ink" : "text-ink-muted"}`}>
                {th.subject || t("inbox:pane.noSubject")}
              </span>
            </span>
          ))}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
          {bundleSenders(bundle.threads, selfEmails).map((s) => (
            <span key={s.address.email} className="flex shrink-0 items-center gap-1.5 text-base text-ink">
              <span className={`size-1.5 rounded-full ${s.unread ? "bg-info" : "bg-transparent"}`} />
              <Avatar address={s.address} size={16} photo={photos} />
              <span className={`max-w-[160px] truncate ${s.unread ? "font-medium" : "text-ink-muted"}`}>
                {addressName(s.address)}
              </span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export const BundleRow = memo(BundleRowImpl);
