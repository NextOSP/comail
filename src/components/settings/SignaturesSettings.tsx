import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type { Settings, Signature } from "../../ipc/types";
import { isHtmlEmpty, textToHtml } from "../../lib/richtext";
import { sanitizeSignatureHtml } from "../../lib/signatures";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { RichBody } from "../compose/RichBody";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { Button, ConfirmButton, EmptyState, FormField, inputCls, Segmented, Select, SettingRow, SettingsGroup, Toggle } from "./panelKit";
import { updateSettings } from "../../queries/settings";

type Defaults = Settings["signatureDefaults"];

/** Persist the signature list + defaults as one whole-object write. */
function writeSignatures(list: Signature[], defaults: Defaults) {
  return updateSettings({ signatureList: list, signatureDefaults: defaults });
}

/**
 * Signatures per account, folk / Gmail style: a compact list (name, default
 * badges, a rendered preview) where Edit opens a dialog with an explicit Save.
 * Nothing is written while typing, so a half-edited signature never leaks into
 * a draft.
 */
export function SignaturesSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  if ((accounts ?? []).length === 0) return null;
  return (
    <>
      {(accounts ?? []).map((a) => (
        <AccountSignatures
          key={a.id}
          accountId={a.id}
          email={a.email}
          displayName={a.displayName ?? ""}
          settings={settings}
          title={t("settings:signature.listTitle", { email: a.email })}
        />
      ))}
    </>
  );
}

type Editing = { sig: Signature | null };

function AccountSignatures({
  accountId,
  email,
  displayName,
  settings,
  title,
}: {
  accountId: number;
  email: string;
  displayName: string;
  settings: Settings;
  title: string;
}) {
  const { t } = useTranslation();
  const key = String(accountId);
  const sigs = settings.signatureList.filter((s) => s.accountId === accountId);
  const defs = settings.signatureDefaults[key] ?? {};
  const [editing, setEditing] = useState<Editing | null>(null);

  const setDefault = (field: "newId" | "replyId", id: string) => {
    void writeSignatures(settings.signatureList, {
      ...settings.signatureDefaults,
      [key]: { ...defs, [field]: id || null },
    });
  };

  // On = default both new and reply to a signature (keeping specific picks),
  // off = none.
  const autoAdd = Boolean(defs.newId || defs.replyId);
  const setAutoAdd = (enabled: boolean) => {
    const fallback = sigs[0]?.id ?? null;
    void writeSignatures(settings.signatureList, {
      ...settings.signatureDefaults,
      [key]: enabled
        ? { newId: defs.newId ?? fallback, replyId: defs.replyId ?? fallback }
        : { newId: null, replyId: null },
    });
  };

  return (
    <>
      <SettingsGroup
        title={title}
        flush
        actions={
          sigs.length > 0 && (
            <Button size="sm" icon="plus" onClick={() => setEditing({ sig: null })}>
              {t("settings:signature.add")}
            </Button>
          )
        }
      >
        {sigs.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon="edit"
              title={t("settings:signature.empty")}
              hint={t("settings:signature.emptyHint")}
              action={
                <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing({ sig: null })}>
                  {t("settings:signature.add")}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {sigs.map((sig) => (
              <SignatureRow
                key={sig.id}
                sig={sig}
                isNewDefault={defs.newId === sig.id}
                isReplyDefault={defs.replyId === sig.id}
                onEdit={() => setEditing({ sig })}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      {sigs.length > 0 && (
        <SettingsGroup>
          <SettingRow label={t("settings:signature.autoAdd")} hint={t("settings:signature.autoAddHint")}>
            <Toggle label={t("settings:signature.autoAdd")} checked={autoAdd} onChange={setAutoAdd} />
          </SettingRow>
          {autoAdd && (
            <DefaultSelect
              label={t("settings:signature.forNew")}
              value={defs.newId ?? ""}
              sigs={sigs}
              onChange={(id) => setDefault("newId", id)}
            />
          )}
          {autoAdd && (
            <DefaultSelect
              label={t("settings:signature.forReply")}
              value={defs.replyId ?? ""}
              sigs={sigs}
              onChange={(id) => setDefault("replyId", id)}
            />
          )}
        </SettingsGroup>
      )}

      {editing &&
        createPortal(
          <SignatureDialog
            sig={editing.sig}
            accountId={accountId}
            email={email}
            displayName={displayName}
            settings={settings}
            onClose={() => setEditing(null)}
          />,
          document.body,
        )}
    </>
  );
}

function SignatureRow({
  sig,
  isNewDefault,
  isReplyDefault,
  onEdit,
}: {
  sig: Signature;
  isNewDefault: boolean;
  isReplyDefault: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const empty = isHtmlEmpty(sig.html);
  return (
    <li className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-medium text-ink">
            {sig.name.trim() || t("settings:signature.untitled")}
          </span>
          {isNewDefault && <Badge>{t("settings:signature.defaultNewBadge")}</Badge>}
          {isReplyDefault && <Badge>{t("settings:signature.defaultReplyBadge")}</Badge>}
        </div>
        {empty ? (
          <div className="mt-1 text-sm text-ink-faint italic">{t("settings:signature.previewEmpty")}</div>
        ) : (
          // Rendered (sanitized) preview, clamped so the list stays compact.
          <div
            className="co-richbody co-signature pointer-events-none mt-1 line-clamp-3 text-sm leading-snug text-ink-muted"
            aria-readonly="true"
            dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtml(sig.html) }}
          />
        )}
      </div>
      <Button size="sm" icon="edit" onClick={onEdit}>
        {t("settings:signature.edit")}
      </Button>
    </li>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-accent/12 px-2 py-px text-2xs font-medium text-accent">
      {children}
    </span>
  );
}

type EditorMode = "rich" | "html";

/** Create / edit one signature. Local draft until Save. The signature is edited
 *  either in the rich editor or as HTML source (for a ready-made HTML
 *  signature, which pasting into the rich editor would reflow). */
function SignatureDialog({
  sig,
  accountId,
  email,
  displayName,
  settings,
  onClose,
}: {
  sig: Signature | null;
  accountId: number;
  email: string;
  displayName: string;
  settings: Settings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const isNew = sig == null;
  const [name, setName] = useState(sig?.name ?? "");
  // Only sanitized markup reaches the rich editor, which renders it live.
  const [original] = useState(() => sanitizeSignatureHtml(sig?.html ?? ""));
  const [html, setHtml] = useState(original);
  const [mode, setMode] = useState<EditorMode>("rich");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = isNew ? name.trim() !== "" || !isHtmlEmpty(html) : name !== sig.name || html !== original;

  const switchMode = (next: EditorMode) => {
    // Typed source is sanitized before the rich editor renders it, so going
    // back to HTML shows what will actually be kept.
    if (next === "rich") setHtml((cur) => sanitizeSignatureHtml(cur));
    setMode(next);
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const text = await call("ai_signature", { name: displayName || email, email });
      setHtml(textToHtml(text.trim()));
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    setSaving(true);
    const key = String(accountId);
    const finalName = name.trim() || t("settings:signature.newName");
    // HTML typed in source mode has not been through the sanitizer yet.
    const clean = sanitizeSignatureHtml(html);
    let list: Signature[];
    let defaults = settings.signatureDefaults;
    if (isNew) {
      const created: Signature = { id: crypto.randomUUID(), accountId, name: finalName, html: clean };
      list = [...settings.signatureList, created];
      // The account's first signature becomes its default for new mail and
      // replies, so it is used without a second trip to the toggles below.
      const cur = defaults[key] ?? {};
      if (!settings.signatureList.some((s) => s.accountId === accountId) && !cur.newId && !cur.replyId) {
        defaults = { ...defaults, [key]: { newId: created.id, replyId: created.id } };
      }
    } else {
      list = settings.signatureList.map((s) => (s.id === sig.id ? { ...s, name: finalName, html: clean } : s));
    }
    try {
      await writeSignatures(list, defaults);
      pushToast({ kind: "info", message: t("settings:signature.saved") });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!sig) return;
    const key = String(accountId);
    const cur = settings.signatureDefaults[key] ?? {};
    await writeSignatures(
      settings.signatureList.filter((s) => s.id !== sig.id),
      {
        ...settings.signatureDefaults,
        [key]: {
          newId: cur.newId === sig.id ? null : cur.newId,
          replyId: cur.replyId === sig.id ? null : cur.replyId,
        },
      },
    );
    onClose();
  };

  return (
    <Modal onClose={onClose} width={620} top="10vh" closeOnEsc labelledBy="signature-dialog-title">
      <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="signature-dialog-title" className="text-md font-semibold text-ink">
            {isNew ? t("settings:signature.newTitle") : t("settings:signature.editTitle")}
          </h2>
          <p className="mt-0.5 truncate text-sm text-ink-faint">{t("settings:signature.editHint", { email })}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-control p-1.5 text-ink-faint hover:bg-bg2 hover:text-ink"
          aria-label={t("settings:signature.cancel")}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-4 px-5 py-5">
        <FormField label={t("settings:signature.nameLabel")}>
          <input
            className={inputCls}
            value={name}
            placeholder={t("settings:signature.newName")}
            autoFocus={isNew}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-faint">{t("settings:signature.editorLabel")}</span>
            <div className="flex items-center gap-2">
              <Segmented<EditorMode>
                value={mode}
                options={[
                  { value: "rich", label: t("settings:signature.modeRich") },
                  { value: "html", label: t("settings:signature.modeHtml") },
                ]}
                onChange={switchMode}
              />
              <Button
                variant="ai"
                size="sm"
                busy={generating}
                title={t("settings:signature.aiHint")}
                onClick={() => void generate()}
              >
                {generating ? t("settings:signature.aiGenerating") : t("settings:signature.aiHint")}
              </Button>
            </div>
          </div>
          {mode === "rich" ? (
            // co-signature: tables and images render as recipients see them.
            <div className="co-signature rounded-control border border-hairline bg-bg0 px-3 pb-1 focus-within:border-accent/60">
              <RichBody
                value={html}
                onChange={setHtml}
                placeholder={t("settings:signature.placeholder")}
                minHeightClass="min-h-[140px]"
              />
            </div>
          ) : (
            <>
              <textarea
                className={`${inputCls} min-h-[180px] resize-y font-mono !text-sm leading-relaxed`}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                spellCheck={false}
                autoFocus
                aria-label={t("settings:signature.htmlLabel")}
                placeholder={t("settings:signature.htmlPlaceholder")}
                data-testid="signature-html"
              />
              <p className="text-xs text-ink-faint">{t("settings:signature.htmlHint")}</p>
            </>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-hairline px-5 py-3">
        {!isNew && (
          <ConfirmButton
            label={t("settings:signature.delete")}
            confirmLabel={t("settings:signature.deleteConfirm")}
            onConfirm={() => void remove()}
          />
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t("settings:signature.cancel")}
        </Button>
        <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>
          {t("settings:signature.save")}
        </Button>
      </footer>
    </Modal>
  );
}

function DefaultSelect({
  label,
  value,
  sigs,
  onChange,
}: {
  label: string;
  value: string;
  sigs: Signature[];
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingRow label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="!w-[240px]">
        <option value="">{t("settings:signature.none")}</option>
        {sigs.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name.trim() || t("settings:signature.untitled")}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}
