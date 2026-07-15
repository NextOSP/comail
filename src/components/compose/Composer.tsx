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
import { stripQuoteMarkers } from "../../lib/quotes";
import { decodeEntities, escapeHtml, htmlToText, isHtmlEmpty, textToHtml } from "../../lib/richtext";
import { pickSignature, signaturesForAccount, type ComposeMode } from "../../lib/signatures";
import { playSound } from "../../lib/sound";
import { RichBody, type RichBodyHandle } from "./RichBody";
import { performThreadAction } from "../../queries/actions";
import { queryClient } from "../../queries/client";
import { useAccounts, useSettings, useSnippets } from "../../queries/hooks";
import { useUi, type ComposerState } from "../../stores/ui";
import { TimePopover } from "../common/TimePopover";
import { AvailabilityPicker } from "../calendar/AvailabilityPicker";

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
      bodyHtml: c.initial.bodyHtml ?? textToHtml(body),
      quote: q,
    };
  }
  const m = c.replyTo;
  if (!m || c.mode === "new") {
    return { to: [], cc: [], bcc: [], subject: "", bodyHtml: "", quote: "" };
  }
  const notSelf = (a: Address) => !selfEmails.has(a.email.toLowerCase());
  // A passage the user selected in the thread seeds the body as a blockquote.
  const prefillHtml = c.prefillQuote ? selectionQuoteHtml(c.prefillQuote) : "";
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
      bodyHtml: "",
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
      bodyHtml: prefillHtml,
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
    bodyHtml: prefillHtml,
    quote: quote(m),
  };
}

/** Bare closing words a draft might end on ("Best,", "Kind regards", ...). Used
 *  to drop a model-generated sign-off before the stored signature is appended,
 *  so the reply never shows two closings. */
const SIGNOFF_RE =
  /^(best|regards|thanks|thank you|cheers|sincerely|warmly|best regards|kind regards|best wishes|all the best|warm regards|many thanks)[\s,.!]*$/i;

/** Trim trailing blank lines and a single trailing sign-off line from a plain
 *  text draft (the appended signature carries its own closing). */
function stripTrailingSignoff(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 1 && SIGNOFF_RE.test(lines[lines.length - 1].trim())) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  }
  return lines.join("\n");
}

/** A passage selected from the thread, rendered as a leading blockquote with a
 *  blank line after it for the reply. Shared by the seeded-reply path and the
 *  "insert into the open composer" action. */
function selectionQuoteHtml(text: string): string {
  return `<blockquote>${textToHtml(text)}</blockquote><div><br></div>`;
}

/** The plain-text wire quote rendered as HTML: attribution line + blockquote. */
function quoteToHtml(quoteText: string): string {
  const lines = quoteText.split("\n");
  const header = lines[0] ?? "";
  const rest = stripQuoteMarkers(lines.slice(1).join("\n"));
  return `<div>${escapeHtml(header)}</div><blockquote>${textToHtml(rest)}</blockquote>`;
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
  const availabilityOpen = useUi((s) => s.availabilityOpen);

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
  /** rich HTML body (plain-text fallback is derived at save/send time) */
  const [body, setBody] = useState(init.bodyHtml);
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
  const [proofPending, setProofPending] = useState(false);
  const [teamsPending, setTeamsPending] = useState(false);
  const aiInputRef = useRef<HTMLInputElement>(null);

  // Quick-reply chips: AI suggestions generated when a reply opens; the
  // static i18n chips show instantly and are swapped out when these arrive.
  const [quickReplies, setQuickReplies] = useState<string[] | null>(null);
  // True while the AI is generating suggestions: shows a gradient shimmer in
  // place of the chips so the work is visible instead of static placeholders.
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
  useEffect(() => {
    if (state.mode !== "reply" && state.mode !== "reply_all") return;
    const threadId = state.replyTo?.threadId;
    if (threadId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await call("ai_status", {});
        if (!status.configured || cancelled) return;
        setQuickRepliesLoading(true);
        const suggestions = await call("ai_quick_replies", { threadId });
        if (!cancelled && suggestions.length > 0) setQuickReplies(suggestions);
      } catch {
        // AI unavailable or slow: fall back to the static chips.
      } finally {
        if (!cancelled) setQuickRepliesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.mode, state.replyTo?.threadId]);

  const bodyRef = useRef<RichBodyHandle>(null);
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

  // Manual signature override for this compose: undefined = follow the mode
  // default, null = explicitly none, string = a specific signature id.
  const [manualSigId, setManualSigId] = useState<string | null | undefined>(undefined);
  // A manual pick belongs to the account it was made on; reset when it changes.
  useEffect(() => setManualSigId(undefined), [accountId]);

  const accountSigs = useMemo(
    () => (aiSettings ? signaturesForAccount(aiSettings, accountId) : []),
    [aiSettings, accountId],
  );

  const activeSig = useMemo(() => {
    if (!aiSettings) return null;
    if (manualSigId === null) return null;
    if (manualSigId !== undefined) {
      return accountSigs.find((s) => s.id === manualSigId) ?? null;
    }
    return pickSignature(aiSettings, accountId, state.mode as ComposeMode);
  }, [aiSettings, accountId, manualSigId, accountSigs, state.mode]);

  // Insert the active signature while the body is still pristine (fresh composes
  // only; reopened drafts keep their content untouched). Also swaps cleanly when
  // the account, mode default, or manual pick changes.
  const lastSigBodyRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.initial) return;
    const sigHtml = (activeSig?.html ?? "").trim();
    const cur = fieldsRef.current.body;
    const pristine =
      cur === init.bodyHtml || cur === lastSigBodyRef.current || isHtmlEmpty(cur);
    if (!pristine) return;
    const next = sigHtml
      ? init.bodyHtml
        ? `${init.bodyHtml}<br><br>${sigHtml}`
        : `<br><br>${sigHtml}`
      : init.bodyHtml;
    if (next !== cur) {
      setBody(next);
      lastSigBodyRef.current = next;
      // keep the caret at the top for replies so typing lands above the signature
      if (state.mode === "reply" || state.mode === "reply_all") {
        requestAnimationFrame(() => bodyRef.current?.focusStart());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSig]);

  const markDirty = () => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      set({ composerDirty: true });
    }
  };

  const saveDraft = useCallback(async (): Promise<number> => {
    const f = fieldsRef.current;
    const plain = htmlToText(f.body);
    const withQuote = f.quote !== "" && !f.quoteRemoved;
    const fullBody = withQuote ? `${plain.replace(/\s+$/, "")}\n\n${f.quote}` : plain;
    const fullHtml = withQuote ? `${f.body}<br><br>${quoteToHtml(f.quote)}` : f.body;
    const { draftId: newId } = await call("save_draft", {
      args: {
        draftId: f.draftId,
        accountId: f.accountId,
        to: f.to,
        cc: f.cc,
        bcc: f.bcc,
        subject: f.subject,
        bodyText: fullBody,
        bodyHtml: fullHtml,
        mode: state.mode,
        inReplyToMessageId: state.replyTo?.id ?? null,
        attachments: f.attachments,
      },
    });
    setDraftId(newId);
    fieldsRef.current.draftId = newId;
    setSavedAt(Date.now());
    dirtyRef.current = false;
    set({ composerDirty: false, editingDraftId: newId });
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
      bodyRef.current?.focusStart();
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
      // Play the "whoosh" synchronously on the user's send gesture - webviews
      // block audio started later from an async callback (no user activation).
      playSound("send");
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
            body: htmlToText(f.body),
            bodyHtml: f.body,
            attachments: f.attachments,
          },
        };
        closeComposer();

        // Show the queued reply (with its body) in the thread right away.
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        if (state.replyTo) {
          void queryClient.invalidateQueries({ queryKey: ["thread", state.replyTo.threadId] });
        }

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
            secondaryLabel: t("compose:sendNow"),
            onSecondary: () => {
              void call("send_now", { actionId: res.actionId });
              useUi.getState().set({ lastUndo: null });
              void queryClient.invalidateQueries({ queryKey: ["threads"] });
            },
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
      // The signature is appended to the draft here (the model is told to skip
      // its own sign-off), so the AI reply carries the account's signature.
      const sigHtml = (activeSig?.html ?? "").trim();
      const text = await call("ai_draft", {
        threadId: state.replyTo?.threadId ?? null,
        replyToMessageId: state.replyTo?.id ?? null,
        instruction,
        senderName: account ? (account.displayName ?? account.email) : null,
        voice: voiceOn,
        hasSignature: sigHtml !== "",
      });
      setAiPrevBody(fieldsRef.current.body);
      // Append the signature the composer would use; the model is told to skip
      // its own sign-off, but strip any stray trailing "Best,"/"Regards," it
      // adds anyway so it never doubles up with the signature. The body is now
      // non-pristine, so the signature effect leaves this content alone.
      const draftHtml = textToHtml(sigHtml ? stripTrailingSignoff(text) : text);
      setBody(sigHtml ? `${draftHtml}<br><br>${sigHtml}` : draftHtml);
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
  }, [aiInstruction, aiPending, accounts, state.replyTo, pushToast, voiceOn, activeSig]);

  // "Proofread": AI copy-edits the current body in place; the existing
  // restore bar undoes it. HTML formatting is preserved by the prompt.
  const runProofread = useCallback(async () => {
    const cur = fieldsRef.current.body;
    if (isHtmlEmpty(cur) || proofPending) return;
    setProofPending(true);
    try {
      const fixed = (await call("ai_proofread", { body: cur })).trim();
      if (fixed && fixed !== cur) {
        setAiPrevBody(cur);
        // Plain-text answers (model stripped the markup) are re-encoded;
        // decode first so entities from the HTML input don't double-escape.
        setBody(/<[a-z][^>]*>/i.test(fixed) ? fixed : textToHtml(decodeEntities(fixed)));
        markDirty();
      } else {
        pushToast({ kind: "info", message: t("compose:proofreadClean"), durationMs: 2500 });
      }
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setProofPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofPending, pushToast, t]);

  // Teams meetings are a Microsoft-Graph feature: only offer the button on
  // Microsoft accounts.
  const isMicrosoftAccount =
    accounts?.find((acc) => acc.id === accountId)?.provider === "microsoft";

  // "Teams meeting": mint an online meeting via Graph and drop the join link
  // into the body. First use may open the browser for one-time consent.
  const createTeamsMeeting = useCallback(async () => {
    if (teamsPending) return;
    setTeamsPending(true);
    try {
      const f = fieldsRef.current;
      const start = Date.now();
      const { joinUrl } = await call("create_teams_meeting", {
        accountId: f.accountId,
        subject: f.subject || t("compose:teamsMeetingTitle"),
        startMs: start,
        endMs: start + 30 * 60 * 1000,
      });
      const block =
        `<p><strong>${escapeHtml(t("compose:teamsMeetingTitle"))}</strong></p>` +
        `<p><a href="${escapeHtml(joinUrl)}">${escapeHtml(t("compose:teamsMeetingJoin"))}</a></p>`;
      markDirty();
      requestAnimationFrame(() => bodyRef.current?.insertHtml(block));
      pushToast({ kind: "info", message: t("compose:teamsMeetingAdded"), durationMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("compose:teamsMeetingError", { error: errorMessage(err) }),
      });
    } finally {
      setTeamsPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamsPending, pushToast, t]);

  const restorePreviousBody = () => {
    if (aiPrevBody == null) return;
    setBody(aiPrevBody);
    setAiPrevBody(null);
    markDirty();
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  // Keyboard bridge: Cmd+Enter etc. arrive via the shared command registry.
  useEffect(() => {
    return onComposerAction((action, text) => {
      if (action === "send") void doSend();
      else if (action === "send_done") void doSend({ markDone: true });
      else if (action === "send_later") setSendLaterOpen(true);
      else if (action === "snippet") setSnippetOpen(true);
      else if (action === "instant_send") void doSend({ instant: true });
      else if (action === "attach") void attachFiles();
      else if (action === "share_availability") useUi.getState().set({ availabilityOpen: true });
      else if (action === "proofread") void runProofread();
      else if (action === "quote_selection") {
        if (text) {
          markDirty();
          requestAnimationFrame(() => bodyRef.current?.insertHtml(selectionQuoteHtml(text)));
        }
      } else if (action === "ai") {
        setAiOpen(true);
        requestAnimationFrame(() => aiInputRef.current?.focus());
      }
    });
  }, [doSend, attachFiles, runProofread]);

  useEffect(() => {
    if (aiOpen) requestAnimationFrame(() => aiInputRef.current?.focus());
  }, [aiOpen]);

  // Inline snippet expansion: typing ";shortcut " in the editor expands in
  // place (RichBody handles the caret surgery, we resolve the shortcut).
  const expandShortcut = useCallback(
    (name: string): string | null => {
      const snip = snippets?.find((s) => s.shortcut?.toLowerCase() === name.toLowerCase());
      if (!snip) return null;
      void call("use_snippet", { snippetId: snip.id });
      markDirty();
      return snip.bodyText;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snippets],
  );

  const insertSnippet = (snipId: number) => {
    const snip = snippets?.find((s) => s.id === snipId);
    if (!snip) return;
    if (snip.subject && !subject) setSubject(snip.subject);
    markDirty();
    void call("use_snippet", { snippetId: snip.id });
    setSnippetOpen(false);
    requestAnimationFrame(() => bodyRef.current?.insertText(snip.bodyText));
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

  const accountSelect = (
    <select
      value={accountId}
      onChange={(e) => {
        setAccountId(Number(e.target.value));
        markDirty();
      }}
      className="shrink-0 cursor-pointer bg-transparent text-right text-[12px] text-ink-faint outline-none hover:text-ink-muted"
    >
      {(accounts ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.email}
        </option>
      ))}
    </select>
  );

  return (
    <div
      className={
        inline
          ? "co-composer co-fade-in border border-hairline bg-bg1"
          : "co-composer co-fade-in min-h-0 flex-1 overflow-y-auto"
      }
      style={inline ? { boxShadow: "var(--elev-card)" } : undefined}
    >
      <div
        className={
          inline
            ? "relative flex w-full flex-col px-5 py-4"
            : "relative mx-auto flex w-full max-w-[860px] flex-col px-6 py-6 pb-24"
        }
      >
        {!inline && (
          <header className="mb-3 flex items-center justify-between gap-4">
            <button
              className="flex items-center gap-1.5 text-[12px] text-ink-faint hover:text-ink-muted"
              onClick={() => buildCommandContext().escape()}
            >
              ← {t("compose:close")}
              <kbd className="co-kbd !text-[10px]">Esc</kbd>
            </button>
            {accountSelect}
          </header>
        )}

        {/* fields */}
        <div className="flex flex-col">
          {inline && (
            <div className="flex items-baseline gap-1.5 pb-1.5">
              {/* Superhuman-style draft header: green "Draft" + muted recipients. */}
              <span className="text-[14px] font-semibold text-ok">{t("compose:draftLabel")}</span>
              {to.length > 0 && (
                <span className="min-w-0 truncate text-[14px] text-ink-muted">
                  {t("compose:draftTo", { names: to.map(addressName).join(", ") })}
                </span>
              )}
              <div className="grow" />
              {accountSelect}
            </div>
          )}
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

          {/* Replies keep the derived "Re:" subject out of sight (thread title
              already shows it); new messages get the subject as the big title. */}
          {!inline && (
            <input
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                markDirty();
              }}
              placeholder={t("compose:subject")}
              className="co-hairline-b w-full bg-transparent py-3 text-[19px] font-semibold tracking-tight text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
              spellCheck={false}
            />
          )}

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

          <RichBody
            ref={bodyRef}
            value={body}
            onChange={(html) => {
              setBody(html);
              markDirty();
            }}
            placeholder={t("compose:bodyPlaceholder", { mod: MOD_LABEL })}
            minHeightClass={inline ? "min-h-[140px]" : "min-h-[240px]"}
            expandShortcut={expandShortcut}
          />

          {(state.mode === "reply" || state.mode === "reply_all") &&
            (quickRepliesLoading || isHtmlEmpty(body)) && (
              <div
                className="flex flex-wrap items-center gap-2 pb-3"
                data-testid="quick-replies"
              >
                {quickRepliesLoading ? (
                  <>
                    {["w-24", "w-36", "w-28"].map((w) => (
                      <span
                        key={w}
                        aria-hidden
                        className={`co-ai-shimmer inline-block h-[26px] rounded-full ${w}`}
                      />
                    ))}
                    <span className="sr-only">{t("compose:quickRepliesLoading")}</span>
                  </>
                ) : (
                  (
                    quickReplies ?? [
                      t("compose:quickReply1"),
                      t("compose:quickReply2"),
                      t("compose:quickReply3"),
                    ]
                  ).map((s) => (
                    <button
                      key={s}
                      className="co-fade-in rounded-full border border-hairline bg-bg0 px-3 py-1 text-[12.5px] text-ink-muted hover:border-hairline-strong hover:bg-bg2 hover:text-ink"
                      onClick={() => {
                        markDirty();
                        bodyRef.current?.insertText(s);
                      }}
                    >
                      {s}
                    </button>
                  ))
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
                    {stripQuoteMarkers(init.quote)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="mt-1 flex shrink-0 items-center gap-3 border-t border-hairline pt-3">
          <button
            className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
            onClick={() => void doSend()}
            disabled={sending}
          >
            {t("compose:send")}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2 disabled:opacity-50"
            onClick={() => void runProofread()}
            disabled={proofPending || isHtmlEmpty(body)}
            title={`${t("compose:proofread")} (${MOD_LABEL}⇧P)`}
          >
            {proofPending && (
              <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
            )}
            {t("compose:proofread")}
          </button>
          {isMicrosoftAccount && (
            <button
              className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2 disabled:opacity-50"
              onClick={() => void createTeamsMeeting()}
              disabled={teamsPending}
              title={t("compose:teamsMeetingTip")}
            >
              {teamsPending && (
                <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
              )}
              {t("compose:teamsMeeting")}
            </button>
          )}
          <span className="text-[11.5px] text-ink-faint">
            {t("compose:footerHints", { mod: MOD_LABEL })}
          </span>
          <div className="grow" />
          {!state.initial && accountSigs.length > 0 && (
            <select
              value={activeSig?.id ?? ""}
              aria-label={t("compose:signature.label")}
              title={t("compose:signature.label")}
              data-testid="signature-picker"
              onChange={(e) => {
                setManualSigId(e.target.value || null);
                markDirty();
              }}
              className="shrink-0 cursor-pointer bg-transparent text-[11.5px] text-ink-faint outline-none hover:text-ink-muted"
            >
              <option value="">{t("compose:signature.none")}</option>
              {accountSigs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <span className="text-[11.5px] text-ink-faint">
            {savedAt ? t("compose:draftSaved") : dirtyRef.current ? t("compose:unsaved") : ""}
          </span>
        </div>

        {/* discard / save confirm */}
        {confirmOpen && (
          <div className="co-fade-in absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg0/70 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-hairline bg-bg1 px-6 py-5" style={{ boxShadow: "var(--elev-2)" }}>
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

      {availabilityOpen && (
        <AvailabilityPicker
          onClose={() => useUi.getState().set({ availabilityOpen: false })}
          onInsert={(html) => {
            markDirty();
            requestAnimationFrame(() => bodyRef.current?.insertHtml(html));
          }}
        />
      )}
      </div>
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
