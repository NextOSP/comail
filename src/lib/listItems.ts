import type { ThreadSummary } from "../ipc/types";
import { dateGroup, longDate } from "./format";

/** One inbox tab (other than Important) to preview as a bundle row. */
export type BundleTab = { key: string; name: string; splitId?: number; labelId?: number };

/** A non-Important inbox tab collapsed into one comfortable-list row. */
export type Bundle = BundleTab & { unread?: number; threads: ThreadSummary[] };

/** One virtualized row: a date header, a bundle, or a thread. Every item
 *  occupies one full row height so the list stays uniform-height (keeps the
 *  cursor + gutter-sweep math simple). */
export type ListItem =
  | { kind: "header"; key: string; label: string; subtitle?: string }
  | { kind: "bundle"; bundle: Bundle }
  | { kind: "thread"; thread: ThreadSummary };

/** A header to show directly above one thread (search result groups). */
export type SectionHeader = { label: string; subtitle?: string };

/** Interleave date-group headers into the thread rows. When grouping is off the
 *  result is just the threads, one item each - identical to the old behavior -
 *  plus any `sections` headers, each placed above the thread id it is keyed by.
 *  Bundles always lead the list, above the first date header. */
export function buildListItems(
  threads: ThreadSummary[],
  grouped: boolean,
  bundles: Bundle[] = [],
  now = Date.now(),
  sections?: ReadonlyMap<number, SectionHeader>,
): ListItem[] {
  const bundleItems: ListItem[] = bundles.map((bundle) => ({ kind: "bundle", bundle }));
  if (!grouped) {
    const items: ListItem[] = [...bundleItems];
    for (const thread of threads) {
      const header = sections?.get(thread.id);
      if (header) items.push({ kind: "header", key: `s-${thread.id}`, ...header });
      items.push({ kind: "thread", thread });
    }
    return items;
  }
  const items: ListItem[] = [...bundleItems];
  let lastKey: string | null = null;
  for (const thread of threads) {
    const g = dateGroup(thread.lastMessageAt, now);
    if (g.key !== lastKey) {
      items.push({
        kind: "header",
        key: g.key,
        label: g.label,
        subtitle: g.key === "today" ? longDate(thread.lastMessageAt) : undefined,
      });
      lastKey = g.key;
    }
    items.push({ kind: "thread", thread });
  }
  return items;
}
