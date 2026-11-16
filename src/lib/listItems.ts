import type { ThreadSummary } from "../ipc/types";
import { dateGroup, longDate } from "./format";

/** One inbox tab (other than Important) to preview as a bundle row. */
export type BundleTab = {
  key: string;
  name: string;
  splitId?: number;
  labelId?: number;
  /** Color of the label that fills this tab, when there is one. */
  color?: string;
};

/** A non-Important inbox tab collapsed into one comfortable-list row. */
/** `count` is the tab's badge; `unread` says whether to style the row unread.
 *  They differ for a split that badges every conversation (`countAll`).
 *  `threads` is the tab's newest page, newest first; `hasMore` says the tab
 *  holds more than that page. */
export type Bundle = BundleTab & {
  count?: number;
  unread: boolean;
  threads: ThreadSummary[];
  hasMore: boolean;
};

/** One virtualized row: a date header, a bundle, a thread, or the "show all"
 *  row closing an expanded bundle. Every item occupies one full row height so
 *  the list stays uniform-height (keeps the cursor + gutter-sweep math simple). */
export type ListItem =
  | { kind: "header"; key: string; label: string; subtitle?: string }
  | { kind: "bundle"; bundle: Bundle; expanded?: boolean }
  | { kind: "thread"; thread: ThreadSummary; nested?: boolean }
  | { kind: "bundleMore"; bundle: Bundle };

/** A header to show directly above one thread (search result groups). */
export type SectionHeader = { label: string; subtitle?: string };

/** Bundles placed among the threads by their newest mail, instead of above
 *  them. `expanded` holds the keys of bundles opened in place. */
export type InlineBundles = { expanded: ReadonlySet<string> };

type Entry = { at: number; bundle: Bundle } | { at: number; thread: ThreadSummary };

const newestAt = (b: Bundle) => b.threads[0]?.lastMessageAt ?? 0;

/** Threads and bundles in one newest-first sequence. Threads that belong to a
 *  bundle are dropped from `threads`: an expanded bundle lists them under its
 *  own row, and a collapsed one must not leak them while the list catches up. */
function inlineTimeline(threads: ThreadSummary[], bundles: Bundle[]): Entry[] {
  const nested = bundledThreadIds(bundles);
  const queue = bundles.filter((b) => b.threads.length > 0).sort((a, b) => newestAt(b) - newestAt(a));
  const out: Entry[] = [];
  let next = 0;
  for (const thread of threads) {
    if (nested.has(thread.id)) continue;
    while (next < queue.length && newestAt(queue[next]) >= thread.lastMessageAt) {
      out.push({ at: newestAt(queue[next]), bundle: queue[next++] });
    }
    out.push({ at: thread.lastMessageAt, thread });
  }
  for (; next < queue.length; next++) out.push({ at: newestAt(queue[next]), bundle: queue[next] });
  return out;
}

/** Ids of every thread previewed by a bundle. */
export function bundledThreadIds(bundles: Bundle[]): Set<number> {
  return new Set(bundles.flatMap((b) => b.threads.map((th) => th.id)));
}

/** Thread order of the inline-bundled list (what J/K walks): each expanded
 *  bundle's threads sit right after the threads newer than the bundle. */
export function inlineThreadOrder(
  threads: ThreadSummary[],
  bundles: Bundle[],
  expanded: ReadonlySet<string>,
): ThreadSummary[] {
  return inlineTimeline(threads, bundles).flatMap((e) =>
    "thread" in e ? [e.thread] : expanded.has(e.bundle.key) ? e.bundle.threads : [],
  );
}

/** Interleave date-group headers into the thread rows. When grouping is off the
 *  result is just the threads, one item each - identical to the old behavior -
 *  plus any `sections` headers, each placed above the thread id it is keyed by.
 *  Bundles lead the list, above the first date header, unless `inline` places
 *  them among the threads by their newest mail. */
export function buildListItems(
  threads: ThreadSummary[],
  grouped: boolean,
  bundles: Bundle[] = [],
  now = Date.now(),
  sections?: ReadonlyMap<number, SectionHeader>,
  inline?: InlineBundles,
): ListItem[] {
  if (inline) return buildInlineItems(threads, grouped, bundles, now, inline.expanded);
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
    lastKey = pushDateHeader(items, thread.lastMessageAt, lastKey, now);
    items.push({ kind: "thread", thread });
  }
  return items;
}

function buildInlineItems(
  threads: ThreadSummary[],
  grouped: boolean,
  bundles: Bundle[],
  now: number,
  expanded: ReadonlySet<string>,
): ListItem[] {
  const items: ListItem[] = [];
  let lastKey: string | null = null;
  for (const entry of inlineTimeline(threads, bundles)) {
    if (grouped) lastKey = pushDateHeader(items, entry.at, lastKey, now);
    if ("thread" in entry) {
      items.push({ kind: "thread", thread: entry.thread });
      continue;
    }
    const { bundle } = entry;
    const open = expanded.has(bundle.key);
    items.push({ kind: "bundle", bundle, expanded: open });
    if (!open) continue;
    for (const thread of bundle.threads) items.push({ kind: "thread", thread, nested: true });
    if (bundle.hasMore) items.push({ kind: "bundleMore", bundle });
  }
  return items;
}

/** Push a date header when `at` starts a new date group; returns the group key. */
function pushDateHeader(items: ListItem[], at: number, lastKey: string | null, now: number): string {
  const g = dateGroup(at, now);
  if (g.key !== lastKey) {
    items.push({
      kind: "header",
      key: g.key,
      label: g.label,
      subtitle: g.key === "today" ? longDate(at) : undefined,
    });
  }
  return g.key;
}
