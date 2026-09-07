import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { AiAutomationRule, Label, RuleCondition, Settings, SplitRule } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useLabels, useSplits } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Button, ConfirmButton, EmptyState, FormField, inputCls, SettingsGroup, Toggle } from "./panelKit";
import { newRule, RuleForm } from "./RulesEditor";
import { invalidateSplitViews } from "./SplitsPanel";

import { LABEL_COLORS as SWATCHES } from "../../lib/labelColors";
export { SWATCHES };

function invalidateLabelViews() {
  void queryClient.invalidateQueries({ queryKey: ["labels"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  // Deleting an auto category re-routes its threads to Important/Other.
  void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
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

/** The split that shows exactly this label as an inbox tab, if any. */
function labelTabSplit(splits: SplitRule[], labelId: number): SplitRule | undefined {
  const only = (c: RuleCondition | null | undefined): boolean =>
    !!c &&
    ((c.kind === "label" && c.id === labelId) ||
      ((c.kind === "all" || c.kind === "any") && c.of.length === 1 && only(c.of[0])));
  return splits.find(
    (s) =>
      s.target == null &&
      (s.condition
        ? only(s.condition)
        : s.query.labels?.length === 1 &&
          s.query.labels[0] === labelId &&
          Object.keys(s.query).length === 1),
  );
}

/** Rules whose actions add this label. */
function rulesAdding(rules: AiAutomationRule[], labelId: number) {
  return rules.filter((r) =>
    r.actions.some((a) => a.kind === "add_label" && a.value === String(labelId)),
  );
}

/** Label management, hosted inside the Settings panel. Each user label can be
 *  auto-applied by rules (condition and/or AI check) and shown as its own
 *  split-inbox tab. */
export function LabelsSection({
  settings,
  commitRules,
}: {
  settings: Settings;
  commitRules: (rules: AiAutomationRule[]) => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: labels } = useLabels();
  const { data: splits } = useSplits();
  const [editing, setEditing] = useState<Label | "new" | null>(null);
  const [ruleDraft, setRuleDraft] = useState<AiAutomationRule | null>(null);
  const [tabBusy, setTabBusy] = useState<number | null>(null);
  const rules = settings.aiAutomationRules;

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

  const toggleTab = async (label: Label, on: boolean) => {
    setTabBusy(label.id);
    try {
      const existing = labelTabSplit(splits ?? [], label.id);
      if (on && !existing) {
        await call("save_split", {
          split: {
            id: null,
            name: label.name,
            position: splits?.length ?? 0,
            query: {},
            condition: { kind: "label", id: label.id },
            target: null,
            countAll: false,
          },
        });
      } else if (!on && existing) {
        await call("delete_split", { splitId: existing.id });
      }
    } catch (err) {
      pushToast({ kind: "error", message: t("settings:labels.tabFailed", { detail: errorMessage(err) }) });
    } finally {
      setTabBusy(null);
      invalidateSplitViews();
    }
  };

  const openAutoApply = (label: Label) => {
    // One dedicated rule per label is the common case: edit it in place.
    const own = rulesAdding(rules, label.id);
    setRuleDraft(
      own.length === 1
        ? structuredClone(own[0])
        : newRule({
            name: t("settings:labels.autoRuleName", { name: label.name }),
            actions: [{ kind: "add_label", value: String(label.id) }],
          }),
    );
  };

  return (
    <>
      {ruleDraft != null ? (
        <RuleForm
          rules={rules}
          initial={ruleDraft}
          commit={commitRules}
          onDone={() => setRuleDraft(null)}
        />
      ) : editing != null ? (
        <LabelForm
          label={editing === "new" ? null : editing}
          nextPosition={ordered.length}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          {ordered.length === 0 ? (
            <EmptyState
              title={t("settings:labels.empty")}
              action={
                <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>
                  {t("settings:labels.new")}
                </Button>
              }
            />
          ) : (
            <SettingsGroup
              title={t("settings:labels.yourLabels")}
              actions={
                <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>
                  {t("settings:labels.new")}
                </Button>
              }
            >
              {ordered.map((l) => (
                <div key={l.id} className="flex items-center gap-2.5">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: l.color }} />
                  <span className="min-w-0 flex-1 truncate text-base text-ink">{l.name}</span>
                  {/* Auto categories are sorted by the classifier and already have tabs. */}
                  {!l.isAuto && (
                    <>
                      <Button
                        size="sm"
                        icon="sparkle"
                        onClick={() => openAutoApply(l)}
                        title={t("settings:labels.autoApplyHint")}
                      >
                        {rulesAdding(rules, l.id).length > 0
                          ? t("settings:labels.autoApplyCount", { count: rulesAdding(rules, l.id).length })
                          : t("settings:labels.autoApply")}
                      </Button>
                      <span className="flex items-center gap-1.5 text-xs text-ink-faint">
                        <Toggle
                          label={t("settings:labels.showAsTab", { name: l.name })}
                          checked={labelTabSplit(splits ?? [], l.id) != null}
                          onChange={(on) => {
                            if (tabBusy == null) void toggleTab(l, on);
                          }}
                        />
                        {t("settings:labels.tab")}
                      </span>
                    </>
                  )}
                  <Button size="sm" icon="edit" onClick={() => setEditing(l)}>
                    {t("settings:labels.edit")}
                  </Button>
                  <ConfirmButton
                    label={t("settings:labels.delete")}
                    confirmLabel={t("settings:labels.reallyDelete")}
                    onConfirm={() => void deleteLabel(l.id)}
                  />
                </div>
              ))}
            </SettingsGroup>
          )}
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
        <span className="text-xs font-medium text-ink-faint">{t("settings:labels.colorLabel")}</span>
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
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
          {busy
            ? t("settings:labels.saving")
            : label
              ? t("settings:labels.saveChanges")
              : t("settings:labels.create")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("settings:labels.cancel")}
        </Button>
      </div>
    </form>
  );
}
