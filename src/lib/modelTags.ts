/** Model tags: `:suffix` hints on a model id (`openai/gpt-6-luna:nitro`).
 *  Mirrors `MODEL_TAGS` in comail-core `ai/mod.rs`, which maps them per
 *  endpoint when building requests. */
export const MODEL_TAGS = [
  "fast",
  "nitro",
  "priority",
  "flex",
  "floor",
  "exacto",
  "thinking",
] as const;
export type ModelTag = (typeof MODEL_TAGS)[number];

/** Speed/price routing tags; a model carries at most one of these. */
const ROUTING: readonly string[] = [
  "fast",
  "nitro",
  "priority",
  "flex",
  "floor",
  "exacto",
];

/** Tags worth offering for an endpoint (others are stripped there). */
export function tagsFor(baseUrl: string): ModelTag[] {
  const url = baseUrl.toLowerCase();
  // An empty base URL means the OpenRouter default.
  if (!url || url.includes("openrouter.ai"))
    return ["nitro", "floor", "exacto", "thinking"];
  if (url.includes("api.openai.com")) return ["fast", "flex", "thinking"];
  return [];
}

/** `[bare id, tags]` with trailing known tags peeled off, in order. */
export function splitModelTags(model: string): [string, string[]] {
  let base = model;
  const tags: string[] = [];
  for (;;) {
    const i = base.lastIndexOf(":");
    const tag = base.slice(i + 1);
    if (i <= 0 || !(MODEL_TAGS as readonly string[]).includes(tag)) break;
    tags.unshift(tag);
    base = base.slice(0, i);
  }
  return [base, tags];
}

/** `model` with `tag` toggled; turning on a routing tag drops the other ones. */
export function toggleModelTag(model: string, tag: ModelTag): string {
  const [base, tags] = splitModelTags(model.trim());
  if (!base) return model;
  const next = tags.includes(tag)
    ? tags.filter((t) => t !== tag)
    : [
        ...tags.filter((t) => !(ROUTING.includes(tag) && ROUTING.includes(t))),
        tag,
      ];
  return [base, ...next].join(":");
}
