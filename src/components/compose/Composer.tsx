import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import i18n from "../../i18n";
import { errorMessage } from "../../ipc/errors";
import { call } from "../../ipc/commands";
import { MOCK_MODE } from "../../ipc/mock";
import { subscribeEvent } from "../../ipc/events";
import type { Address, AiDraftAction, DraftAttachment, MessageDetail, Snippet, ThreadDetail } from "../../ipc/types";
import { RecipientField } from "./RecipientField";
import { onComposerAction } from "../../keyboard/commands";
import { advanceAfter, buildCommandContext } from "../../keyboard/context";
import { calendarPrefill } from "../../lib/calendarSuggestion";
import { addressName, longTime, MOD_LABEL } from "../../lib/format";
import { stripQuoteMarkers } from "../../lib/quotes";
import { decodeEntities, escapeHtml, htmlToText, isHtmlEmpty, textToHtml } from "../../lib/richtext";
import {
  pickSignature,
  replaceSignature,
  signaturesForAccount,
  stripSignature,
  type ComposeMode,
} from "../../lib/signatures";
import { playSound } from "../../lib/sound";
import { RichBody, type RichBodyHandle } from "./RichBody";
import { performThreadAction } from "../../queries/actions";
import { queryClient } from "../../queries/client";
import { useAccounts, useSettings, useSnippets } from "../../queries/hooks";
import { useUi, type ComposerState } from "../../stores/ui";
import { TimePopover } from "../common/TimePopover";
import { AvailabilityPicker } from "../calendar/AvailabilityPicker";
import { Button } from "../ui/Button";
import { AiBadge, AiSparkle, AiSurface } from "../ui/Ai";
import { Icon } from "../ui/Icon";
import { MenuDivider, MenuItem, Popover } from "../ui/Menu";
import { Spinner } from "../ui/Spinner";

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
    let bodyHtml = c.initial.bodyHtml;
    if (q && body.includes(q)) {
      body = body.replace(q, "").replace(/\n+$/, "");
    }
    if (q && bodyHtml) {
      const quoteSuffix = `<br><br>${quoteToHtml(q)}`;
      if (bodyHtml.endsWith(quoteSuffix)) {
        bodyHtml = bodyHtml.slice(0, -quoteSuffix.length);
      }
    }
    return {
      to: c.initial.to ?? [],
      cc: c.initial.cc ?? [],
      bcc: c.initial.bcc ?? [],
      subject: c.initial.subject ?? "",
      bodyHtml: bodyHtml ?? textToHtml(body),
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

/** Follow-up edits offered on an AI result (Superhuman's chip row). Sent to
 *  the model as the instruction, so they stay English like the backend prompts. */
const AI_REFINE = {
  shorten: "Make it shorter and more concise, keeping the meaning and tone.",
  lengthen: "Make it a little longer with more helpful detail, keeping the tone.",
  improve: "Improve the writing: clarity, flow and grammar, keeping the meaning.",
} as const;

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
  const [dragOver, setDragOver] = useState(false);

  // Quoted original: collapsed behind "⋯", appended back on save/send.
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteRemoved, setQuoteRemoved] = useState(false);

  // "Write with AI" inline bar
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPending, setAiPending] = useState(false);
  /** null = follow the saved setting; true/false = per-draft override */
  const [aiVoice, setAiVoice] = useState<boolean | null>(null);
  /** one-shot undo: body as it was before the current run of AI edits */
  const [aiPrevBody, setAiPrevBody] = useState<string | null>(null);
  /** The last AI draft/edit, so the result row's Retry can run it again on the
   *  body it started from. */
  const [aiLastRun, setAiLastRun] = useState<{ instruction: string; base: string } | null>(null);
  /** Typed follow-ups the AI suggested for the last draft (e.g. create an event). */
  const [aiActions, setAiActions] = useState<AiDraftAction[]>([]);
  const [signatureMenu, setSignatureMenu] = useState<{ x: number; y: number } | null>(null);
  const [proofPending, setProofPending] = useState(false);
  const [teamsPending, setTeamsPending] = useState(false);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  // Quick-reply chips: nothing shows while the AI is generating; the chips pop
  // in once its suggestions arrive. The static i18n chips are only a fallback
  // when AI isn't configured or the request fails.
  const [quickReplies, setQuickReplies] = useState<string[] | null>(null);
  const [quickRepliesFallback, setQuickRepliesFallback] = useState(false);
  useEffect(() => {
    if (state.mode !== "reply" && state.mode !== "reply_all") return;
    const threadId = state.replyTo?.threadId;
    if (threadId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await call("ai_status", {});
        if (cancelled) return;
        if (!status.configured) {
          setQuickRepliesFallback(true);
          return;
        }
        const suggestions = await call("ai_quick_replies", { threadId });
        if (cancelled) return;
        if (suggestions.length > 0) setQuickReplies(suggestions);
        else setQuickRepliesFallback(true);
      } catch {
        if (!cancelled) setQuickRepliesFallback(true);
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

  // Keep the active signature block in the body (fresh composes only; reopened
  // drafts keep their content untouched). The block is swapped in place, so
  // changing the account, mode default, or manual pick works after typing too.
  useEffect(() => {
    if (state.initial) return;
    const cur = fieldsRef.current.body;
    const next = replaceSignature(cur, activeSig?.html ?? "");
    if (next === cur) return;
    const pristine = stripSignature(cur) === init.bodyHtml || isHtmlEmpty(stripSignature(cur));
    setBody(next);
    // keep the caret at the top for replies so typing lands above the signature
    if (pristine && (state.mode === "reply" || state.mode === "reply_all")) {
      requestAnimationFrame(() => bodyRef.current?.focusStart());
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

  // Merge picked/dropped paths into the attachment list, skipping dupes.
  const stageAttachmentPaths = (paths: string[]) => {
    setAttachments((cur) => [
      ...cur,
      ...paths
        .filter((p) => !cur.some((a) => a.filePath === p))
        .map((p) => ({ filePath: p, filename: p.split(/[\\/]/).pop() || p })),
    ]);
    markDirty();
  };

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
      stageAttachmentPaths(paths);
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("compose:couldntPickFiles", { error: errorMessage(err) }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast]);

  // The webview intercepts native OS file drops at the window level (no
  // "over any composer" scoping needed - App.tsx only ever mounts one
  // Composer at a time, full-screen or inline). Skipped in mock/browser dev
  // since there's no real Tauri webview to subscribe to.
  useEffect(() => {
    if (MOCK_MODE) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          setDragOver(false);
          stageAttachmentPaths(event.payload.paths);
        } else if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else {
          setDragOver(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeAttachment = (filePath: string) => {
    setAttachments((cur) => cur.filter((a) => a.filePath !== filePath));
    markDirty();
  };

  // "Write with AI": Enter runs ai_draft, result replaces the body.
  const voiceOn = aiVoice ?? aiSettings?.voiceDrafting ?? false;

  // With text already in the body the bar edits it ("Edit with AI"): the
  // current draft is sent separately so the model revises it rather than
  // re-expanding. Empty bodies get a fresh draft. Tokens stream straight into
  // the body; once done, a typed follow-up pass may suggest a calendar event.
  const runAiDraft = useCallback(async (rawInstruction: string, baseBody?: string) => {
    const instruction = rawInstruction.trim();
    if (!instruction || aiPending) return;
    setAiPending(true);
    setAiActions([]);
    const base = baseBody ?? fieldsRef.current.body;
    const hadPrev = aiPrevBody != null;
    // The signature is re-attached to the draft here (the model is told to
    // skip its own sign-off), so the AI reply carries the account's signature.
    const sigHtml = (activeSig?.html ?? "").trim();
    const requestId = crypto.randomUUID();
    let streamed = "";
    let frame = 0;
    const paint = () => {
      frame = 0;
      setBody(replaceSignature(textToHtml(streamed.trimStart()), sigHtml));
    };
    const unlisten = await subscribeEvent("ai:draft:token", (e) => {
      if (e.requestId !== requestId) return;
      if (!streamed) {
        // First token: swap the instruction bar for the live result row.
        setAiPrevBody((prev) => prev ?? base);
        setAiOpen(false);
      }
      streamed += e.delta;
      if (!frame) frame = requestAnimationFrame(paint);
    });
    try {
      const current = htmlToText(stripSignature(base)).trim();
      const account = accounts?.find((a) => a.id === fieldsRef.current.accountId);
      const threadId = state.replyTo?.threadId ?? null;
      const text = await call("ai_draft", {
        threadId,
        replyToMessageId: state.replyTo?.id ?? null,
        instruction,
        currentDraft: current || null,
        senderName: account ? (account.displayName ?? account.email) : null,
        voice: voiceOn,
        hasSignature: sigHtml !== "",
        requestId,
      });
      if (frame) cancelAnimationFrame(frame);
      setAiPrevBody((prev) => prev ?? base);
      setAiLastRun({ instruction, base });
      // The model is told to skip its own sign-off, but strip any stray
      // trailing "Best,"/"Regards," it adds anyway so it never doubles up with
      // the signature block.
      const finalText = sigHtml ? stripTrailingSignoff(text) : text;
      setBody(replaceSignature(textToHtml(finalText), sigHtml));
      markDirty();
      setAiOpen(false);
      setAiInstruction("");
      requestAnimationFrame(() => bodyRef.current?.focus());
      // Typed follow-ups (e.g. "add this meeting to your calendar"); best-effort.
      call("ai_draft_actions", { threadId, draft: finalText })
        .then(setAiActions)
        .catch(() => {});
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      // Roll back any partially streamed text.
      if (streamed) {
        setBody(base);
        if (!hadPrev) setAiPrevBody(null);
        setAiOpen(true);
      }
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      unlisten();
      setAiPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPending, aiPrevBody, accounts, state.replyTo, pushToast, voiceOn, activeSig]);

  /** Open the event form prefilled from an AI suggestion, inviting the
   *  draft's recipients. */
  const createSuggestedEvent = (action: AiDraftAction) => {
    const prefill = calendarPrefill(action);
    if (!prefill) return;
    const f = fieldsRef.current;
    useUi.getState().set({
      eventCreate: { prefill: { ...prefill, attendees: [...f.to, ...f.cc] } },
    });
    setAiActions((cur) => cur.filter((a) => a !== action));
  };

  const acceptAiResult = () => {
    setAiPrevBody(null);
    setAiLastRun(null);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  // "Proofread": AI copy-edits the current body in place; the existing
  // restore bar undoes it. HTML formatting is preserved by the prompt.
  const runProofread = useCallback(async () => {
    const cur = fieldsRef.current.body;
    if (isHtmlEmpty(cur) || proofPending) return;
    setProofPending(true);
    try {
      const fixed = (await call("ai_proofread", { body: cur })).trim();
      if (fixed && fixed !== cur) {
        setAiPrevBody((prev) => prev ?? cur);
        setAiLastRun(null);
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
    setAiLastRun(null);
    setAiActions([]);
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

  // A colleague picked from the body's "@" mention menu is pulled into the
  // recipients so they actually receive the mail: the first mention seeds an
  // empty To field, later ones (or replies with a To already set) go to Cc.
  const addMention = (a: Address) => {
    const email = a.email.toLowerCase();
    const has = (list: Address[]) => list.some((v) => v.email.toLowerCase() === email);
    if (has(to) || has(cc) || has(bcc)) return;
    if (to.length === 0) {
      setTo([a]);
    } else {
      setCc([...cc, a]);
      setShowCc(true);
    }
    markDirty();
  };

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
      } catch (err) {
        pushToast({
          kind: "error",
          message: t("compose:discardFailed", { detail: errorMessage(err) }),
        });
        return;
      }
      queryClient.setQueriesData<ThreadDetail>({ queryKey: ["thread"] }, (detail) =>
        detail
          ? { ...detail, messages: detail.messages.filter((message) => message.id !== draftId) }
          : detail,
      );
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["thread"] });
    }
    closeComposer();
  };

  const saveAndClose = async () => {
    await saveDraft();
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    void queryClient.invalidateQueries({ queryKey: ["thread"] });
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
      className="shrink-0 cursor-pointer bg-transparent text-right text-sm text-ink-faint outline-none hover:text-ink-muted"
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
          : "co-composer co-fade-in min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-24"
      }
      style={inline ? { boxShadow: "var(--elev-card)" } : undefined}
    >
      {/* New messages float as a card on the canvas, matching the inline reply composer. */}
      <div
        className={
          inline
            ? "relative flex w-full flex-col px-5 py-4"
            : "relative mx-auto flex w-full max-w-[860px] flex-col rounded-xl border border-hairline bg-bg1 px-7 pt-5 pb-4"
        }
        style={inline ? undefined : { boxShadow: "var(--elev-card)" }}
      >
        {!inline && (
          <header className="co-hairline-b -mx-7 mb-2 flex items-center justify-between gap-4 px-7 pb-3">
            <button
              className="flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink-muted"
              onClick={() => buildCommandContext().escape()}
            >
              ← {t("compose:close")}
              <kbd className="co-kbd !text-2xs">Esc</kbd>
            </button>
            {accountSelect}
          </header>
        )}

        {/* fields */}
        <div className="flex flex-col">
          {inline && (
            <div className="flex items-baseline gap-1.5 pb-1.5">
              {/* Superhuman-style draft header: green "Draft" + muted recipients. */}
              <span className="text-md font-semibold text-ok">{t("compose:draftLabel")}</span>
              {to.length > 0 && (
                <span className="min-w-0 truncate text-md text-ink-muted">
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
                suggestAccountId={aiSettings?.contactSuggestAllAccounts ? undefined : accountId}
              />
            </div>
            {!showCc && (
              <button
                className="mt-2 shrink-0 text-xs text-ink-faint hover:text-accent"
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
              className="co-hairline-b w-full bg-transparent py-3 text-lg font-semibold tracking-tight text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
              spellCheck={false}
            />
          )}

          {aiOpen && (
            <div data-testid="ai-bar" className="co-fade-in my-2">
              {/* Stacked prompt box (Superhuman "Write a draft"): badge + voice
                  on top, a roomy auto-growing prompt, hints + Generate below. */}
              <AiSurface className="flex flex-col gap-2 px-4 pt-3 pb-2.5 shadow-elev-1">
                <div className="flex items-center justify-between gap-3">
                  <AiBadge
                    className="text-sm"
                    label={
                      isHtmlEmpty(stripSignature(body)) ? t("compose:ai.write") : t("compose:ai.edit")
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setAiVoice(!voiceOn)}
                    title={t("compose:ai.voiceTip")}
                    aria-pressed={voiceOn}
                    className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                      voiceOn
                        ? "co-ai-fill border-transparent text-ink"
                        : "border-hairline text-ink-faint hover:text-ink-muted"
                    }`}
                  >
                    {t("compose:aiVoice")}
                  </button>
                </div>
                <textarea
                  ref={aiInputRef}
                  rows={2}
                  value={aiInstruction}
                  onChange={(e) => {
                    setAiInstruction(e.target.value);
                    // Auto-grow up to ~6 lines, then scroll.
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void runAiDraft(aiInstruction);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setAiOpen(false);
                      requestAnimationFrame(() => bodyRef.current?.focus());
                    }
                  }}
                  disabled={aiPending}
                  placeholder={t("compose:aiPlaceholder")}
                  className="min-h-[52px] w-full resize-none bg-transparent text-md leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-faint">{t("compose:ai.hint")}</span>
                  <Button
                    size="sm"
                    variant="ai"
                    busy={aiPending}
                    disabled={!aiInstruction.trim()}
                    onClick={() => void runAiDraft(aiInstruction)}
                  >
                    {aiPending ? t("compose:drafting") : t("compose:ai.generate")}
                  </Button>
                </div>
              </AiSurface>
            </div>
          )}

          {aiPrevBody != null && !aiOpen && (
            <div
              data-testid="ai-result"
              className="co-fade-in flex flex-wrap items-center gap-1.5 py-1.5 text-xs text-ink-faint"
            >
              <AiSparkle size={12} />
              <span className="mr-1">{t("compose:aiDraftInserted")}</span>
              {aiPending ? (
                <span className="co-ai-icon inline-flex items-center gap-1.5">
                  <Spinner />
                  <span className="text-ink-faint">{t("compose:drafting")}</span>
                </span>
              ) : (
                <>
                  <Button size="sm" variant="secondary" icon="check" onClick={acceptAiResult}>
                    {t("compose:ai.accept")}
                  </Button>
                  {aiLastRun && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="repeat"
                      onClick={() => void runAiDraft(aiLastRun.instruction, aiLastRun.base)}
                    >
                      {t("compose:ai.retry")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void runAiDraft(AI_REFINE.shorten)}>
                    {t("compose:ai.shorten")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void runAiDraft(AI_REFINE.lengthen)}>
                    {t("compose:ai.lengthen")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void runAiDraft(AI_REFINE.improve)}>
                    {t("compose:ai.improve")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={restorePreviousBody}>
                    {t("compose:restorePrevious")}
                  </Button>
                </>
              )}
            </div>
          )}

          {aiActions.length > 0 && !aiPending && (
            <div data-testid="ai-actions" className="co-fade-in flex flex-wrap items-center gap-1.5 py-1 text-xs">
              {aiActions.map((action, i) => {
                switch (action.kind) {
                  case "create_event": {
                    const prefill = calendarPrefill(action);
                    if (!prefill) return null;
                    const when = new Date(prefill.startsAt).toLocaleString(i18n.language, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      ...(action.allDay ? {} : { hour: "numeric", minute: "2-digit" }),
                    });
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => createSuggestedEvent(action)}
                        title={t("compose:ai.addToCalendarTip")}
                        className="co-ai-fill inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ink transition-opacity hover:opacity-90"
                      >
                        <Icon name="calendar" size={12} />
                        <span>{t("compose:ai.addToCalendar")}</span>
                        <span className="text-ink-muted">
                          {action.title} · {when}
                        </span>
                      </button>
                    );
                  }
                }
              })}
              <button
                type="button"
                onClick={() => setAiActions([])}
                className="px-1 text-ink-faint hover:text-ink-muted"
              >
                {t("compose:ai.dismiss")}
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div data-testid="attachment-chips" className="flex flex-wrap gap-2 py-2">
              {attachments.map((a) => (
                <span key={a.filePath} className="co-chip" title={a.filePath}>
                  <Icon name="paperclip" size={11} />
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
            minHeightClass={inline ? "min-h-[140px]" : "min-h-[320px]"}
            expandShortcut={expandShortcut}
            onMention={addMention}
          />

          {(state.mode === "reply" || state.mode === "reply_all") &&
            (quickReplies || quickRepliesFallback) &&
            isHtmlEmpty(stripSignature(body)) && (
              <div
                className="flex flex-wrap items-center gap-2 pb-3"
                data-testid="quick-replies"
              >
                {quickReplies && <AiSparkle size={13} className="co-chip-pop" />}
                {(
                  quickReplies ?? [
                    t("compose:quickReply1"),
                    t("compose:quickReply2"),
                    t("compose:quickReply3"),
                  ]
                ).map((s, i) => (
                  <button
                    key={s}
                    style={{ animationDelay: `${(i + 1) * 60}ms` }}
                    className="co-chip-pop rounded-full border border-hairline bg-bg0 px-3 py-1 text-sm text-ink-muted hover:border-hairline-strong hover:bg-bg2 hover:text-ink"
                    onClick={() => {
                      markDirty();
                      bodyRef.current?.insertText(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

          {init.quote && !quoteRemoved && (
            <div className="pb-3">
              {!quoteOpen ? (
                <button
                  className="rounded-control border border-hairline bg-bg2 px-2.5 pb-1 text-md leading-[10px] tracking-widest text-ink-faint hover:text-ink"
                  title={t("compose:showQuoted")}
                  aria-label={t("compose:showQuoted")}
                  onClick={() => setQuoteOpen(true)}
                >
                  ⋯
                </button>
              ) : (
                <div className="co-fade-in rounded-control border-l-2 border-hairline-strong bg-bg0/60 px-3 py-2">
                  <div className="mb-1 flex items-center gap-3 text-xs text-ink-faint">
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
                  <pre className="max-h-44 overflow-y-auto font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink-faint">
                    {stripQuoteMarkers(init.quote)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="mt-1 flex shrink-0 items-center gap-3 border-t border-hairline pt-3">
          <Button variant="primary" className="px-4" onClick={() => void doSend()} disabled={sending}>
            {t("compose:send")}
          </Button>
          <Button
            icon="paperclip"
            onClick={() => void attachFiles()}
            title={`${t("compose:attach")} (${MOD_LABEL}⇧A)`}
          >
            {t("compose:attach")}
          </Button>
          <Button
            variant="ai"
            size="sm"
            onClick={() => void runProofread()}
            busy={proofPending}
            disabled={isHtmlEmpty(stripSignature(body))}
            title={`${t("compose:proofread")} (${MOD_LABEL}⇧P)`}
          >
            {t("compose:proofread")}
          </Button>
          {isMicrosoftAccount && (
            <Button
              icon="video"
              onClick={() => void createTeamsMeeting()}
              busy={teamsPending}
              title={t("compose:teamsMeetingTip")}
            >
              {t("compose:teamsMeeting")}
            </Button>
          )}
          <span className="text-xs text-ink-faint">
            {t("compose:footerHints", { mod: MOD_LABEL })}
          </span>
          <div className="grow" />
          {!state.initial && accountSigs.length > 0 && (
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={signatureMenu != null}
              title={t("compose:signature.label")}
              data-testid="signature-picker"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSignatureMenu(signatureMenu ? null : { x: r.left, y: r.bottom + 4 });
              }}
              className="flex shrink-0 items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-ink-faint hover:bg-bg2 hover:text-ink-muted"
            >
              {t("compose:signature.trigger", {
                name: activeSig?.name ?? t("compose:signature.none"),
              })}
              <Icon name="chevronDown" size={12} />
            </button>
          )}
          {signatureMenu && (
            <Popover x={signatureMenu.x} y={signatureMenu.y} onClose={() => setSignatureMenu(null)}>
              {accountSigs.map((s) => (
                <MenuItem
                  key={s.id}
                  label={s.name}
                  active={activeSig?.id === s.id}
                  icon={<SigCheck on={activeSig?.id === s.id} />}
                  onClick={() => {
                    setManualSigId(s.id);
                    setSignatureMenu(null);
                    markDirty();
                  }}
                />
              ))}
              <MenuDivider />
              <MenuItem
                label={t("compose:signature.none")}
                active={!activeSig}
                icon={<SigCheck on={!activeSig} />}
                onClick={() => {
                  setManualSigId(null);
                  setSignatureMenu(null);
                  markDirty();
                }}
              />
            </Popover>
          )}
          <span className="text-xs text-ink-faint">
            {savedAt ? t("compose:draftSaved") : dirtyRef.current ? t("compose:unsaved") : ""}
          </span>
        </div>

        {/* discard / save confirm */}
        {confirmOpen && (
          <div className="co-fade-in absolute inset-0 z-10 flex items-center justify-center rounded-card bg-bg0/70 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-3 rounded-card border border-hairline bg-bg1 px-6 py-5 shadow-elev-2">
              <span className="text-base text-ink">{t("compose:keepDraft")}</span>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void saveAndClose()}>
                  {t("compose:saveDraftButton")}
                </Button>
                <Button variant="danger" onClick={() => void discard()}>
                  {t("compose:discard")}
                </Button>
                <Button onClick={() => set({ composerConfirmOpen: false })}>
                  {t("compose:keepWriting")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {dragOver && (
          <div className="co-fade-in pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-accent/10">
            <span className="rounded-control bg-bg1 px-3.5 py-1.5 text-base font-medium text-accent shadow-elev-2">
              {t("compose:dropToAttach")}
            </span>
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
  /** Scope contact autocomplete to this account; undefined shows all accounts. */
  suggestAccountId?: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RecipientField label={t("compose:to")} value={props.to} onChange={props.setTo} autoFocus={props.autoFocusTo} accountId={props.suggestAccountId} />
      {props.showCc && (
        <>
          <RecipientField label={t("compose:cc")} value={props.cc} onChange={props.setCc} accountId={props.suggestAccountId} />
          <RecipientField label={t("compose:bcc")} value={props.bcc} onChange={props.setBcc} accountId={props.suggestAccountId} />
        </>
      )}
    </>
  );
}

/** Leading check for the current choice in the signature menu; a same-width
 *  blank keeps the labels aligned. */
function SigCheck({ on }: { on: boolean }) {
  return on ? <Icon name="check" size={13} className="text-accent" /> : <span className="w-[13px]" />;
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
        className="co-pop-in w-[440px] rounded-card border border-hairline bg-bg1 p-1 shadow-elev-2"
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
          className="co-hairline-b w-full bg-transparent px-3 py-2 text-md text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="max-h-64 overflow-y-auto pt-1">
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-ink-faint">{t("compose:noSnippets")}</p>
          )}
          {filtered.map((s, i) => (
            <button
              key={s.id}
              className={`flex w-full items-baseline gap-2 rounded-control px-3 py-2 text-left ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => onPick(s.id)}
            >
              <span className="text-base text-ink">{s.name}</span>
              {s.shortcut && <span className="font-mono text-xs text-accent">;{s.shortcut}</span>}
              <span className="ml-auto truncate pl-3 text-xs text-ink-faint">
                {s.bodyText.replace(/\s+/g, " ").slice(0, 40)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
