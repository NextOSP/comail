import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Snippet } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useSnippets } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import {
  ConfirmButton,
  FormField,
  ghostBtnCls,
  inputCls,
  primaryBtnCls,
} from "./panelKit";

/** Compat shim: snippet management moved into Settings → Snippets.
 *  Anything that still opens panel:"snippets" is redirected there. */
export function SnippetsPanel() {
  const open = useUi((s) => s.panel === "snippets");
  const set = useUi((s) => s.set);
  useEffect(() => {
    if (open) set({ panel: "settings", settingsTab: "snippets" });
  }, [open, set]);
  return null;
}

/** Snippet management, hosted inside the Settings panel. */
export function SnippetsSection() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: snippets } = useSnippets();
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);

  const deleteSnippet = async (snippetId: number) => {
    try {
      await call("delete_snippet", { snippetId });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:snippets.deleteFailed", { detail: errorMessage(err) }),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["snippets"] });
    }
  };

  return (
    <>
      {editing != null ? (
        <SnippetForm
          snippet={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[12px] text-ink-faint">
              <Trans
                i18nKey="settings:snippets.expandHint"
                components={{ kbd: <span className="font-mono text-accent" /> }}
              />
            </p>
            <button className={primaryBtnCls} onClick={() => setEditing("new")}>
              {t("settings:snippets.new")}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {(snippets ?? []).map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg0 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-[13.5px] text-ink">{s.name}</span>
                  {s.shortcut && (
                    <span className="ml-2 font-mono text-[11.5px] text-accent">;{s.shortcut}</span>
                  )}
                </span>
                <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">
                  {t("settings:snippets.usedCount", { n: s.usageCount })}
                </span>
                <button
                  className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-ink-muted hover:bg-bg2"
                  onClick={() => setEditing(s)}
                >
                  {t("settings:snippets.edit")}
                </button>
                <ConfirmButton
                  label={t("settings:snippets.delete")}
                  confirmLabel={t("settings:snippets.reallyDelete")}
                  onConfirm={() => void deleteSnippet(s.id)}
                />
              </div>
            ))}
            {(snippets ?? []).length === 0 && (
              <p className="py-4 text-center text-[12.5px] text-ink-faint">
                {t("settings:snippets.empty")}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function SnippetForm({ snippet, onDone }: { snippet: Snippet | null; onDone: () => void }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [name, setName] = useState(snippet?.name ?? "");
  const [shortcut, setShortcut] = useState(snippet?.shortcut ?? "");
  const [subject, setSubject] = useState(snippet?.subject ?? "");
  const [body, setBody] = useState(snippet?.bodyText ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await call("save_snippet", {
        snippet: {
          id: snippet?.id ?? null,
          name: name.trim(),
          shortcut: shortcut.trim().replace(/^;+/, "") || null,
          subject: subject.trim() || null,
          bodyText: body,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["snippets"] });
      onDone();
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:snippets.saveFailed", { detail: errorMessage(err) }),
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
      <div className="grid grid-cols-[1fr_160px] gap-2">
        <FormField label={t("settings:snippets.nameLabel")}>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings:snippets.namePlaceholder")}
            autoFocus
            spellCheck={false}
          />
        </FormField>
        <FormField label={t("settings:snippets.shortcutLabel")}>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[13px] text-ink-faint">;</span>
            <input
              className={inputCls}
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.replace(/\s/g, ""))}
              placeholder={t("settings:snippets.shortcutPlaceholder")}
              spellCheck={false}
            />
          </div>
        </FormField>
      </div>
      <FormField label={t("settings:snippets.subjectLabel")}>
        <input
          className={inputCls}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t("settings:snippets.subjectPlaceholder")}
          spellCheck={false}
        />
      </FormField>
      <FormField label={t("settings:snippets.bodyLabel")}>
        <textarea
          className={`${inputCls} min-h-[140px] resize-y font-mono leading-relaxed`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("settings:snippets.bodyPlaceholder")}
        />
      </FormField>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={primaryBtnCls} disabled={busy || !name.trim() || !body.trim()}>
          {busy
            ? t("settings:snippets.saving")
            : snippet
              ? t("settings:snippets.saveChanges")
              : t("settings:snippets.create")}
        </button>
        <button type="button" className={ghostBtnCls} onClick={onDone}>
          {t("settings:snippets.cancel")}
        </button>
      </div>
    </form>
  );
}
