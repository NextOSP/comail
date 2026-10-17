import { describe, expect, it } from "vitest";

/**
 * Design-token ratchet. Components should use the scale in app.css
 * (text-xs…text-xl, rounded-control/card/sheet, shadow-elev-*) and the
 * components/ui kit instead of ad-hoc values. Each count below is the number
 * of stragglers left; lower it whenever a sweep removes some, never raise it.
 *
 * Warn-only until the token sweep lands (several branches are still adding
 * markup); set CO_TOKENS_STRICT=1 to make overruns fail.
 */
const STRICT = import.meta.env.CO_TOKENS_STRICT === "1";
const BUDGET: { name: string; pattern: RegExp; max: number }[] = [
  { name: "arbitrary font sizes (text-[Npx])", pattern: /text-\[\d/g, max: 144 },
  { name: "theme-blind Tailwind shadows", pattern: /shadow-(?:sm|lg|xl|2xl)\b/g, max: 0 },
  { name: "inline elevation styles (use shadow-elev-*)", pattern: /boxShadow: "var\(--elev/g, max: 8 },
  { name: "raw checkboxes (use ui/Field Checkbox)", pattern: /type="checkbox"/g, max: 1 },
  { name: "untokenized radii (use rounded-control/card/sheet)", pattern: /rounded-(?:md|lg|xl|2xl)\b/g, max: 49 },
];

// Every component source as text. The kit's own Field.tsx is where the
// primitives (e.g. the real checkbox input) are defined, so it is exempt.
const SOURCES = Object.entries(
  import.meta.glob<string>("../components/**/*.tsx", { query: "?raw", import: "default", eager: true }),
)
  .filter(([path]) => !path.endsWith("/ui/Field.tsx"))
  .map(([, src]) => src);

describe("design tokens", () => {
  for (const { name, pattern, max } of BUDGET) {
    it(`no new ${name}`, () => {
      const count = SOURCES.reduce((n, src) => n + (src.match(pattern)?.length ?? 0), 0);
      if (STRICT) expect(count, `${name}: ${count} > budget ${max}`).toBeLessThanOrEqual(max);
      else if (count > max) console.warn(`[tokens] ${name}: ${count} > budget ${max}`);
    });
  }
});
