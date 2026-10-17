import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetPreview } from "../../../ipc/types";
import { columnName } from "../../../lib/viewer";
import { useViewerKeys } from "./common";

const HEAD_H = 26; // column-letter header row height (px); keep in sync with .co-sheet-frozen top

/**
 * Spreadsheet-style grid: sticky A/B/C and 1/2/3 headers, a frozen first row,
 * a formula bar showing the selected cell's full value (cells truncate), and
 * Excel/Numbers-style sheet tabs along the bottom.
 */
export function SheetViewer({ sheets }: { sheets: SheetPreview[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const cols = useMemo(() => sheet.rows.reduce((m, r) => Math.max(m, r.length), 0), [sheet]);

  useEffect(() => setSel(null), [active]);

  useViewerKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    // Shift+[ / Shift+] (i.e. { and }) flip sheets, like a browser's tab keys.
    if (e.key === "}" && active < sheets.length - 1) {
      setActive(active + 1);
      return true;
    }
    if (e.key === "{" && active > 0) {
      setActive(active - 1);
      return true;
    }
    if (!sel) return false;
    const move = (dr: number, dc: number) => {
      setSel({ r: Math.max(0, Math.min(sheet.rows.length - 1, sel.r + dr)), c: Math.max(0, Math.min(cols - 1, sel.c + dc)) });
      return true;
    };
    if (e.key === "ArrowDown") return move(1, 0);
    if (e.key === "ArrowUp") return move(-1, 0);
    if (e.key === "ArrowRight") return move(0, 1);
    if (e.key === "ArrowLeft") return move(0, -1);
    if (e.key === "Tab") return move(0, e.shiftKey ? -1 : 1);
    if (e.key === "Escape") {
      setSel(null);
      return true;
    }
    return false;
  });

  const value = sel ? (sheet.rows[sel.r]?.[sel.c] ?? "") : "";

  return (
    <div className="flex h-full flex-col">
      <div className="co-hairline-b flex h-9 shrink-0 items-center gap-3 px-4 text-[12.5px]">
        <span className="w-14 shrink-0 rounded bg-bg2 px-1.5 py-0.5 text-center font-mono text-[11.5px] text-ink-muted">
          {sel ? `${columnName(sel.c)}${sel.r + 1}` : ""}
        </span>
        <span className="font-mono text-[11px] text-ink-faint italic">fx</span>
        <span className="min-w-0 flex-1 truncate text-ink select-text" title={value}>
          {sel ? value : <span className="text-ink-faint">{t("thread:attachment.preview.selectCell")}</span>}
        </span>
      </div>

      <div className="co-viewer-scroll min-h-0 flex-1 overflow-auto">
        <table className="co-sheet border-separate border-spacing-0 text-[12.5px] text-ink">
          <thead>
            <tr>
              <th className="co-sheet-corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className={`co-sheet-col ${sel?.c === c ? "is-sel" : ""}`} style={{ height: HEAD_H }}>
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r} className={r === 0 ? "co-sheet-frozen" : ""}>
                <th className={`co-sheet-row ${sel?.r === r ? "is-sel" : ""}`}>{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const cell = row[c] ?? "";
                  const isSel = sel?.r === r && sel.c === c;
                  return (
                    <td
                      key={c}
                      className={`co-sheet-cell ${isSel ? "is-sel" : ""} ${/^[-+$€£¥]?[\d,.\s]+%?$/.test(cell) ? "text-right tabular-nums" : ""}`}
                      onClick={() => setSel({ r, c })}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="co-hairline-t flex h-10 shrink-0 items-center gap-1 px-2">
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto" role="tablist">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={`co-sheet-tab ${i === active ? "is-active" : ""}`}
              onClick={() => setActive(i)}
            >
              {s.name || t("thread:attachment.preview.sheetFallback", { n: i + 1 })}
            </button>
          ))}
        </div>
        <span className="shrink-0 px-2 text-[11.5px] text-ink-faint tabular-nums">
          {t("thread:attachment.preview.sheetSize", { rows: sheet.rows.length, cols })}
          {sheet.truncated && ` · ${t("thread:attachment.preview.truncated")}`}
        </span>
      </div>
    </div>
  );
}
