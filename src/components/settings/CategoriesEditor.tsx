import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Label, Settings } from "../../ipc/types";
import { LABEL_COLORS } from "../../lib/labelColors";
import { queryClient } from "../../queries/client";
import { useLabels } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { Button, ConfirmButton, inputCls } from "./panelKit";

const BUILTIN = new Set([
  "ComailAutoMarketing",
  "ComailAutoNews",
  "ComailAutoSocial",
  "ComailAutoPitch",
]);

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: ["labels"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
}

/** The categories the AI sorts into (auto labels): rename, describe for the
 *  model, add custom ones, remove. Built-ins also work with no AI (header
 *  heuristic); custom ones need a decision or chat model. */
export function CategoriesEditor({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: labels } = useLabels();
  const categories = (labels ?? [])
    .filter((l) => l.isAuto)
    .sort((a, b) => a.position - b.position);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const setDescriptionFor = (keyword: string, text: string) => {
    const next = { ...settings.aiCategoryDescriptions };
    if (text.trim()) next[keyword] = text.trim();
    else delete next[keyword];
    update({ aiCategoryDescriptions: next });
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await call("create_category", {
        name: name.trim(),
        color: LABEL_COLORS[(categories.length + 4) % LABEL_COLORS.length],
        description: description.trim(),
      });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      invalidate();
      setName("");
      setDescription("");
      setAdding(false);
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (label: Label) => {
    try {
      await call("delete_label", { labelId: label.id });
      if (settings.aiCategoryDescriptions[label.keyword] != null) {
        setDescriptionFor(label.keyword, "");
      }
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      invalidate();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {categories.map((c) => (
        <CategoryRow
          key={c.id}
          label={c}
          builtin={BUILTIN.has(c.keyword)}
          description={settings.aiCategoryDescriptions[c.keyword] ?? ""}
          onDescription={(text) => setDescriptionFor(c.keyword, text)}
          onRemove={() => void remove(c)}
        />
      ))}
      {adding ? (
        <form
          className="flex flex-col gap-2 rounded-card border border-hairline bg-bg0 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings:categories.namePlaceholder")}
            autoFocus
            spellCheck={false}
          />
          <textarea
            className={`${inputCls} resize-y !text-sm leading-relaxed`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("settings:categories.descriptionPlaceholder")}
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!name.trim()}>
              {t("settings:categories.create")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {t("settings:labels.cancel")}
            </Button>
            <span className="ml-auto text-2xs text-ink-faint">
              {t("settings:categories.needsAi")}
            </span>
          </div>
        </form>
      ) : (
        <Button size="sm" icon="plus" className="self-start" onClick={() => setAdding(true)}>
          {t("settings:categories.add")}
        </Button>
      )}
    </div>
  );
}

function CategoryRow({
  label,
  builtin,
  description,
  onDescription,
  onRemove,
}: {
  label: Label;
  builtin: boolean;
  description: string;
  onDescription: (text: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(description);
  useEffect(() => setText(description), [description]);
  return (
    <div className="rounded-card border border-hairline bg-bg1 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: label.color }} />
        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{label.name}</span>
        {!builtin && (
          <span className="rounded-full bg-bg2 px-2 py-0.5 text-2xs text-ink-faint">
            {t("settings:categories.custom")}
          </span>
        )}
        <ConfirmButton
          label={t("settings:labels.delete")}
          confirmLabel={t("settings:labels.reallyDelete")}
          onConfirm={onRemove}
        />
      </div>
      <textarea
        className={`${inputCls} mt-2 w-full resize-y !text-sm leading-relaxed`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== description && onDescription(text)}
        placeholder={
          builtin
            ? t(`settings:categories.builtin.${label.keyword}`)
            : t("settings:categories.descriptionPlaceholder")
        }
        aria-label={t("settings:categories.descriptionLabel", { name: label.name })}
        rows={1}
      />
    </div>
  );
}
