// Accent color presets. Each has a light value (Snow) and a lifted value for
// dark (Carbon). The default, violet, matches the stylesheet tokens, so it is
// applied by clearing the inline override rather than setting it. A custom
// accent is stored as its "#rrggbb" hex; Carbon gets a lifted mix of it.

export const ACCENT_PRESETS = [
  { key: "violet", light: "#714cb6", dark: "#9d7fd8" },
  { key: "blue", light: "#2f6bd0", dark: "#6c9ff0" },
  { key: "teal", light: "#0f7f86", dark: "#4cbcc0" },
  { key: "green", light: "#3c8650", dark: "#74b381" },
  { key: "amber", light: "#a8690e", dark: "#e3a64a" },
  { key: "orange", light: "#c4561c", dark: "#ec8a55" },
  { key: "rose", light: "#c03b69", dark: "#e57399" },
  { key: "graphite", light: "#4a5260", dark: "#aab1bd" },
] as const;

export type AccentColor = (typeof ACCENT_PRESETS)[number]["key"];

export const DEFAULT_ACCENT: AccentColor = "violet";

export const isCustomAccent = (key: string) => /^#[0-9a-f]{6}$/i.test(key);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix a hex color toward white by `amount` (0..1). */
function lift(hex: string, amount: number): string {
  return (
    "#" +
    rgb(hex)
      .map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Relative luminance (WCAG) of a hex color. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The accent hex for a preset (or custom hex) under a resolved theme ("snow" | "carbon"). */
export function accentHex(key: string, resolvedTheme: string): string {
  if (isCustomAccent(key)) {
    // Lift dark custom colors in Carbon so they stay readable on the dark canvas.
    return resolvedTheme === "carbon" && luminance(key) < 0.18 ? lift(key, 0.3) : key;
  }
  const preset =
    ACCENT_PRESETS.find((p) => p.key === key) ?? ACCENT_PRESETS[0];
  return resolvedTheme === "carbon" ? preset.dark : preset.light;
}

/** Applies the accent to <html> and remembers it for the pre-paint script. */
export function applyAccent(key: string, resolvedTheme: string) {
  const root = document.documentElement;
  const hex = accentHex(key, resolvedTheme);
  if (key === DEFAULT_ACCENT) root.style.removeProperty("--accent");
  else root.style.setProperty("--accent", hex);
  // A custom accent can be light or dark either way; pick the readable text
  // color for filled accent surfaces instead of the theme's default.
  const onAccent = isCustomAccent(key)
    ? luminance(hex) > 0.4
      ? "#141413"
      : "#ffffff"
    : "";
  if (onAccent) root.style.setProperty("--on-accent", onAccent);
  else root.style.removeProperty("--on-accent");
  try {
    localStorage.setItem("comail:accent", key === DEFAULT_ACCENT ? "" : hex);
    localStorage.setItem("comail:on-accent", onAccent);
  } catch {
    /* ignore */
  }
}
