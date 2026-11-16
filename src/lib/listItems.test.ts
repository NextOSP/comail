import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../ipc/types";
import { buildListItems, inlineThreadOrder, type Bundle, type ListItem } from "./listItems";

const NOW = new Date(2026, 9, 18, 15, 0).getTime();
const HOUR = 3_600_000;

const thread = (id: number, lastMessageAt: number): ThreadSummary => ({
  id,
  accountId: 1,
  accountEmail: "me@x.com",
  subject: `s${id}`,
  snippet: "",
  participants: [],
  lastMessageAt,
  messageCount: 1,
  unreadCount: 0,
  isStarred: false,
  hasAttachments: false,
  snoozedUntil: null,
  labels: [],
});

const bundle = (key: string, threads = [thread(99, NOW)], hasMore = false): Bundle => ({
  key,
  name: key,
  unread: false,
  threads,
  hasMore,
});

const shape = (items: ListItem[]) =>
  items.map((it) => {
    if (it.kind === "header") return `h:${it.key}`;
    if (it.kind === "bundle") return `b:${it.bundle.key}${it.expanded ? "+" : ""}`;
    if (it.kind === "bundleMore") return `more:${it.bundle.key}`;
    return `${it.nested ? "n" : "t"}:${it.thread.id}`;
  });

describe("buildListItems", () => {
  const today = [thread(1, NOW - HOUR), thread(2, NOW - 2 * HOUR)];
  const yesterday = [thread(3, NOW - 24 * HOUR)];

  it("is unchanged without bundles", () => {
    expect(shape(buildListItems([...today, ...yesterday], true, [], NOW))).toEqual([
      "h:today",
      "t:1",
      "t:2",
      "h:yesterday",
      "t:3",
    ]);
    expect(shape(buildListItems(today, false, [], NOW))).toEqual(["t:1", "t:2"]);
  });

  it("leads the list with bundles, above the first date header", () => {
    expect(shape(buildListItems([...today, ...yesterday], true, [bundle("a"), bundle("b")], NOW))).toEqual([
      "b:a",
      "b:b",
      "h:today",
      "t:1",
      "t:2",
      "h:yesterday",
      "t:3",
    ]);
  });

  it("leads with bundles when ungrouped or empty too", () => {
    expect(shape(buildListItems(today, true, [bundle("a")], NOW))).toEqual(["b:a", "h:today", "t:1", "t:2"]);
    expect(shape(buildListItems(today, false, [bundle("a")], NOW))).toEqual(["b:a", "t:1", "t:2"]);
    expect(shape(buildListItems([], true, [bundle("a")], NOW))).toEqual(["b:a"]);
  });

  it("subtitles only the Today header with the full date", () => {
    const items = buildListItems([...today, ...yesterday], true, [], NOW);
    const headers = items.filter((it) => it.kind === "header");
    expect(headers[0].kind === "header" && headers[0].subtitle).toBeTruthy();
    expect(headers[1].kind === "header" && headers[1].subtitle).toBeUndefined();
  });
});

describe("buildListItems sections", () => {
  it("places a header above each keyed thread when ungrouped", () => {
    const a = { id: 1, lastMessageAt: 0 } as ThreadSummary;
    const b = { id: 2, lastMessageAt: 0 } as ThreadSummary;
    const items = buildListItems([a, b], false, [], 0, new Map([[2, { label: "Related" }]]));
    expect(items.map((i) => i.kind)).toEqual(["thread", "header", "thread"]);
    expect(items[1]).toMatchObject({ kind: "header", label: "Related" });
  });
});

describe("inline bundles", () => {
  const important = [thread(1, NOW - HOUR), thread(2, NOW - 3 * HOUR), thread(3, NOW - 25 * HOUR)];
  // Newest mail 2h ago: sits between thread 1 and thread 2.
  const news = bundle("news", [thread(10, NOW - 2 * HOUR), thread(11, NOW - 30 * HOUR)], true);
  // Newest mail 2 days ago: sits after every Important thread.
  const old = bundle("old", [thread(20, NOW - 48 * HOUR)]);
  const collapsed = { expanded: new Set<string>() };

  it("places each bundle by its newest mail, under that mail's date header", () => {
    expect(shape(buildListItems(important, true, [old, news], NOW, undefined, collapsed))).toEqual([
      "h:today",
      "t:1",
      "b:news",
      "t:2",
      "h:yesterday",
      "t:3",
      expect.stringMatching(/^h:/),
      "b:old",
    ]);
  });

  it("opens an expanded bundle in place, closing with a show-all row when the tab holds more", () => {
    const expanded = new Set(["news", "old"]);
    const rows = inlineThreadOrder(important, [old, news], expanded);
    expect(shape(buildListItems(rows, false, [old, news], NOW, undefined, { expanded }))).toEqual([
      "t:1",
      "b:news+",
      "n:10",
      "n:11",
      "more:news",
      "t:2",
      "t:3",
      "b:old+",
      "n:20",
    ]);
  });

  it("walks threads (J/K order) in exactly the order the list shows them", () => {
    const expanded = new Set(["news"]);
    const rows = inlineThreadOrder(important, [old, news], expanded);
    const shown = buildListItems(rows, true, [old, news], NOW, undefined, { expanded }).flatMap((it) =>
      it.kind === "thread" ? [it.thread.id] : [],
    );
    expect(rows.map((t) => t.id)).toEqual([1, 10, 11, 2, 3]);
    expect(shown).toEqual([1, 10, 11, 2, 3]);
  });
});
