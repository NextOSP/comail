import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../ipc/types";
import { buildListItems, type Bundle } from "./listItems";

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

const bundle = (key: string): Bundle => ({ key, name: key, threads: [thread(99, NOW)] });

const shape = (items: ReturnType<typeof buildListItems>) =>
  items.map((it) =>
    it.kind === "header" ? `h:${it.key}` : it.kind === "bundle" ? `b:${it.bundle.key}` : `t:${it.thread.id}`,
  );

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
