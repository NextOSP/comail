// Dark-mode adaptation for HTML email. Senders style for white backgrounds;
// on our dark theme their white surfaces and near-black text become jarring or
// unreadable. We blend the email into the dark theme (Dark Reader style):
// light backgrounds are darkened and dark text is lightened, so cards, boxes
// and copy all sit naturally on the app's dark canvas.
//
// This runs against the *live* iframe document (after load), not a detached
// parse, so getComputedStyle resolves backgrounds and colors defined in
// <style> blocks / CSS classes - not just inline style="" / bgcolor="" - which
// is exactly where senders hide the white card that used to break readability.
// No scripts run in the sandboxed iframe; we only rewrite color values.

let ctx: CanvasRenderingContext2D | null | undefined;

/** Normalize any CSS color to [r, g, b, a]; null if unparseable. */
function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim();
  if (!v || v === "transparent" || v === "inherit" || v === "initial") return null;
  if (ctx === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!ctx) return null;
  // fillStyle silently keeps its old value on invalid input; use a sentinel
  // that no real email color will normalize to.
  ctx.fillStyle = "#010203";
  ctx.fillStyle = v;
  if (ctx.fillStyle === "#010203" && !/^#?01/.test(v)) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Convert [r,g,b] (0-255) to [h (deg), s (0-1), l (0-1)]. */
function toHsl([r, g, b]: [number, number, number, number]): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s, l];
}

/** Lift a too-dark text color into the readable range, keeping its hue. */
function lightenText(color: [number, number, number, number]): string {
  const [h, s, l] = toHsl(color);
  // Grays go light gray; colored text (links, brand colors) goes pastel.
  const newL = s > 0.25 ? 0.72 : Math.max(0.78, 1 - l * 0.5);
  const newS = Math.min(s, 0.85);
  return `hsl(${Math.round(h)} ${Math.round(newS * 100)}% ${Math.round(newL * 100)}%)`;
}

/** Sink a light background down to a dark surface, preserving hue and the
 *  relative order of shades (whiter originals stay a touch lighter) so nested
 *  cards keep their layering instead of flattening into one flat block. */
function darkenBackground(color: [number, number, number, number]): string {
  const [h, s, l] = toHsl(color);
  // l is in [0.5, 1] here (only light backgrounds reach this). Map to a narrow
  // dark band ~[0.11, 0.16]; keep only a hint of the original saturation.
  const newL = 0.11 + (l - 0.5) * 0.1;
  const newS = Math.min(s, 0.2);
  return `hsl(${Math.round(h)} ${Math.round(newS * 100)}% ${Math.round(newL * 100)}%)`;
}

/** True if the element directly contains a non-empty text node. */
function hasDirectText(el: HTMLElement): boolean {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim()) {
      return true;
    }
  }
  return false;
}

function walk(el: HTMLElement, getStyle: (el: Element) => CSSStyleDeclaration) {
  // Skip elements the sender explicitly renders as media/graphics.
  const tag = el.tagName;
  if (tag !== "IMG" && tag !== "SVG" && tag !== "CANVAS" && tag !== "VIDEO") {
    const cs = getStyle(el);

    // Darken the element's own opaque light surface. Computed backgroundColor
    // is not inherited, so this reflects a background the element truly paints
    // (from inline style, bgcolor, or a <style>/class rule) - the case the old
    // detached-DOM detector missed.
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg[3] >= 0.5 && luminance(bg) > 0.5) {
      el.style.backgroundColor = darkenBackground(bg);
    }

    // Lighten dark text, but only on elements that actually hold text so we
    // don't flatten inherited colors across every structural wrapper.
    if (hasDirectText(el)) {
      const col = parseColor(cs.color);
      if (col && luminance(col) < 0.5) {
        el.style.color = lightenText(col);
      }
    }
  }

  for (const child of el.children) {
    walk(child as HTMLElement, getStyle);
  }
}

/** Blend a loaded email document into the app's dark theme in place. `root` is
 *  the live iframe body; its owner window supplies the resolved styles. */
export function adaptDocumentForDarkMode(root: HTMLElement): void {
  try {
    const win = root.ownerDocument.defaultView;
    if (!win) return;
    walk(root, (el) => win.getComputedStyle(el));
  } catch {
    // Best-effort: a failed adaptation leaves the email in its original colors.
  }
}

/** The painted background behind `el`: the first ancestor (including `el`)
 *  with an opaque-enough background color, or null if nothing paints one and
 *  the email is sitting on the app's (light) surface. */
function paintedBackground(
  el: HTMLElement,
  getStyle: (el: Element) => CSSStyleDeclaration,
): [number, number, number, number] | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = parseColor(getStyle(node).backgroundColor);
    if (bg && bg[3] >= 0.5) return bg;
  }
  return null;
}

/** Rescue text the sender colored light for a dark background it no longer has
 * - the sanitizer keeps inline `color` but drops the `<style>`/class rule (or
 *  `bgcolor`-less wrapper) that painted the dark surface, so near-white text
 *  renders invisibly on our light card. For each text element whose color is
 *  too light to read on the light backdrop and that has no dark background of
 *  its own, reset it to the theme's default ink. Runs on the light theme; the
 *  dark theme is handled by [`adaptDocumentForDarkMode`]. */
export function fixInvisibleText(root: HTMLElement, defaultColor: string): void {
  try {
    const win = root.ownerDocument.defaultView;
    if (!win) return;
    const getStyle = (el: Element) => win.getComputedStyle(el);
    const walkFix = (el: HTMLElement) => {
      const tag = el.tagName;
      if (tag !== "IMG" && tag !== "SVG" && tag !== "CANVAS" && tag !== "VIDEO" && hasDirectText(el)) {
        const col = parseColor(getStyle(el).color);
        // Only near-white text is at risk on a light surface; leave mid-grays.
        if (col && col[3] >= 0.5 && luminance(col) > 0.7) {
          const bg = paintedBackground(el, getStyle);
          // Light text is fine only when it sits on a genuinely dark surface.
          if (!bg || luminance(bg) > 0.4) el.style.setProperty("color", defaultColor, "important");
        }
      }
      for (const child of el.children) walkFix(child as HTMLElement);
    };
    walkFix(root);
  } catch {
    // Best-effort: on failure the email keeps its original colors.
  }
}
