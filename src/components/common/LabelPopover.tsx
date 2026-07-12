import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Label } from "../../ipc/types";
import { call } from "../../ipc/commands";
import { commandScore } from "../../keyboard/commandScore";
import { findCachedSummary, performThreadAction } from "../../queries/actions";
import { queryClient } from "../../queries/client";
import { useLabels } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

/** Palette new labels cycle through, so fresh labels look distinct. */
const SWATCHES = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777"];

/** Global label popover, opened by L (targets stored in the ui store). */
export function LabelPopover() {
  const { t } = useTranslation();
  const target = useUi((s) => s.labelTarget);
  const set = useUi((s) => s.set);
  const { data: labels } = useLabels();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // Toggles made while the popover is open (the cached summaries don't trigger
  // a re-render), keyed by label id.
  const [override, setOverride] = useState<Record<number, boolean>>({});

  // A label is "applied" when it is present on every targeted thread.
  const baseApplied = useMemo(() => {
    const ids = target ?? [];
    if (ids.length === 0) return new Set<number>();
    const perThread = ids.map((id) => new Set(findCachedSummary(id)?.labels ?? []));
    const first = perThread[0] ?? new Set<number>();
    const common = new Set<number>();
    for (const l of first) {
      if (perThread.every((s) => s.has(l))) common.add(l);
    }
    return common;
  }, [target]);

  const isApplied = (id: number) => override[id] ?? baseApplied.has(id);

  const filtered = useMemo(() => {
    const all = labels ?? [];
    const q = query.trim();
    if (!q) return all;
    return all
      .map((l) => ({ l, score: commandScore(l.name, q) }))
      .filter((r) => r.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.l);
  }, [labels, query]);

  const exactMatch = useMemo(
    () => (labels ?? []).some((l) => l.name.toLowerCase() === query.trim().toLowerCase()),
    [labels, query],
  );
  const canCreate = query.trim().length > 0 && !exactMatch;
  const rowCount = filtered.length + (canCreate ? 1 : 0);

  if (!target) return null;

  const close = () => {
    set({ labelTarget: null });
    setQuery("");
    setCursor(0);
    setOverride({});
  };

  const toggle = (label: Label) => {
    const ids = target;
    const nowApplied = isApplied(label.id);
    setOverride((o) => ({ ...o, [label.id]: !nowApplied }));
    void performThreadAction(nowApplied ? "remove_label" : "add_label", ids, { labelId: label.id });
  };

  const create = async () => {
    const name = query.trim();
    if (!name) return;
    const color = SWATCHES[(labels?.length ?? 0) % SWATCHES.length];
    try {
      const label = await call("save_label", {
        label: { id: null, name, color, position: labels?.length ?? 0 },
      });
      await queryClient.invalidateQueries({ queryKey: ["labels"] });
      void performThreadAction("add_label", target, { labelId: label.id });
      setOverride((o) => ({ ...o, [label.id]: true }));
      setQuery("");
      setCursor(0);
    } catch {
      useUi.getState().pushToast({ kind: "error", message: t("common:label.createFailed") });
    }
  };

  const sel = Math.min(cursor, Math.max(0, rowCount - 1));
  const activate = (i: number) => {
    if (i < filtered.length) toggle(filtered[i]);
    else if (canCreate) void create();
  };

  return (
    <div className="co-overlay flex items-start justify-center pt-[18vh]" onMouseDown={close}>
      <div
        className="co-pop-in w-[380px] rounded-xl border border-hairline bg-bg1 p-3"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-1 pb-2 text-[12px] font-semibold tracking-wide text-ink-faint uppercase">
          {t("common:label.title")}
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(rowCount - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              activate(sel);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          placeholder={t("common:label.placeholder")}
          className="w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
        />
        <div className="mt-1.5 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {rowCount === 0 && (
            <p className="px-3 py-4 text-center text-[12.5px] text-ink-faint">
              {labels ? t("common:label.none") : t("common:move.loading")}
            </p>
          )}
          {filtered.map((l, i) => (
            <button
              key={l.id}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink ${
                i === sel ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => toggle(l)}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: l.color }} />
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              <span
                className={`shrink-0 text-[11px] ${isApplied(l.id) ? "text-accent" : "text-transparent"}`}
              >
                ✓
              </span>
            </button>
          ))}
          {canCreate && (
            <button
              className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink ${
                sel === filtered.length ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(filtered.length)}
              onClick={() => void create()}
            >
              <span className="text-ink-faint">＋</span>
              <span className="min-w-0 flex-1 truncate">
                {t("common:label.create", { name: query.trim() })}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
