// Interface font. "" keeps the system stack from the stylesheet; anything else
// is a Google Fonts family, loaded on demand via a <link> and layered in front
// of the system stack (so an offline launch still renders sensibly).

export const FONT_PRESETS = [
  "", // system
  "Inter",
  "IBM Plex Sans",
  "Nunito Sans",
  "Atkinson Hyperlegible",
  "Lora",
] as const;

const LINK_ID = "comail-font";
const SYSTEM_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Trim and collapse whitespace; strip anything that can't be in a family name. */
export function normalizeFontFamily(name: string): string {
  return name.replace(/[^\p{L}\p{N} \-]/gu, "").replace(/\s+/g, " ").trim();
}

export function googleFontUrl(family: string): string {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700&display=swap`;
}

export function fontStack(family: string): string {
  return family ? `"${family}", ${SYSTEM_STACK}` : "";
}

/**
 * Applies the interface font. `onError` fires when Google Fonts rejects the
 * family (unknown name) or can't be reached; the system stack stays in effect.
 */
export function applyFont(family: string, onError?: () => void) {
  const root = document.documentElement;
  const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  const clean = normalizeFontFamily(family);
  if (!clean) {
    existing?.remove();
    root.style.removeProperty("--font-sans");
  } else {
    const href = googleFontUrl(clean);
    if (existing?.getAttribute("href") !== href) {
      existing?.remove();
      const link = document.createElement("link");
      link.id = LINK_ID;
      link.rel = "stylesheet";
      link.href = href;
      if (onError) link.onerror = () => onError();
      document.head.appendChild(link);
    }
    root.style.setProperty("--font-sans", fontStack(clean));
  }
  try {
    localStorage.setItem("comail:font", clean);
  } catch {
    /* ignore */
  }
}
