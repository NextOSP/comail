import { memo } from "react";
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

function BundleRowImpl({
  bundle,
  selfEmails,
  photos,
  onOpen,
}: {
  bundle: Bundle;
  selfEmails: Set<string>;
  photos: boolean;
  onOpen: (bundle: Bundle) => void;
}) {
  const unread = (bundle.unread ?? 0) > 0;
  const senders = bundleSenders(bundle.threads, selfEmails);

  return (
    <div
      className="co-row flex h-full cursor-default items-center gap-3 pr-5 pl-4"
      onClick={() => onOpen(bundle)}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {unread && <span className="size-2 rounded-full bg-info" />}
      </span>
      <span className="flex size-6 shrink-0 items-center justify-center text-ink-muted">
        <Icon name={/news/i.test(bundle.name) ? "news" : "bell"} size={15} />
      </span>
      <span className="flex w-48 shrink-0 items-baseline gap-1.5 truncate">
        <span className={`truncate text-base ${unread ? "font-medium text-ink" : "text-ink-muted"}`}>
          {bundle.name}
        </span>
        {unread && <span className="text-xs text-ink-faint tabular-nums">{bundle.unread}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
        {senders.map((s) => (
          <span key={s.address.email} className="flex shrink-0 items-center gap-1.5 text-base text-ink">
            <span className={`size-1.5 rounded-full ${s.unread ? "bg-info" : "bg-transparent"}`} />
            <Avatar address={s.address} size={16} photo={photos} />
            <span className={`max-w-[160px] truncate ${s.unread ? "font-medium" : "text-ink-muted"}`}>
              {addressName(s.address)}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

export const BundleRow = memo(BundleRowImpl);
