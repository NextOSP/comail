/** Four-level heatmap bucket using a logarithmic scale capped at the 95th
 * percentile. The cap prevents one exceptional day from flattening every
 * normal day into the lightest color; zero always remains a distinct bucket. */
export function heatmapLevel(value: number, samples: number[]): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const positive = samples
    .filter((sample) => Number.isFinite(sample) && sample > 0)
    .sort((a, b) => a - b);
  if (positive.length === 0) return 0;
  const cap = positive[Math.floor((positive.length - 1) * 0.95)];
  const ratio = Math.log1p(Math.min(value, cap)) / Math.log1p(cap);
  return Math.max(1, Math.min(4, Math.ceil(ratio * 4))) as 1 | 2 | 3 | 4;
}

export const HEATMAP_OPACITY = [0, 0.28, 0.45, 0.64, 0.86] as const;
