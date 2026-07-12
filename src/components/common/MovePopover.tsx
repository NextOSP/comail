import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderInfo, View } from "../../ipc/types";
import { commandScore } from "../../keyboard/commandScore";
import { buildCommandContext } from "../../keyboard/context";
import { findCachedSummary, performThreadAction } from "../../queries/actions";
import { useFolders } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

/** Folder role the current view corresponds to (threads there are filtered out). */
const VIEW_ROLE: Partial<Record<View, string>> = {
  inbox: "inbox",
  done: "archive",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  spam: "spam",
};

function folderLabel(f: FolderInfo): string {
  return f.imapName.replace(/^\[Gmail\]\//, "");
}

/** Global move-to-folder popover, opened by V (targets stored in the ui store). */
export function MovePopover() {
  const { t } = useTranslation();
  const target = useUi((s) => s.moveTarget);
  const view = useUi((s) => s.view);
  const set = useUi((s) => s.set);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const accountId = target?.length ? (findCachedSummary(target[0])?.accountId ?? null) : null;
  const { data: folders } = useFolders(target ? accountId : null);

  const candidates = useMemo(() => {
    if (!folders) return [];
    const currentRole = VIEW_ROLE[view];
    return folders.filter(
      (f) => f.role !== "drafts" && (currentRole == null || f.role !== currentRole),
    );
  }, [folders, view]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return candidates;
    return candidates
      .map((f) => ({ f, score: commandScore(folderLabel(f), q) }))
      .filter((r) => r.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.f);
  }, [candidates, query]);

  if (!target) return null;

  const close = () => {
    set({ moveTarget: null });
    setQuery("");
    setCursor(0);
  };

  const pick = (f: FolderInfo) => {
    const ids = target;
    const label = t("common:move.movedTo", { folder: folderLabel(f) });
    close();
    // Route through the shared context so auto-advance + undo toast apply.
    const ctx = buildCommandContext();
    if (ctx.targets.length > 0 && ids.every((id) => ctx.targets.includes(id))) {
      ctx.act("move", { targetFolderId: f.id }, label);
    } else {
      void performThreadAction("move", ids, { targetFolderId: f.id });
      useUi.getState().set({ lastUndo: { type: "action", label } });
      useUi.getState().pushToast({ kind: "info", message: t("common:undoSuffix", { label }) });
    }
  };

  const sel = Math.min(cursor, Math.max(0, filtered.length - 1));

  return (
    <div className="co-overlay flex items-start justify-center pt-[18vh]" onMouseDown={close}>
      <div
        className="co-pop-in w-[380px] rounded-xl border border-hairline bg-bg1 p-3"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-1 pb-2 text-[12px] font-semibold tracking-wide text-ink-faint uppercase">
          {t("common:move.title")}
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
              setCursor((c) => Math.min(filtered.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter" && filtered[sel]) {
              e.preventDefault();
              pick(filtered[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          placeholder={t("common:move.placeholder")}
          className="w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
        />
        <div className="mt-1.5 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-[12.5px] text-ink-faint">
              {folders ? t("common:move.noMatches") : t("common:move.loading")}
            </p>
          )}
          {filtered.map((f, i) => (
            <button
              key={f.id}
              className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink ${
                i === sel ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => pick(f)}
            >
              <span>{folderLabel(f)}</span>
              {f.role && <span className="text-[11px] text-ink-faint uppercase">{f.role}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
