// Pure geometry helpers for the attachment viewer (zoom steps, zoom-at-point,
// pan clamping, spreadsheet column names). Kept DOM-free so they're testable.

/** Discrete zoom stops used by the +/- buttons and keys. */
export const ZOOM_STOPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 8];
export const MIN_ZOOM = ZOOM_STOPS[0];
export const MAX_ZOOM = ZOOM_STOPS[ZOOM_STOPS.length - 1];

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Next zoom stop strictly above (dir 1) or below (dir -1) `z`. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const eps = 0.001;
  if (dir > 0) return ZOOM_STOPS.find((s) => s > z + eps) ?? MAX_ZOOM;
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) if (ZOOM_STOPS[i] < z - eps) return ZOOM_STOPS[i];
  return MIN_ZOOM;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

/** Scale that fits `content` inside `box` without upscaling past 1. */
export function fitScale(contentW: number, contentH: number, boxW: number, boxH: number): number {
  if (contentW <= 0 || contentH <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / contentW, boxH / contentH);
}

/** Change scale keeping the content point under (px, py) fixed on screen. */
export function zoomAt(v: View, nextScale: number, px: number, py: number): View {
  const s = clampZoom(nextScale);
  const k = s / v.scale;
  return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** Center content that's smaller than the box; otherwise keep its edges from
 *  pulling inside the box (no empty gutter when panned to an edge). */
export function clampPan(v: View, contentW: number, contentH: number, boxW: number, boxH: number): View {
  const w = contentW * v.scale;
  const h = contentH * v.scale;
  const axis = (pos: number, size: number, box: number) =>
    size <= box ? (box - size) / 2 : Math.min(0, Math.max(box - size, pos));
  return { scale: v.scale, x: axis(v.x, w, boxW), y: axis(v.y, h, boxH) };
}

/** Centered view at `scale` (clamped/centered via clampPan). */
export function centered(scale: number, contentW: number, contentH: number, boxW: number, boxH: number): View {
  return clampPan(
    { scale, x: (boxW - contentW * scale) / 2, y: (boxH - contentH * scale) / 2 },
    contentW,
    contentH,
    boxW,
    boxH,
  );
}

/** Spreadsheet column name: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Index of the page whose top edge most recently passed the reading line
 *  (40% down the viewport). `tops` must be ascending. */
export function currentPageIndex(tops: number[], scrollTop: number, viewportH: number): number {
  const line = scrollTop + viewportH * 0.4;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) idx = i;
    else break;
  }
  return idx;
}
