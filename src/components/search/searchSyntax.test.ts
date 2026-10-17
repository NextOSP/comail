import { beforeAll, describe as group, expect, it } from "vitest";
import i18next, { type TFunction } from "i18next";
import en from "../../i18n/locales/en/common.json";
import type { Label, SearchChip, SearchExplain } from "../../ipc/types";
import {
  applySuggestion,
  chipLabel,
  currentToken,
  describe,
  fold,
  humanSpan,
  replaceSpan,
  suggestionsFor,
  tierHeaders,
} from "./searchSyntax";

let t: TFunction;
beforeAll(async () => {
  const inst = i18next.createInstance();
  await inst.init({
    lng: "en",
    defaultNS: "common",
    resources: { en: { common: en } },
    interpolation: { escapeValue: false },
  });
  t = inst.t;
});

const label = (id: number, name: string, color = "#f00"): Label => ({
  id,
  name,
  color,
  keyword: name,
  position: id,
});
const LABELS = [label(1, "Work"), label(2, "Follow up"), label(3, "Khách hàng"), label(4, "Marketing")];

const explain = (over: Partial<SearchExplain>): SearchExplain => ({
  chips: [],
  warnings: [],
  terms: [],
  afterMs: null,
  beforeMs: null,
  sort: "relevance",
  ...over,
});
const chip = (kind: SearchChip["kind"], value: string): SearchChip => ({ kind, value, start: 0, end: 0 });

group("currentToken", () => {
  it("is the text after the last space", () => {
    expect(currentToken("invoice from:al")).toEqual({ start: 8, token: "from:al" });
    expect(currentToken("invoice ")).toEqual({ start: 8, token: "" });
    expect(currentToken("")).toEqual({ start: 0, token: "" });
  });
  it("keeps an open quoted value together", () => {
    expect(currentToken('x label:"Follow u')).toEqual({ start: 2, token: 'label:"Follow u' });
    expect(currentToken('label:"Follow up" inv')).toEqual({ start: 18, token: "inv" });
  });
});

group("suggestionsFor", () => {
  it("completes operators from a bare word, stopping at the colon", () => {
    const s = suggestionsFor("la", LABELS);
    expect(s.map((x) => x.insert)).toEqual(["label:", "last:"]);
    expect(s.every((x) => x.kind === "operator")).toBe(true);
    expect(suggestionsFor("label:", LABELS).some((x) => x.kind === "operator")).toBe(false);
  });

  it("lists every label right after `label:` - the instant indicator", () => {
    const s = suggestionsFor("label:", LABELS);
    expect(s.map((x) => x.label)).toEqual(["Work", "Follow up", "Khách hàng", "Marketing"]);
    expect(s[1].insert).toBe('label:"Follow up" ');
    expect(s[0].color).toBe("#f00");
  });

  it("filters labels accent-insensitively, by prefix or inner match", () => {
    expect(suggestionsFor("label:khach", LABELS).map((x) => x.label)).toEqual(["Khách hàng"]);
    expect(suggestionsFor('label:"fol', LABELS).map((x) => x.label)).toEqual(["Follow up"]);
    expect(suggestionsFor("label:keting", LABELS).map((x) => x.label)).toEqual(["Marketing"]);
    expect(suggestionsFor("label:work", LABELS)).toEqual([]); // already complete
  });

  it("offers fixed values for in:/is:/has:/sort:/last:/from:", () => {
    expect(suggestionsFor("is:", LABELS).map((x) => x.insert)).toEqual([
      "is:unread ",
      "is:read ",
      "is:starred ",
      "is:replied ",
    ]);
    expect(suggestionsFor("in:s", LABELS).map((x) => x.label)).toEqual(["in:sent", "in:spam"]);
    expect(suggestionsFor("sort:o", LABELS).map((x) => x.label)).toEqual(["sort:oldest"]);
    expect(suggestionsFor("last:", LABELS)[0].label).toBe("last:today");
    expect(suggestionsFor("from:", LABELS).map((x) => x.label)).toEqual(["from:me"]);
    expect(suggestionsFor("subject:", LABELS)).toEqual([]);
    expect(suggestionsFor("12:3", LABELS)).toEqual([]);
  });

  it("every description key exists in the English strings", () => {
    const all = [
      ...suggestionsFor("a", LABELS),
      ...suggestionsFor("b", LABELS),
      ...suggestionsFor("e", LABELS),
      ...suggestionsFor("f", LABELS),
      ...suggestionsFor("h", LABELS),
      ...suggestionsFor("i", LABELS),
      ...suggestionsFor("l", LABELS),
      ...suggestionsFor("o", LABELS),
      ...suggestionsFor("s", LABELS),
      ...suggestionsFor("t", LABELS),
      ...["in", "is", "has", "sort", "last", "older_than", "from"].flatMap((k) =>
        suggestionsFor(`${k}:`, LABELS),
      ),
    ];
    for (const s of all) {
      if (!s.descKey) continue;
      const key = `common:search.${s.descKey}`;
      expect(t(key), key).not.toBe(key.replace("common:", ""));
    }
  });
});

group("applySuggestion / replaceSpan", () => {
  it("replaces the current token", () => {
    expect(applySuggestion("invoice la", 8, "label:")).toBe("invoice label:");
  });
  it("removes a chip span and tidies spaces", () => {
    const q = "invoice from:alice  label:Work report";
    expect(replaceSpan(q, 8, 18)).toBe("invoice label:Work report");
    expect(replaceSpan("from:alice", 0, 10)).toBe("");
    expect(replaceSpan("x lable:work", 2, 12, "label:work")).toBe("x label:work");
  });
});

group("humanSpan / chipLabel", () => {
  it("spells out relative windows with plurals", () => {
    expect(humanSpan("7d", t)).toBe("7 days");
    expect(humanSpan("7days", t)).toBe("7 days");
    expect(humanSpan("1d", t)).toBe("1 day");
    expect(humanSpan("2W", t)).toBe("2 weeks");
    expect(humanSpan("month", t)).toBe("1 month");
    expect(humanSpan("24h", t)).toBe("24 hours");
    expect(humanSpan("??", t)).toBe("??");
  });
  it("labels chips with readable values", () => {
    expect(chipLabel(chip("from", "alice"), t)).toBe("From: alice");
    expect(chipLabel(chip("from", "me"), t)).toBe("From: me");
    expect(chipLabel(chip("in", "inbox"), t)).toBe("In: Inbox");
    expect(chipLabel(chip("is", "unread"), t)).toBe("Is: Unread");
    expect(chipLabel(chip("last", "7days"), t)).toBe("Last: 7 days");
    expect(chipLabel(chip("last", "today"), t)).toBe("Last: today");
    expect(chipLabel(chip("sort", "oldest"), t)).toBe("Sort: Oldest first");
    expect(chipLabel(chip("label", "Follow up"), t)).toBe("Label: Follow up");
  });
});

group("describe", () => {
  it("keyword only", () => {
    expect(describe(explain({ terms: ["invoice"] }), t)).toBe(
      "Emails containing “invoice”, best match first.",
    );
  });

  it("combines people, label, folder, state and time", () => {
    const e = explain({
      terms: ["invoice", "march"],
      chips: [chip("from", "alice"), chip("label", "Work"), chip("in", "inbox"), chip("is", "unread"), chip("last", "7d")],
    });
    expect(describe(e, t)).toBe(
      "Emails from alice labeled Work in Inbox that are unread from the last 7 days containing “invoice” “march”, best match first.",
    );
  });

  it("operator-only queries read as newest first", () => {
    const e = explain({ chips: [chip("from", "me"), chip("has", "attachment")] });
    expect(describe(e, t)).toBe("Emails you sent with attachments, newest first.");
  });

  it("honours sort and exclusions and field terms", () => {
    const e = explain({
      sort: "oldest",
      chips: [chip("subject", "q1 report"), chip("exclude", "draft")],
    });
    expect(describe(e, t)).toBe(
      "Emails with “q1 report” in the subject without “draft”, oldest first.",
    );
  });

  it("formats absolute date ranges once", () => {
    const after = new Date(2026, 0, 1).getTime();
    const before = new Date(2026, 3, 1).getTime();
    const e = explain({ chips: [chip("between", "2026-01-01:2026-03-31")], afterMs: after, beforeMs: before });
    expect(describe(e, t)).toBe("Emails between Jan 1, 2026 and Mar 31, 2026, newest first.");
    const e2 = explain({ chips: [chip("after", "2026-01-01")], afterMs: after });
    expect(describe(e2, t)).toBe("Emails since Jan 1, 2026, newest first.");
  });
});

group("tierHeaders", () => {
  it("adds a header before the first partial and first similar result", () => {
    const h = tierHeaders(
      [
        { threadId: 1, tier: 1 },
        { threadId: 2, tier: 3 },
        { threadId: 3, tier: 4 },
        { threadId: 4, tier: 4 },
        { threadId: 5, tier: 5 },
        { threadId: 6, tier: 5 },
      ],
      t,
    );
    expect([...h.keys()]).toEqual([3, 5]);
    expect(h.get(3)?.label).toBe("Partial matches - not every word");
    expect(h.get(5)?.subtitle).toBe("Found by meaning");
  });
  it("no headers when every result is a full match", () => {
    expect(tierHeaders([{ threadId: 1, tier: 1 }, { threadId: 2, tier: 3 }], t).size).toBe(0);
  });
});

group("fold", () => {
  it("matches the backend's accent folding", () => {
    expect(fold("Bé Dọn Dẹp")).toBe("be don dep");
    expect(fold("Đơn hàng")).toBe("don hang");
  });
});
