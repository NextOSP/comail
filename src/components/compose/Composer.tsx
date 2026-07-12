import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import { call } from "../../ipc/commands";
import { MOCK_MODE } from "../../ipc/mock";
import type { Address, DraftAttachment, MessageDetail, Snippet } from "../../ipc/types";
import { RecipientField } from "./RecipientField";
import { onComposerAction } from "../../keyboard/commands";
import { advanceAfter, buildCommandContext } from "../../keyboard/context";
import { addressName, longTime, MOD_LABEL } from "../../lib/format";
import { performThreadAction } from "../../queries/actions";
import { queryClient } from "../../queries/client";
import { useAccounts, useSettings, useSnippets } from "../../queries/hooks";
import { useUi, type ComposerState } from "../../stores/ui";
import { TimePopover } from "../common/TimePopover";

function quote(m: MessageDetail): string {
  const body = (m.textBody ?? m.snippet)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const header = i18n.t("compose:quoteHeader", {
    date: longTime(m.date),
    name: addressName(m.from),
    email: m.from.email,
  });
  return `${header}\n${body}`;
}

function forwardBlock(m: MessageDetail): string {
  return [
    i18n.t("compose:forwardedMessage"),
    i18n.t("compose:forwardFrom", { name: addressName(m.from), email: m.from.email }),
    i18n.t("compose:forwardDate", { date: longTime(m.date) }),
    i18n.t("compose:forwardSubject", { subject: m.subject }),
    i18n.t("compose:forwardTo", { recipients: m.to.map((a) => a.email).join(", ") }),
    "",
    m.textBody ?? m.snippet,
  ].join("\n");
}

/** The quoted/forwarded original, kept out of the editable body and shown
 *  collapsed behind a "⋯" toggle; appended back at save/send time. */
function quoteFor(c: ComposerState): string {
  const m = c.replyTo;
  if (!m || c.mode === "new") return "";
  return c.mode === "forward" ? forwardBlock(m) : quote(m);
}

function initialFields(c: ComposerState, selfEmails: Set<string>) {
  if (c.initial) {
    // Drafts saved before the collapsed-quote model carry the quote inside
    // the body; pull it back out so it isn't doubled at send time.
    const q = quoteFor(c);
    let body = c.initial.body ?? "";
    if (q && body.includes(q)) {
      body = body.replace(q, "").replace(/\n+$/, "");
    }
    return {
      to: c.initial.to ?? [],
      cc: c.initial.cc ?? [],
      bcc: c.initial.bcc ?? [],
      subject: c.initial.subject ?? "",
      body,
      quote: q,
    };
  }
  const m = c.replyTo;
  if (!m || c.mode === "new") {
    return { to: [], cc: [], bcc: [], subject: "", body: "", quote: "" };
  }
  const notSelf = (a: Address) => !selfEmails.has(a.email.toLowerCase());
  const reSubject = /^re:/i.test(m.subject)
    ? m.subject
    : i18n.t("compose:replyPrefix", { subject: m.subject });
  if (c.mode === "forward") {
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: /^fwd:/i.test(m.subject)
        ? m.subject
        : i18n.t("compose:forwardPrefix", { subject: m.subject }),
      body: "",
      quote: forwardBlock(m),
    };
  }
  const primary = m.isOutgoing ? m.to : [m.from];
  if (c.mode === "reply") {
    return {
      to: primary.filter(notSelf),
      cc: [],
      bcc: [],
      subject: reSubject,
      body: "",
      quote: quote(m),
    };
  }
  // reply_all
  const to = [...primary, ...m.to].filter(notSelf);
  const dedupTo = to.filter((a, i) => to.findIndex((b) => b.email === a.email) === i);
  return {
    to: dedupTo.length > 0 ? dedupTo : primary,
    cc: m.cc.filter(notSelf),
    bcc: [],
    subject: reSubject,
    body: "",
    quote: quote(m),
  };
}

export function Composer({ state, inline }: { state: ComposerState; inline?: boolean }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: snippets } = useSnippets();
  const { data: aiSettings } = useSettings();
  const confirmOpen = useUi((s) => s.composerConfirmOpen);
  const accountFilter = useUi((s) => s.accountFilter);
  const set = useUi((s) => s.set);
  const closeComposer = useUi((s) => s.closeComposer);
  const pushToast = useUi((s) => s.pushToast);

  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );
  const init = useMemo(() => initialFields(state, selfEmails), [state, selfEmails]);

  const [accountId, setAccountId] = useState<number>(
    state.accountId ?? accountFilter ?? accounts?.[0]?.id ?? 1,
  );
  const [to, setTo] = useState<Address[]>(init.to);
  const [cc, setCc] = useState<Address[]>(init.cc);
  const [bcc, setBcc] = useState<Address[]>(init.bcc);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [showCc, setShowCc] = useState(init.cc.length > 0 || init.bcc.length > 0);
  const [draftId, setDraftId] = useState<number | null>(state.draftId ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    state.initial?.attachments ?? [],
  );

  // Quoted original: collapsed behind "⋯", appended back on save/send.
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteRemoved, setQuoteRemoved] = useState(false);

  // "Write with AI" inline bar
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPending, setAiPending] = useState(false);
  /** null = follow the saved setting; true/false = per-draft override */
  const [aiVoice, setAiVoice] = useState<boolean | null>(null);
  /** one-shot undo: body as it was before the last AI replacement */
  const [aiPrevBody, setAiPrevBody] = useState<string | null>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirtyRef = useRef(false);
  const fieldsRef = useRef({
    accountId, to, cc, bcc, subject, body, draftId, attachments,
    quote: init.quote, quoteRemoved,
  });
  fieldsRef.current = {
    accountId, to, cc, bcc, subject, body, draftId, attachments,
    quote: init.quote, quoteRemoved,
  };

  useEffect(() => {
    if (accounts && !accounts.some((a) => a.id === accountId) && accounts[0]) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  // Append the sending account's signature while the body is still pristine
  // (fresh composes only; reopened drafts keep their content untouched).
  const lastSigBodyRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.initial) return;
    const sig = (aiSettings?.signatures?.[String(accountId)] ?? "").trim();
    const cur = fieldsRef.current.body;
    const pristine = cur === init.body || cur === lastSigBodyRef.current || cur.trim() === "";
    if (!pristine) return;
    const next = sig ? (init.body ? `${init.body}\n\n${sig}` : `\n\n${sig}`) : init.body;
    if (next !== cur) {
      setBody(next);
      lastSigBodyRef.current = next;
      // keep the caret at the top for replies so typing lands above the signature
      requestAnimationFrame(() => bodyRef.current?.setSelectionRange(0, 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, aiSettings?.signatures]);

  const markDirty = () => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      set({ composerDirty: true });
    }
  };

  const saveDraft = useCallback(async (): Promise<number> => {
    const f = fieldsRef.current;
    const fullBody =
      f.quote && !f.quoteRemoved ? `${f.body.replace(/\s+$/, "")}\n\n${f.quote}` : f.body;
    const { draftId: newId } = await call("save_draft", {
      args: {
        draftId: f.draftId,
        accountId: f.accountId,
        to: f.to,
        cc: f.cc,
        bcc: f.bcc,
        subject: f.subject,
        bodyText: fullBody,
        mode: state.mode,
        inReplyToMessageId: state.replyTo?.id ?? null,
        attachments: f.attachments,
      },
    });
    setDraftId(newId);
    fieldsRef.current.draftId = newId;
    setSavedAt(Date.now());
    dirtyRef.current = false;
    set({ composerDirty: false });
    return newId;
  }, [state.mode, state.replyTo, set]);

  // Auto-save every 3s while dirty.
  useEffect(() => {
    const t = setInterval(() => {
      if (dirtyRef.current && !sending) void saveDraft();
    }, 3000);
    return () => clearInterval(t);
  }, [saveDraft, sending]);

  // Focus: recipients for new/forward, body for replies.
  useEffect(() => {
    if (state.mode === "reply" || state.mode === "reply_all") {
      const el = bodyRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(0, 0);
      }
    }
    // new/forward: RecipientField autoFocus handles it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSend = useCallback(
    async (opts: { sendAt?: number; markDone?: boolean; instant?: boolean } = {}) => {
      const f = fieldsRef.current;
      if (f.to.length === 0) {
        pushToast({ kind: "error", message: t("compose:addRecipient"), durationMs: 3000 });
        return;
      }
      if (sending) return;
      setSending(true);
      try {
        const id = await saveDraft();
        const sendAt = opts.instant ? Date.now() : opts.sendAt;
        const res = await call("queue_send", { args: { draftId: id, sendAt } });
        const reopen: ComposerState = {
          mode: state.mode,
          draftId: id,
          accountId: f.accountId,
          replyTo: state.replyTo,
          initial: {
            to: f.to,
            cc: f.cc,
            bcc: f.bcc,
            subject: f.subject,
            body: f.body,
            attachments: f.attachments,
          },
        };
        closeComposer();

        if (opts.instant) {
          pushToast({ kind: "info", message: t("compose:sent"), durationMs: 2500 });
        } else if (opts.sendAt) {
          pushToast({
            kind: "info",
            message: t("compose:scheduled", {
              date: new Date(res.dispatchAt).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              }),
            }),
          });
        } else {
          const durationMs = Math.max(1000, res.dispatchAt - Date.now());
          const toastId = pushToast({
            kind: "info",
            message: t("compose:sendingIn"),
            countdown: true,
            durationMs,
            actionLabel: t("compose:undo"),
            onAction: () => buildCommandContext().undo(),
          });
          useUi.getState().set({
            lastUndo: { type: "send", actionId: res.actionId, toastId, reopen },
          });
        }

        if (opts.markDone && state.replyTo) {
          const tid = state.replyTo.threadId;
          advanceAfter([tid]);
          void performThreadAction("archive", [tid]);
        }

        // sent/drafts lists changed
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
          if (state.replyTo) {
            void queryClient.invalidateQueries({ queryKey: ["thread", state.replyTo.threadId] });
          }
        }, (opts.sendAt || opts.instant ? 0 : res.dispatchAt - Date.now()) + 500);
      } catch (err) {
        pushToast({
          kind: "error",
          message: t("compose:couldntSend", { error: errorMessage(err) }),
        });
      } finally {
        setSending(false);
      }
    },
    [saveDraft, sending, state.mode, state.replyTo, closeComposer, pushToast, t],
  );

  // Stage files to attach; the backend reads them from disk at dispatch time.
  const attachFiles = useCallback(async () => {
    if (MOCK_MODE) {
      // fake picker: add one mock file chip
      setAttachments((cur) => [
        ...cur,
        {
          filePath: `/tmp/comail-mock/quarterly-report-${cur.length + 1}.pdf`,
          filename: `quarterly-report-${cur.length + 1}.pdf`,
        },
      ]);
      markDirty();
      return;
    }
    try {
      const picked = await openFileDialog({ multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      setAttachments((cur) => [
        ...cur,
        ...paths
          .filter((p) => !cur.some((a) => a.filePath === p))
          .map((p) => ({ filePath: p, filename: p.split(/[\\/]/).pop() || p })),
      ]);
      markDirty();
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("compose:couldntPickFiles", { error: errorMessage(err) }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast]);

  const removeAttachment = (filePath: string) => {
    setAttachments((cur) => cur.filter((a) => a.filePath !== filePath));
    markDirty();
  };

  // "Write with AI": Enter runs ai_draft, result replaces the body.
  const voiceOn = aiVoice ?? aiSettings?.voiceDrafting ?? false;

  const runAiDraft = useCallback(async () => {
    const instruction = aiInstruction.trim();
    if (!instruction || aiPending) return;
    setAiPending(true);
    try {
      const account = accounts?.find((a) => a.id === fieldsRef.current.accountId);
      const text = await call("ai_draft", {
        threadId: state.replyTo?.threadId ?? null,
        replyToMessageId: state.replyTo?.id ?? null,
        instruction,
        senderName: account ? (account.displayName ?? account.email) : null,
        voice: voiceOn,
      });
      setAiPrevBody(fieldsRef.current.body);
      setBody(text);
      markDirty();
      setAiOpen(false);
      setAiInstruction("");
      requestAnimationFrame(() => bodyRef.current?.focus());
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setAiPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiInstruction, aiPending, accounts, state.replyTo, pushToast, voiceOn]);

  const restorePreviousBody = () => {
    if (aiPrevBody == null) return;
    setBody(aiPrevBody);
    setAiPrevBody(null);
    markDirty();
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  // Keyboard bridge: Cmd+Enter etc. arrive via the shared command registry.
  useEffect(() => {
    return onComposerAction((action) => {
      if (action === "send") void doSend();
      else if (action === "send_done") void doSend({ markDone: true });
      else if (action === "send_later") setSendLaterOpen(true);
      else if (action === "snippet") setSnippetOpen(true);
      else if (action === "instant_send") void doSend({ instant: true });
      else if (action === "attach") void attachFiles();
      else if (action === "ai") {
        setAiOpen(true);
        requestAnimationFrame(() => aiInputRef.current?.focus());
      }
    });
  }, [doSend, attachFiles]);

  useEffect(() => {
    if (aiOpen) requestAnimationFrame(() => aiInputRef.current?.focus());
  }, [aiOpen]);

  // Inline snippet expansion: typing ";shortcut " expands in place.
  const onBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    let text = el.value;
    const pos = el.selectionStart;
    const before = text.slice(0, pos);
    const match = /;([a-z0-9_-]+)([ \n])$/i.exec(before);
    if (match && snippets) {
      const snip = snippets.find((s) => s.shortcut?.toLowerCase() === match[1].toLowerCase());
      if (snip) {
        const start = pos - match[0].length;
        const inserted = snip.bodyText + match[2];
        text = text.slice(0, start) + inserted + text.slice(pos);
        setBody(text);
        markDirty();
        void call("use_snippet", { snippetId: snip.id });
        requestAnimationFrame(() => {
          el.setSelectionRange(start + inserted.length, start + inserted.length);
        });
        return;
      }
    }
    setBody(text);
    markDirty();
  };

  const insertSnippet = (snipId: number) => {
    const snip = snippets?.find((s) => s.id === snipId);
    if (!snip) return;
    const el = bodyRef.current;
    const pos = el ? el.selectionStart : body.length;
    const text = body.slice(0, pos) + snip.bodyText + body.slice(pos);
    setBody(text);
    if (snip.subject && !subject) setSubject(snip.subject);
    markDirty();
    void call("use_snippet", { snippetId: snip.id });
    setSnippetOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + snip.bodyText.length, pos + snip.bodyText.length);
    });
  };

  const discard = async () => {
    if (draftId != null) {
      try {
        await call("delete_draft", { draftId });
      } catch {
        /* ignore */
      }
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    }
    closeComposer();
  };

  const saveAndClose = async () => {
    await saveDraft();
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    closeComposer();
    pushToast({ kind: "info", message: t("compose:draftSaved"), durationMs: 2500 });
  };

  return (
    <div
      className={
        inline
          ? "relative w-full"
          : "fixed inset-x-0 bottom-0 z-40 flex justify-center px-4"
      }
    >
      <div
        className={
          inline
            ? "co-fade-in relative flex w-full flex-col rounded-xl border border-hairline bg-bg1"
            : "co-sheet-in relative flex max-h-[82vh] w-full max-w-[760px] flex-col rounded-t-xl border border-b-0 border-hairline bg-bg1"
        }
        style={{ boxShadow: inline ? "var(--elev-1)" : "var(--elev-2)" }}
      >
        {/* header */}
        <div className="co-hairline-b flex shrink-0 items-center gap-3 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-ink">{t(`compose:modeTitles.${state.mode}`)}</span>
          {state.replyTo && state.mode !== "new" && (
            <span className="truncate text-[12px] text-ink-faint">
              {state.replyTo.subject}
            </span>
          )}
          <div className="grow" />
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(Number(e.target.value));
              markDirty();
            }}
            className="rounded-md border border-hairline bg-bg0 px-2 py-1 text-[12px] text-ink-muted outline-none"
          >
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
          <button
            className="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
            onClick={() => buildCommandContext().escape()}
            aria-label={t("compose:close")}
          >
            ✕
          </button>
        </div>

        {/* fields */}
        <div
          className={
            inline
              ? "flex flex-col px-4"
              : "flex min-h-0 flex-1 flex-col overflow-y-auto px-4"
          }
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <RecipientRow
                to={to}
                setTo={(v) => {
                  setTo(v);
                  markDirty();
                }}
                cc={cc}
                setCc={(v) => {
                  setCc(v);
                  markDirty();
                }}
                bcc={bcc}
                setBcc={(v) => {
                  setBcc(v);
                  markDirty();
                }}
                showCc={showCc}
                autoFocusTo={state.mode === "new" || state.mode === "forward"}
              />
            </div>
            {!showCc && (
              <button
                className="mt-2 shrink-0 text-[11.5px] text-ink-faint hover:text-accent"
                tabIndex={-1}
                onClick={() => setShowCc(true)}
              >
                {t("compose:ccBcc")}
              </button>
            )}
          </div>

          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              markDirty();
            }}
            placeholder={t("compose:subject")}
            className="co-hairline-b w-full bg-transparent py-2.5 text-[14px] font-medium text-ink outline-none placeholder:text-ink-faint"
            spellCheck={false}
          />

          {aiOpen && (
            <div
              data-testid="ai-bar"
              className="co-fade-in co-hairline-b flex items-center gap-2 py-2"
            >
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-accent uppercase">
                {t("compose:aiBadge")}
              </span>
              <input
                ref={aiInputRef}
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runAiDraft();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setAiOpen(false);
                    requestAnimationFrame(() => bodyRef.current?.focus());
                  }
                }}
                disabled={aiPending}
                placeholder={t("compose:aiPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setAiVoice(!voiceOn)}
                title="Draft in your learned writing voice"
                className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  voiceOn
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-hairline text-ink-faint hover:text-ink-muted"
                }`}
              >
                {t("compose:aiVoice")}
              </button>
              {aiPending ? (
                <span
                  className="co-spinner size-3.5 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent"
                  title={t("compose:drafting")}
                />
              ) : (
                <span className="shrink-0 text-[11px] text-ink-faint">{t("compose:aiHint")}</span>
              )}
            </div>
          )}

          {aiPrevBody != null && (
            <div className="co-fade-in flex items-center gap-2 py-1.5 text-[11.5px] text-ink-faint">
              <span>{t("compose:aiDraftInserted")}</span>
              <button
                className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-bg2"
                onClick={restorePreviousBody}
              >
                {t("compose:restorePrevious")}
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div data-testid="attachment-chips" className="flex flex-wrap gap-2 py-2">
              {attachments.map((a) => (
                <span key={a.filePath} className="co-chip" title={a.filePath}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                  {a.filename}
                  <button
                    className="ml-0.5 rounded px-0.5 text-ink-faint hover:text-danger"
                    onClick={() => removeAttachment(a.filePath)}
                    aria-label={t("compose:removeNamed", { name: a.filename })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={bodyRef}
            value={body}
            onChange={onBodyChange}
            placeholder={t("compose:bodyPlaceholder", { mod: MOD_LABEL })}
            className={`${inline ? "min-h-[120px]" : "min-h-[180px]"} w-full flex-1 resize-none bg-transparent py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint`}
          />

          {(state.mode === "reply" || state.mode === "reply_all") && body.trim() === "" && (
            <div className="flex flex-wrap gap-2 pb-3" data-testid="quick-replies">
              {[t("compose:quickReply1"), t("compose:quickReply2"), t("compose:quickReply3")].map(
                (s) => (
                  <button
                    key={s}
                    className="rounded-full border border-hairline bg-bg0 px-3 py-1 text-[12.5px] text-ink-muted hover:border-hairline-strong hover:bg-bg2 hover:text-ink"
                    onClick={() => {
                      setBody(s);
                      markDirty();
                      requestAnimationFrame(() => {
                        bodyRef.current?.focus();
                        bodyRef.current?.setSelectionRange(s.length, s.length);
                      });
                    }}
                  >
                    {s}
                  </button>
                ),
              )}
            </div>
          )}

          {init.quote && !quoteRemoved && (
            <div className="pb-3">
              {!quoteOpen ? (
                <button
                  className="rounded-md border border-hairline bg-bg2 px-2.5 pb-1 text-[14px] leading-[10px] tracking-widest text-ink-faint hover:text-ink"
                  title={t("compose:showQuoted")}
                  aria-label={t("compose:showQuoted")}
                  onClick={() => setQuoteOpen(true)}
                >
                  ⋯
                </button>
              ) : (
                <div className="co-fade-in rounded-md border-l-2 border-hairline-strong bg-bg0/60 px-3 py-2">
                  <div className="mb-1 flex items-center gap-3 text-[11px] text-ink-faint">
                    <span className="font-semibold tracking-wide uppercase">
                      {t("compose:quotedLabel")}
                    </span>
                    <div className="grow" />
                    <button className="hover:text-ink" onClick={() => setQuoteOpen(false)}>
                      {t("compose:hideQuoted")}
                    </button>
                    <button
                      className="hover:text-danger"
                      onClick={() => {
                        setQuoteRemoved(true);
                        markDirty();
                      }}
                    >
                      {t("compose:removeQuoted")}
                    </button>
                  </div>
                  <pre className="max-h-44 overflow-y-auto font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-faint">
                    {init.quote}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center gap-3 border-t border-hairline px-4 py-2.5">
          <button
            className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
            onClick={() => void doSend()}
            disabled={sending}
          >
            {t("compose:send")}
          </button>
          <span className="text-[11.5px] text-ink-faint">
            {t("compose:footerHints", { mod: MOD_LABEL })}
          </span>
          <div className="grow" />
          <span className="text-[11.5px] text-ink-faint">
            {savedAt ? t("compose:draftSaved") : dirtyRef.current ? t("compose:unsaved") : ""}
          </span>
        </div>

        {/* discard / save confirm */}
        {confirmOpen && (
          <div
            className={`co-fade-in absolute inset-0 z-10 flex justify-center bg-bg0/60 backdrop-blur-[2px] ${
              inline ? "items-center rounded-xl" : "items-end rounded-t-xl"
            }`}
          >
            <div className="mb-10 flex flex-col items-center gap-3 rounded-xl border border-hairline bg-bg1 px-6 py-5" style={{ boxShadow: "var(--elev-2)" }}>
              <span className="text-[13.5px] text-ink">{t("compose:keepDraft")}</span>
              <div className="flex gap-2">
                <button
                  className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white"
                  onClick={() => void saveAndClose()}
                >
                  {t("compose:saveDraftButton")}
                </button>
                <button
                  className="rounded-lg border border-hairline px-3.5 py-1.5 text-[12.5px] text-danger hover:bg-bg2"
                  onClick={() => void discard()}
                >
                  {t("compose:discard")}
                </button>
                <button
                  className="rounded-lg border border-hairline px-3.5 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2"
                  onClick={() => set({ composerConfirmOpen: false })}
                >
                  {t("compose:keepWriting")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {sendLaterOpen && (
        <TimePopover
          title={t("compose:sendLater")}
          verb={t("compose:send")}
          onClose={() => setSendLaterOpen(false)}
          onPick={(at) => {
            setSendLaterOpen(false);
            void doSend({ sendAt: at });
          }}
        />
      )}

      {snippetOpen && (
        <SnippetPicker
          snippets={snippets ?? []}
          onClose={() => setSnippetOpen(false)}
          onPick={insertSnippet}
        />
      )}
    </div>
  );
}

function RecipientRow(props: {
  to: Address[];
  setTo: (v: Address[]) => void;
  cc: Address[];
  setCc: (v: Address[]) => void;
  bcc: Address[];
  setBcc: (v: Address[]) => void;
  showCc: boolean;
  autoFocusTo: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RecipientField label={t("compose:to")} value={props.to} onChange={props.setTo} autoFocus={props.autoFocusTo} />
      {props.showCc && (
        <>
          <RecipientField label={t("compose:cc")} value={props.cc} onChange={props.setCc} />
          <RecipientField label={t("compose:bcc")} value={props.bcc} onChange={props.setBcc} />
        </>
      )}
    </>
  );
}

function SnippetPicker({
  snippets,
  onClose,
  onPick,
}: {
  snippets: Snippet[];
  onClose: () => void;
  onPick: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const filtered = snippets.filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      (s.shortcut ?? "").toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="co-overlay flex items-start justify-center pt-[20vh]" onMouseDown={onClose}>
      <div
        className="co-pop-in w-[440px] rounded-xl border border-hairline bg-bg1 p-2"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
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
            } else if (e.key === "Enter" && filtered[cursor]) {
              e.preventDefault();
              onPick(filtered[cursor].id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder={t("compose:insertSnippet")}
          className="co-hairline-b w-full bg-transparent px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="max-h-64 overflow-y-auto pt-1">
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-[12.5px] text-ink-faint">{t("compose:noSnippets")}</p>
          )}
          {filtered.map((s, i) => (
            <button
              key={s.id}
              className={`flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => onPick(s.id)}
            >
              <span className="text-[13.5px] text-ink">{s.name}</span>
              {s.shortcut && <span className="font-mono text-[11.5px] text-accent">;{s.shortcut}</span>}
              <span className="ml-auto truncate pl-3 text-[11.5px] text-ink-faint">
                {s.bodyText.replace(/\s+/g, " ").slice(0, 40)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
