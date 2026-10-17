// Search-box syntax helpers: operator metadata, as-you-type completion of
// operators and their values, span edits for the explain chips, and the
// one-line "what will this search do" sentence. Pure (no React), so the
// logic is unit-tested in searchSyntax.test.ts; the parsing itself happens in
// comail-core and arrives as a SearchExplain.
import type { Label, SearchChip, SearchExplain } from "../../ipc/types";

/** i18n `t`, narrowed to what these helpers need. */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Every operator the backend parser understands. Ops ending in `:` take a
 *  value; `starter` ones show in the "Try" row when nothing is typed. */
export type OperatorMeta = { op: string; descKey: string; starter?: boolean };
export const OPERATOR_META: OperatorMeta[] = [
  { op: "from:", descKey: "from", starter: true },
  { op: "to:", descKey: "to" },
  { op: "label:", descKey: "label", starter: true },
  { op: "subject:", descKey: "subject" },
  { op: "body:", descKey: "body" },
  { op: "in:", descKey: "in" },
  { op: "is:", descKey: "is", starter: true },
  { op: "has:", descKey: "has" },
  { op: "last:", descKey: "last", starter: true },
  { op: "after:", descKey: "after" },
  { op: "before:", descKey: "before" },
  { op: "between:", descKey: "between" },
  { op: "older_than:", descKey: "olderThan" },
  { op: "sort:", descKey: "sort" },
  { op: "exclude:", descKey: "exclude" },
];

/** Fixed values for the operators that have them, in suggestion order. */
export const OPERATOR_VALUES: Record<string, string[]> = {
  in: ["inbox", "sent", "drafts", "archive", "trash", "spam"],
  is: ["unread", "read", "starred", "replied"],
  has: ["attachment", "label"],
  sort: ["newest", "oldest", "relevance"],
  last: ["today", "7d", "30d", "90d", "1y"],
  older_than: ["30d", "90d", "1y"],
  from: ["me"],
};

/** Lowercase, strip accents (đ → d): matches the backend's folding. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** The token under construction: the text after the last space that is not
 *  inside an open quote (so `label:"Follow u` is one token). */
export function currentToken(input: string): { start: number; token: string } {
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && /\s/.test(c)) start = i + 1;
  }
  return { start, token: input.slice(start) };
}

/** One completion row. `insert` replaces the current token; `kind` drives
 *  the row's look (an operator, one of its values, or a label with a dot). */
export type Suggestion = {
  insert: string;
  label: string;
  kind: "operator" | "value" | "label";
  /** i18n key (under common:search.*) describing the row. */
  descKey?: string;
  color?: string;
};

function quoteIfNeeded(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/**
 * Completions for the token being typed:
 * - a bare word → operators starting with it (`la` → `label:`)
 * - `label:<partial>` → matching label names (accent-insensitive)
 * - `in:` / `is:` / `has:` / `sort:` / `last:` / … → their values
 * Value completions end with a space so typing flows on to the next term;
 * operator completions stop at the `:` so the value can follow.
 */
export function suggestionsFor(token: string, labels: Label[]): Suggestion[] {
  if (!token) return [];
  const colon = token.indexOf(":");
  if (colon < 0) {
    const lower = token.toLowerCase();
    return OPERATOR_META.filter((m) => m.op.startsWith(lower) && m.op !== lower).map((m) => ({
      insert: m.op,
      label: m.op,
      kind: "operator" as const,
      descKey: `ops.${m.descKey}`,
    }));
  }
  const key = token.slice(0, colon).toLowerCase();
  const partial = token.slice(colon + 1).replace(/^"/, "").replace(/"$/, "");
  const want = fold(partial);
  if (key === "label") {
    return labels
      .filter((l) => {
        const name = fold(l.name);
        return name.startsWith(want) || (want.length > 1 && name.includes(want));
      })
      .filter((l) => fold(l.name) !== want)
      .slice(0, 8)
      .map((l) => ({
        insert: `label:${quoteIfNeeded(l.name)} `,
        label: l.name,
        kind: "label" as const,
        color: l.color,
      }));
  }
  const values = OPERATOR_VALUES[key];
  if (!values) return [];
  return values
    .filter((v) => v.startsWith(want) && v !== want)
    .map((v) => ({
      insert: `${key}:${v} `,
      label: `${key}:${v}`,
      kind: "value" as const,
      descKey: `values.${key}.${v}`,
    }));
}

/** Replace the current token (from `start`) with a completion. */
export function applySuggestion(input: string, start: number, insert: string): string {
  return input.slice(0, start) + insert;
}

/** Replace `input[start..end]` with `text`, tidying the spaces around it.
 *  Used to remove a chip (`text` = "") or apply a did-you-mean fix. */
export function replaceSpan(input: string, start: number, end: number, text = ""): string {
  const before = input.slice(0, start).replace(/\s+$/, "");
  const after = input.slice(end).replace(/^\s+/, "");
  return [before, text, after].filter((p) => p !== "").join(" ");
}

/** "7d" → "7 days", "2w" → "2 weeks", "month" → "1 month", "24h" → "24 hours". */
export function humanSpan(value: string, t: Translate): string {
  const v = value.toLowerCase();
  const m = /^(\d*)\s*([a-z]+)$/.exec(v);
  if (!m) return value;
  const count = m[1] ? Number(m[1]) : 1;
  const unit = m[2];
  const units: [RegExp, string][] = [
    [/^(h|hr|hrs|hour|hours)$/, "hours"],
    [/^(d|day|days)$/, "days"],
    [/^(w|wk|week|weeks)$/, "weeks"],
    [/^(m|mo|month|months)$/, "months"],
    [/^(y|yr|year|years)$/, "years"],
  ];
  const hit = units.find(([re]) => re.test(unit));
  return hit ? t(`common:search.span.${hit[1]}`, { count }) : value;
}

/** Short label for a chip, e.g. "From: alice", "Last: 7 days". */
export function chipLabel(c: SearchChip, t: Translate): string {
  const name = t(`common:search.chip.${c.kind}`);
  let value = c.value;
  if (c.kind === "last" || c.kind === "older_than") {
    value = c.value === "today" ? t("common:search.explain.todayShort") : humanSpan(c.value, t);
  } else if (c.kind === "from" && c.value === "me") {
    value = t("common:search.explain.me");
  } else if (c.kind === "in" || c.kind === "is" || c.kind === "has" || c.kind === "sort") {
    value = t(`common:search.values.${c.kind}.${c.value}`);
  }
  return `${name}: ${value}`;
}

function formatDay(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(ms),
  );
}

/**
 * One plain sentence describing what the query does, e.g.
 * "Emails from alice labeled Work in the last 7 days containing “invoice”,
 * best match first." Built from translated fragments in a fixed order.
 */
export function describe(explain: SearchExplain, t: Translate, locale = "en"): string {
  const chips = explain.chips;
  const of = (kind: SearchChip["kind"]) => chips.filter((c) => c.kind === kind);
  const fromMe = of("from").some((c) => c.value === "me");
  const parts: string[] = [t(fromMe ? "common:search.explain.leadSent" : "common:search.explain.lead")];

  for (const c of of("from")) {
    if (c.value !== "me") parts.push(t("common:search.explain.from", { v: c.value }));
  }
  for (const c of of("to")) parts.push(t("common:search.explain.to", { v: c.value }));
  for (const c of of("label")) parts.push(t("common:search.explain.label", { v: c.value }));
  for (const c of of("in")) {
    parts.push(t("common:search.explain.in", { v: t(`common:search.values.in.${c.value}`) }));
  }
  for (const c of of("is")) parts.push(t(`common:search.explain.is.${c.value}`));
  for (const c of of("has")) parts.push(t(`common:search.explain.has.${c.value}`));

  // Dates: relative windows read naturally; absolute bounds use the parsed
  // range so several bounds collapse into one phrase.
  for (const c of of("last")) {
    parts.push(
      c.value === "today"
        ? t("common:search.explain.today")
        : t("common:search.explain.last", { span: humanSpan(c.value, t) }),
    );
  }
  for (const c of of("older_than")) {
    parts.push(t("common:search.explain.olderThan", { span: humanSpan(c.value, t) }));
  }
  const absolute = of("after").length + of("before").length + of("between").length > 0;
  if (absolute) {
    const { afterMs, beforeMs } = explain;
    if (afterMs != null && beforeMs != null) {
      parts.push(
        t("common:search.explain.between", {
          from: formatDay(afterMs, locale),
          to: formatDay(beforeMs - 1, locale),
        }),
      );
    } else if (afterMs != null) {
      parts.push(t("common:search.explain.after", { date: formatDay(afterMs, locale) }));
    } else if (beforeMs != null) {
      parts.push(t("common:search.explain.before", { date: formatDay(beforeMs, locale) }));
    }
  }

  if (explain.terms.length > 0) {
    parts.push(
      t("common:search.explain.containing", {
        terms: explain.terms.map((w) => `“${w}”`).join(" "),
      }),
    );
  }
  for (const c of of("subject")) parts.push(t("common:search.explain.subject", { v: `“${c.value}”` }));
  for (const c of of("body")) parts.push(t("common:search.explain.body", { v: `“${c.value}”` }));
  for (const c of of("exclude")) parts.push(t("common:search.explain.without", { v: `“${c.value}”` }));

  const hasText = explain.terms.length > 0 || of("subject").length + of("body").length > 0;
  const sort = explain.sort === "relevance" && !hasText ? "newest" : explain.sort;
  return t("common:search.explain.sentence", {
    what: parts.join(" "),
    order: t(`common:search.explain.sort.${sort}`),
  });
}

/** The section header to show before the first thread of a lower tier:
 *  partial matches (tier 4) and meaning-only matches (tier 5). Keyed by the
 *  thread id it precedes; empty when every result is a full match. */
export function tierHeaders(
  hits: { threadId: number; tier: number }[],
  t: Translate,
): Map<number, { label: string; subtitle?: string }> {
  const out = new Map<number, { label: string; subtitle?: string }>();
  // Hits arrive sorted by tier, so a header goes on each tier's first row.
  let prev = 0;
  for (const h of hits) {
    if (h.tier === 4 && prev !== 4) {
      out.set(h.threadId, { label: t("common:search.group.partial") });
    } else if (h.tier === 5 && prev !== 5) {
      out.set(h.threadId, {
        label: t("common:search.group.similar"),
        subtitle: t("common:search.group.similarHint"),
      });
    }
    prev = h.tier;
  }
  return out;
}
