import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Label, SplitRule, SplitRuleQuery } from "../../ipc/types";
import { mergeTabOrder } from "../../lib/splitOrder";
import { queryClient } from "../../queries/client";
import { useLabels, useSplits } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import {
  ChipInput,
  ConfirmButton,
  FormField,
  ghostBtnCls,
  inputCls,
  primaryBtnCls,
  Segmented,
  Select,
} from "./panelKit";

type Automated = "any" | "automated" | "human";

const DEFAULT_AUTO_LABEL_KEYWORDS = [
  "ComailAutoMarketing",
  "ComailAutoNews",
  "ComailAutoSocial",
  "ComailAutoPitch",
];

function invalidateSplitViews() {
  void queryClient.invalidateQueries({ queryKey: ["splits"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
}

function describeQuery(q: SplitRuleQuery, t: TFunction): string {
  const parts: string[] = [];
  if (q.senders?.length)
    parts.push(t("settings:splits.describe.from", { senders: q.senders.join(", ") }));
  if (q.recipients?.length)
    parts.push(t("settings:splits.describe.to", { recipients: q.recipients.join(", ") }));
  if (q.subjectContains?.length)
    parts.push(t("settings:splits.describe.subjectHas", { subjects: q.subjectContains.join(", ") }));
  if (q.isAutomated === true) parts.push(t("settings:splits.describe.automatedOnly"));
  if (q.isAutomated === false) parts.push(t("settings:splits.describe.humanOnly"));
  if (q.hasAttachment) parts.push(t("settings:splits.describe.hasAttachment"));
  return parts.join(" · ") || t("settings:splits.describe.nothing");
}

/** Human name for a route target key ("important" | "other" | "label:<id>"). */
function targetName(
  target: string | null | undefined,
  labels: { id: number; name: string }[],
  t: TFunction,
): string {
  if (!target) return t("settings:splits.target.ownTab");
  if (target === "important") return t("inbox:split.important");
  if (target === "other") return t("inbox:split.other");
  const id = Number(target.slice("label:".length));
  return labels.find((l) => l.id === id)?.name ?? t("settings:splits.target.ownTab");
}

/** Compat shim: split management moved into Settings → Split inbox.
 *  Anything that still opens panel:"splits" is redirected there. */
export function SplitsPanel() {
  const open = useUi((s) => s.panel === "splits");
  const set = useUi((s) => s.set);
  useEffect(() => {
    if (open) set({ panel: "settings", settingsTab: "splits" });
  }, [open, set]);
  return null;
}

/** Split-inbox management, hosted inside the Settings panel. */
export function SplitInboxSection() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const [editing, setEditing] = useState<SplitRule | "new" | null>(null);
  const [relabeling, setRelabeling] = useState(false);
  const [restoringDefaults, setRestoringDefaults] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Custom splits and auto-label tabs share one order (see mergeTabOrder).
  const items = mergeTabOrder(splits, labels);
  const hasAutoLabels = items.some((it) => it.kind === "label");
  const missingAutoLabels = labels
    ? DEFAULT_AUTO_LABEL_KEYWORDS.filter(
        (keyword) => !labels.some((label) => label.isAuto && label.keyword === keyword),
      ).length
    : 0;

  const relabel = async () => {
    if (relabeling) return;
    setRelabeling(true);
    try {
      const n = await call("relabel_auto", {});
      pushToast({ kind: "info", message: t("settings:splits.relabeled", { count: n }) });
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setRelabeling(false);
    }
  };

  const restoreDefaults = async () => {
    if (restoringDefaults) return;
    setRestoringDefaults(true);
    try {
      const count = await call("restore_auto_labels", {});
      pushToast({ kind: "info", message: t("settings:splits.restoredDefaults", { count }) });
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setRestoringDefaults(false);
    }
  };

  // Move the tab at `from` so it sits at `to` (higher = earlier = wins first).
  // Custom splits and auto-label tabs share one order, so this drives both.
  const reorderTo = async (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // optimistic: renumber both caches so every tab reorders immediately
    const posOf = new Map(next.map((it, i) => [`${it.kind}:${it.id}`, i]));
    queryClient.setQueryData<SplitRule[]>(["splits"], (old) =>
      (old ?? []).map((s) => ({ ...s, position: posOf.get(`split:${s.id}`) ?? s.position })),
    );
    queryClient.setQueryData<Label[]>(["labels"], (old) =>
      (old ?? []).map((l) => ({ ...l, position: posOf.get(`label:${l.id}`) ?? l.position })),
    );
    try {
      await call("reorder_tabs", { order: next.map((it) => ({ kind: it.kind, id: it.id })) });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.reorderFailed", { detail: errorMessage(err) }),
      });
    } finally {
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    }
  };

  const deleteSplit = async (splitId: number) => {
    try {
      await call("delete_split", { splitId });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.deleteFailed", { detail: errorMessage(err) }),
      });
    } finally {
      invalidateSplitViews();
    }
  };

  const deleteLabel = async (labelId: number) => {
    try {
      await call("delete_label", { labelId });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      invalidateSplitViews();
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    }
  };

  return (
    <section className="flex flex-col">
      {editing != null ? (
        <SplitForm
          rule={editing === "new" ? null : editing}
          nextPosition={items.length}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          {/* Important is the fixed first fallback bucket. */}
          <div className="mb-3 flex flex-col gap-1.5 opacity-55">
            <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg2 px-3 py-2">
              <span className="text-[13.5px] text-ink">{t("settings:splits.builtin.importantName")}</span>
              <span className="text-[11.5px] text-ink-faint">{t("settings:splits.builtin.importantDesc")}</span>
              <span className="ml-auto rounded bg-bg3 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("settings:splits.builtin.firstBadge")}
              </span>
            </div>
          </div>
          <p className="mb-4 text-[11.5px] text-ink-faint">
            {t("settings:splits.builtinNote")}
          </p>

          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
              {t("settings:splits.customSplits")}
            </span>
            <div className="flex items-center gap-2">
              {missingAutoLabels > 0 && (
                <button
                  className={ghostBtnCls}
                  disabled={restoringDefaults}
                  onClick={() => void restoreDefaults()}
                >
                  {restoringDefaults
                    ? t("settings:splits.restoringDefaults")
                    : t("settings:splits.restoreDefaults", { count: missingAutoLabels })}
                </button>
              )}
              {hasAutoLabels && (
                <button className={ghostBtnCls} disabled={relabeling} onClick={() => void relabel()}>
                  {relabeling ? t("settings:splits.relabeling") : t("settings:splits.relabel")}
                </button>
              )}
              <button className={primaryBtnCls} onClick={() => setEditing("new")}>
                {t("settings:splits.new")}
              </button>
            </div>
          </div>
          {items.length > 1 && (
            <p className="mb-2 text-[11.5px] text-ink-faint">{t("settings:splits.priorityHint")}</p>
          )}
          <div className="flex flex-col gap-1.5">
            {items.map((it, i) => (
              <div
                key={it.kind + it.id}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null) void reorderTo(dragIndex, i);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={`flex items-center gap-2.5 rounded-lg border bg-bg0 px-3 py-2 transition-colors ${
                  dragIndex === i
                    ? "border-hairline opacity-40"
                    : overIndex === i && dragIndex !== null
                      ? "border-accent"
                      : "border-hairline"
                }`}
              >
                <span
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  title={t("settings:splits.dragHint")}
                  className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md bg-bg2 text-[12px] font-semibold text-ink-muted select-none active:cursor-grabbing"
                >
                  {i + 1}
                </span>
                <div className="flex shrink-0 flex-col">
                  <OrderButton dir="up" disabled={i === 0} onClick={() => void reorderTo(i, i - 1)} />
                  <OrderButton
                    dir="down"
                    disabled={i === items.length - 1}
                    onClick={() => void reorderTo(i, i + 1)}
                  />
                </div>
                {it.kind === "label" && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: it.label.color }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{it.name}</span>
                  {it.kind === "split" && (
                    <span className="block truncate text-[11.5px] text-ink-faint">
                      {describeQuery(it.rule.query, t)}
                      {it.rule.target ? ` → ${targetName(it.rule.target, labels ?? [], t)}` : ""}
                    </span>
                  )}
                </span>
                {it.kind === "label" ? (
                  <>
                    <span className="rounded bg-bg2 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                      {t("settings:splits.autoBadge")}
                    </span>
                    <ConfirmButton
                      label={t("settings:splits.delete")}
                      confirmLabel={t("settings:splits.reallyDelete")}
                      onConfirm={() => void deleteLabel(it.id)}
                    />
                  </>
                ) : (
                  <>
                    <button
                      className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-ink-muted hover:bg-bg2"
                      onClick={() => setEditing(it.rule)}
                    >
                      {t("settings:splits.edit")}
                    </button>
                    <ConfirmButton
                      label={t("settings:splits.delete")}
                      confirmLabel={t("settings:splits.reallyDelete")}
                      onConfirm={() => void deleteSplit(it.id)}
                    />
                  </>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <p className="py-4 text-center text-[12.5px] text-ink-faint">
                {t("settings:splits.empty")}
              </p>
            )}
          </div>
          {/* Other catches anything no earlier tab matched, so it is always last. */}
          <div className="mt-3 flex flex-col gap-1.5 opacity-55">
            <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg2 px-3 py-2">
              <span className="text-[13.5px] text-ink">{t("settings:splits.builtin.otherName")}</span>
              <span className="text-[11.5px] text-ink-faint">{t("settings:splits.builtin.otherDesc")}</span>
              <span className="ml-auto rounded bg-bg3 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("settings:splits.builtin.lastBadge")}
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function OrderButton({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={dir === "up" ? t("settings:splits.moveUp") : t("settings:splits.moveDown")}
      disabled={disabled}
      onClick={onClick}
      className="flex h-3.5 w-5 items-center justify-center rounded text-ink-faint hover:bg-bg2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {dir === "up" ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
      </svg>
    </button>
  );
}

/** Labeled chip editor. Not a <label>: the chips' delete buttons would otherwise
 *  swallow the field's accessible name (same reason the Mail type row isn't one). */
function LabeledChips({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-ink-faint">{label}</span>
      <ChipInput
        values={values}
        onChange={onChange}
        placeholder={placeholder}
        ariaLabel={label}
        removeLabel={t("settings:splits.removeToken")}
      />
    </div>
  );
}

function SplitForm({
  rule,
  nextPosition,
  onDone,
}: {
  rule: SplitRule | null;
  nextPosition: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: labels } = useLabels();
  const autoLabels = (labels ?? []).filter((l) => l.isAuto);
  const [name, setName] = useState(rule?.name ?? "");
  const [senders, setSenders] = useState<string[]>(rule?.query.senders ?? []);
  const [recipients, setRecipients] = useState<string[]>(rule?.query.recipients ?? []);
  const [subjects, setSubjects] = useState<string[]>(rule?.query.subjectContains ?? []);
  const [automated, setAutomated] = useState<Automated>(
    rule?.query.isAutomated === true ? "automated" : rule?.query.isAutomated === false ? "human" : "any",
  );
  const [hasAttachment, setHasAttachment] = useState(rule?.query.hasAttachment === true);
  // "" = the rule is its own tab; otherwise a route key routed into an existing tab.
  const [target, setTarget] = useState<string>(rule?.target ?? "");
  const [busy, setBusy] = useState(false);

  const hasCondition =
    senders.length > 0 ||
    recipients.length > 0 ||
    subjects.length > 0 ||
    automated !== "any" ||
    hasAttachment;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const query: SplitRuleQuery = {};
      if (senders.length > 0) query.senders = senders;
      if (recipients.length > 0) query.recipients = recipients;
      if (subjects.length > 0) query.subjectContains = subjects;
      if (automated !== "any") query.isAutomated = automated === "automated";
      if (hasAttachment) query.hasAttachment = true;
      await call("save_split", {
        split: {
          id: rule?.id ?? null,
          name: name.trim(),
          position: rule?.position ?? nextPosition,
          query,
          target: target || null,
        },
      });
      invalidateSplitViews();
      onDone();
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:splits.saveFailed", { detail: errorMessage(err) }),
      });
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
        // Esc backs out of the form; a second Esc closes the panel.
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <FormField label={t("settings:splits.nameLabel")}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings:splits.namePlaceholder")}
          autoFocus
          spellCheck={false}
        />
      </FormField>
      <LabeledChips
        label={t("settings:splits.senderLabel")}
        values={senders}
        onChange={setSenders}
        placeholder={t("settings:splits.senderPlaceholder")}
      />
      <LabeledChips
        label={t("settings:splits.recipientLabel")}
        values={recipients}
        onChange={setRecipients}
        placeholder={t("settings:splits.recipientPlaceholder")}
      />
      <LabeledChips
        label={t("settings:splits.subjectLabel")}
        values={subjects}
        onChange={setSubjects}
        placeholder={t("settings:splits.subjectPlaceholder")}
      />
      {/* not a <label>: it would swallow the segmented buttons' accessible names */}
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-faint">
          {t("settings:splits.automatedLabel")}
        </span>
        <div className="self-start">
          <Segmented<Automated>
            value={automated}
            options={[
              { value: "any", label: t("settings:splits.automated.any") },
              { value: "automated", label: t("settings:splits.automated.automated") },
              { value: "human", label: t("settings:splits.automated.human") },
            ]}
            onChange={setAutomated}
          />
        </div>
        <span className="text-[11.5px] text-ink-faint">
          {t("settings:splits.automatedHint")}
        </span>
      </div>
      <label className="flex cursor-pointer items-center gap-2 self-start">
        <input
          type="checkbox"
          checked={hasAttachment}
          onChange={(e) => setHasAttachment(e.target.checked)}
          className="size-4 accent-accent"
        />
        <span className="text-[12.5px] text-ink">{t("settings:splits.hasAttachmentLabel")}</span>
      </label>
      <FormField label={t("settings:splits.targetLabel")}>
        <Select
          className="self-start"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{t("settings:splits.target.ownTab")}</option>
          <option value="important">{t("inbox:split.important")}</option>
          <option value="other">{t("inbox:split.other")}</option>
          {autoLabels.map((l) => (
            <option key={l.id} value={`label:${l.id}`}>
              {l.name}
            </option>
          ))}
        </Select>
      </FormField>
      <p className="-mt-1 text-[11.5px] text-ink-faint">{t("settings:splits.targetHint")}</p>
      {!hasCondition && (
        <p className="text-[11.5px] text-ink-faint">{t("settings:splits.addCondition")}</p>
      )}
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={primaryBtnCls} disabled={busy || !name.trim() || !hasCondition}>
          {busy
            ? t("settings:splits.saving")
            : rule
              ? t("settings:splits.saveChanges")
              : t("settings:splits.create")}
        </button>
        <button type="button" className={ghostBtnCls} onClick={onDone}>
          {t("settings:splits.cancel")}
        </button>
      </div>
    </form>
  );
}
