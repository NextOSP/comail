// Dark-mode adaptation for HTML email. Senders style for white backgrounds;
// on our dark theme their near-black/gray text becomes unreadable. We lighten
// dark text colors, but only in regions that do NOT have an explicit light
// background of their own (a white "card" inside the email keeps its design).
//
// The HTML is parsed with DOMParser, which never executes scripts, and only
// color values are rewritten before re-serialization.

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

/** Lift a too-dark color into the readable range, keeping its hue. */
function lighten([r, g, b]: [number, number, number, number]): string {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    const rn = r / 255, gn = g / 255, bn = b / 255;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  // Grays go light gray; colored text (links, brand colors) goes pastel.
  const newL = s > 0.25 ? 0.72 : Math.max(0.78, 1 - l * 0.5);
  const newS = Math.min(s, 0.85);
  return `hsl(${Math.round(h)} ${Math.round(newS * 100)}% ${Math.round(newL * 100)}%)`;
}

function ownBackground(el: HTMLElement): [number, number, number, number] | null {
  const fromStyle = el.style?.backgroundColor;
  if (fromStyle) {
    const c = parseColor(fromStyle);
    if (c) return c;
  }
  const attr = el.getAttribute("bgcolor");
  if (attr) {
    const c = parseColor(attr);
    if (c) return c;
  }
  return null;
}

function walk(el: HTMLElement, onLightBg: boolean) {
  let light = onLightBg;
  const bg = ownBackground(el);
  if (bg && bg[3] > 0.4) light = luminance(bg) > 0.5;

  if (!light) {
    const fontAttr = el.tagName === "FONT" ? el.getAttribute("color") : null;
    const cur = el.style?.color || fontAttr;
    if (cur) {
      const c = parseColor(cur);
      if (c && luminance(c) < 0.55) {
        el.style.color = lighten(c);
        if (fontAttr) el.removeAttribute("color");
      }
    }
  }

  for (const child of el.children) {
    walk(child as HTMLElement, light);
  }
}

/** Rewrite inline colors so text stays readable on the app's dark background. */
export function adaptHtmlForDarkMode(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    walk(doc.body as HTMLElement, false);
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
