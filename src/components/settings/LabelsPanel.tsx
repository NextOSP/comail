import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Label } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useLabels } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { ConfirmButton, FormField, ghostBtnCls, inputCls, primaryBtnCls } from "./panelKit";

const SWATCHES = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#6b7280"];

function invalidateLabelViews() {
  void queryClient.invalidateQueries({ queryKey: ["labels"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
}

/** Compat shim: label management moved into Settings → Labels.
 *  Anything that still opens panel:"labels" is redirected there. */
export function LabelsPanel() {
  const open = useUi((s) => s.panel === "labels");
  const set = useUi((s) => s.set);
  useEffect(() => {
    if (open) set({ panel: "settings", settingsTab: "labels" });
  }, [open, set]);
  return null;
}

/** Label management, hosted inside the Settings panel. */
export function LabelsSection() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: labels } = useLabels();
  const [editing, setEditing] = useState<Label | "new" | null>(null);

  const ordered = [...(labels ?? [])].sort((a, b) => a.position - b.position);

  const deleteLabel = async (labelId: number) => {
    try {
      await call("delete_label", { labelId });
    } catch (err) {
      pushToast({ kind: "error", message: t("settings:labels.deleteFailed", { detail: errorMessage(err) }) });
    } finally {
      invalidateLabelViews();
    }
  };

  return (
    <>
      {editing != null ? (
        <LabelForm
          label={editing === "new" ? null : editing}
          nextPosition={ordered.length}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
              {t("settings:labels.yourLabels")}
            </span>
            <button className={primaryBtnCls} onClick={() => setEditing("new")}>
              {t("settings:labels.new")}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {ordered.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg0 px-3 py-2"
              >
                <span className="size-3 shrink-0 rounded-full" style={{ background: l.color }} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{l.name}</span>
                <button
                  className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-ink-muted hover:bg-bg2"
                  onClick={() => setEditing(l)}
                >
                  {t("settings:labels.edit")}
                </button>
                <ConfirmButton
                  label={t("settings:labels.delete")}
                  confirmLabel={t("settings:labels.reallyDelete")}
                  onConfirm={() => void deleteLabel(l.id)}
                />
              </div>
            ))}
            {ordered.length === 0 && (
              <p className="py-4 text-center text-[12.5px] text-ink-faint">
                {t("settings:labels.empty")}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function LabelForm({
  label,
  nextPosition,
  onDone,
}: {
  label: Label | null;
  nextPosition: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? SWATCHES[0]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await call("save_label", {
        label: {
          id: label?.id ?? null,
          name: name.trim(),
          color,
          position: label?.position ?? nextPosition,
        },
      });
      invalidateLabelViews();
      onDone();
    } catch (err) {
      pushToast({ kind: "error", message: t("settings:labels.saveFailed", { detail: errorMessage(err) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <FormField label={t("settings:labels.nameLabel")}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings:labels.namePlaceholder")}
          autoFocus
          spellCheck={false}
        />
      </FormField>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11.5px] font-medium text-ink-faint">{t("settings:labels.colorLabel")}</span>
        <div className="flex flex-wrap gap-2">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setColor(c)}
              className={`size-6 rounded-full transition ${
                color === c ? "ring-2 ring-accent ring-offset-2 ring-offset-bg1" : ""
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={primaryBtnCls} disabled={busy || !name.trim()}>
          {busy
            ? t("settings:labels.saving")
            : label
              ? t("settings:labels.saveChanges")
              : t("settings:labels.create")}
        </button>
        <button type="button" className={ghostBtnCls} onClick={onDone}>
          {t("settings:labels.cancel")}
        </button>
      </div>
    </form>
  );
}
