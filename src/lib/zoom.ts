export const DEFAULT_ZOOM_PERCENT = 100;
export const ZOOM_LEVELS: readonly number[] = [90, DEFAULT_ZOOM_PERCENT, 110, 125, 150];

export function zoomPercent(value: number | undefined): number {
  return value !== undefined && ZOOM_LEVELS.includes(value) ? value : DEFAULT_ZOOM_PERCENT;
}

export function stepZoom(value: number, step: -1 | 1): number {
  const current = zoomPercent(value);
  return ZOOM_LEVELS[ZOOM_LEVELS.indexOf(current) + step] ?? current;
}
