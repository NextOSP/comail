/** The one label palette: settings swatches and the colors new labels cycle
 *  through (so freshly created labels look distinct). */
export const LABEL_COLORS = [
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#6b7280",
];

/** Color for the n-th label created. */
export function nextLabelColor(existingCount: number): string {
  return LABEL_COLORS[existingCount % LABEL_COLORS.length];
}
