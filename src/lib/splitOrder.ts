import type { Label, SplitRule } from "../ipc/types";

/** One reorderable inbox tab: a custom split or an auto-label tab. */
export type OrderedTab =
  | { kind: "split"; id: number; name: string; position: number; rule: SplitRule }
  | { kind: "label"; id: number; name: string; position: number; label: Label };

export type InboxTabOrderItem =
  | { kind: "important" }
  | OrderedTab
  | { kind: "other" };

/**
 * Merge custom splits and auto-label tabs into the single shared order the tab
 * bar and Settings both render.
 *
 * Positions were historically two independent 0-based spaces (splits and
 * auto-labels each starting at 0), which the tab bar showed as "all splits, then
 * all labels". A user reorder now writes ONE dup-free 0..N-1 sequence across
 * both sets (see `reorder_tabs`). So we distinguish the two states by looking
 * for a position shared between the sets: if one exists we are still in the
 * legacy state and keep the grouped default; otherwise we honor the global
 * position, which preserves any interleaving the user set up.
 */
export function mergeTabOrder(
  splits: SplitRule[] | undefined,
  labels: Label[] | undefined,
): OrderedTab[] {
  const splitItems: OrderedTab[] = (splits ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ kind: "split", id: r.id, name: r.name, position: r.position, rule: r }));
  const labelItems: OrderedTab[] = (labels ?? [])
    .filter((l) => l.isAuto)
    .sort((a, b) => a.position - b.position)
    .map((l) => ({ kind: "label", id: l.id, name: l.name, position: l.position, label: l }));

  const collides = splitItems.some((s) => labelItems.some((l) => l.position === s.position));
  if (collides) return [...splitItems, ...labelItems];
  return [...splitItems, ...labelItems].sort((a, b) => a.position - b.position);
}

/** Complete inbox tab order shared by rendering, direct hotkeys, and cycling. */
export function inboxTabOrder(
  splits: SplitRule[] | undefined,
  labels: Label[] | undefined,
  autoLabelsEnabled: boolean,
): InboxTabOrderItem[] {
  return [
    { kind: "important" },
    ...mergeTabOrder(splits, autoLabelsEnabled ? labels : []),
    { kind: "other" },
  ];
}
