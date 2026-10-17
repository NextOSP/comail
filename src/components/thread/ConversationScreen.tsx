import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { calendarPrefill } from "../../lib/calendarSuggestion";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { deleteDrafts, performThreadAction } from "../../queries/actions";
import { useThread } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

import { MOD_LABEL, relativeTime } from "../../lib/format";
import { latestUnsubscribeMessage, unsubscribeFromMessage } from "../../lib/unsubscribe";
import { Composer } from "../compose/Composer";
import { AiBadge, AiSurface } from "../ui/Ai";
import { Button, IconButton } from "../ui/Button";
import { SectionLabel } from "../ui/Field";
import { Spinner } from "../ui/Spinner";
import { MessageCard } from "./MessageCard";

/** Any of these means the user took over scrolling, ending the on-open
 *  auto-align (wheel/trackpad, touch, keyboard nav, scrollbar drag). */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "mousedown"] as const;

export function ConversationScreen({ threadId }: { threadId: number }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useThread(threadId);
  const focusedMessageId = useUi((s) => s.focusedMessageId);
  const visibleThreadIds = useUi((s) => s.visibleThreadIds);
  const openThread = useUi((s) => s.openThread);
  const openComposer = useUi((s) => s.openComposer);
  const set = useUi((s) => s.set);
  const hasSummary = useUi((s) => s.aiSummaries[threadId] != null);
  // Pointer selection (hover / click) makes a message the reply target without
  // scrolling the view - only keyboard nav (N/P) scrolls the cursor into view.
  const selectMessage = (id: number) => {
    if (useUi.getState().focusedMessageId !== id)
      set({ focusedMessageId: id, messageCursorSource: "pointer" });
  };
  const composer = useUi((s) => s.composer);
  const inlineComposer = composer != null && composer.replyTo?.threadId === threadId;

  // Explicit expand/collapse overrides (id -> expanded)
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  useEffect(() => setOverrides({}), [threadId]);

  // Keyboard message nav (N/P) expands the message it lands on and keeps it
  // open. Pointer selection (hover/click) never triggers this, so moving the
  // mouse to pick a reply target doesn't expand or collapse anything.
  useEffect(() => {
    if (focusedMessageId != null && useUi.getState().messageCursorSource === "keyboard") {
      setOverrides((o) => ({ ...o, [focusedMessageId]: true }));
    }
  }, [focusedMessageId]);

  // Ref on the newest (last) message so the count header can jump to it on long
  // threads. We walk up from it to find the actual scroll container (the
  // overflow-y-auto wrapper isn't reliably the scroller at runtime) and scroll
  // that fully to the bottom - guaranteed to land on the latest message.
  const lastMsgRef = useRef<HTMLDivElement>(null);
  const scrollToLatest = () => {
    const target = lastMsgRef.current;
    if (!target) return;
    // Belt-and-suspenders, because the real scroll container differs between
    // the Tauri webview and the browser, and native `behavior:"smooth"` is
    // unreliable there:
    //   1. scrollIntoView lets the engine find and scroll the right container.
    //   2. Then force every overflowing ancestor + the document to the bottom
    //      (instant assignment; harmless no-op on non-scrollers).
    target.scrollIntoView({ block: "end" });
    for (let el: HTMLElement | null = target.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
    }
    const doc = document.scrollingElement as HTMLElement | null;
    if (doc) doc.scrollTop = doc.scrollHeight;
  };

  // On open, bring the message that matters (first unread, else the latest)
  // to the middle of the view. Without this, long threads open pinned to the
  // top and the new mail sits below the fold. Runs once per thread; keyboard
  // and pointer scrolling afterwards are untouched.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledFor = useRef<number | null>(null);
  // Whether the on-open anchor is the very first message (nothing read above
  // it). Set in render below; read by the auto-center effect.
  const anchorIsFirstRef = useRef(false);

  // A freshly opened thread must start at the top. App keeps a single
  // ConversationScreen mounted (no key), so the scroll container is reused and
  // its scrollTop otherwise carries over from the previous email - most visible
  // at small window sizes, where the thread actually overflows. Reset it as a
  // layout effect so the top lands before the browser paints the new thread,
  // once per thread (never on later `data` changes like auto-mark-read, which
  // would yank a reader back to the top). The real scroller differs between the
  // Tauri webview and the browser, so clear the wrapper, any overflowing
  // ancestor, and the document - the reverse of scrollToLatest.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollResetFor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!data || scrollResetFor.current === threadId) return;
    const el = scrollerRef.current;
    if (!el) return;
    scrollResetFor.current = threadId;
    el.scrollTop = 0;
    for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement)
      if (a.scrollHeight > a.clientHeight + 1) a.scrollTop = 0;
    const doc = document.scrollingElement as HTMLElement | null;
    if (doc) doc.scrollTop = 0;
  }, [data, threadId]);

  useEffect(() => {
    if (!data || autoScrolledFor.current === threadId) return;
    autoScrolledFor.current = threadId;
    // The first unread IS the first message: the layout effect already parked us
    // at the top, which is where new mail should start. Only threads with read
    // history above the new mail need centering to pull it above the fold.
    if (anchorIsFirstRef.current) return;

    // A message that (nearly) fills the viewport aligns to its top so its body
    // occupies the screen; a short one centers so the surrounding thread stays
    // visible for context.
    const align = () => {
      const el = anchorRef.current;
      if (!el) return;
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1)
        scroller = scroller.parentElement;
      const viewH = scroller?.clientHeight ?? window.innerHeight;
      el.scrollIntoView({ block: el.offsetHeight > viewH * 0.6 ? "start" : "center" });
    };

    // Message bodies render into sandboxed iframes that are measured and grow
    // well after first paint (body fetch, remote images, the height
    // transition), so a one-shot scroll lands short: at scroll time the anchor
    // is a small skeleton at the very end of the content, the scroller clamps
    // at its bottom, and once the iframe grows the message header is left
    // pinned at the bottom edge with the whole body below the fold. Instead,
    // re-align on every content resize during a settle window - and stop the
    // moment the user scrolls on their own.
    let done = false;
    const ro = new ResizeObserver(align);
    const stop = () => {
      if (done) return;
      done = true;
      ro.disconnect();
      for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, stop, true);
      window.clearTimeout(settle);
    };
    const content = scrollerRef.current?.firstElementChild;
    if (content) ro.observe(content);
    for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, stop, true);
    const settle = window.setTimeout(stop, 2000);
    const raf = requestAnimationFrame(align);
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [data, threadId]);

  // Hide the draft that's open in the inline composer so it isn't double-rendered.
  const editingDraftId = useUi((s) => s.editingDraftId);
  const hiddenDraftId = inlineComposer ? editingDraftId : null;
  const messages = useMemo(
    () => (data?.messages ?? []).filter((m) => m.id !== hiddenDraftId),
    [data, hiddenDraftId],
  );

  // Auto mark read shortly after opening.
  useEffect(() => {
    if (!data || data.thread.unreadCount === 0) return;
    const t = setTimeout(() => {
      void performThreadAction("mark_read", [threadId]);
    }, 500);
    return () => clearTimeout(t);
  }, [data, threadId]);

  const position = visibleThreadIds.indexOf(threadId);

  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">{t("common:loading")}</div>;
  }
  if (isError || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-ink-faint">
        {t("thread:couldntLoad")}
        <button className="text-accent" onClick={() => openThread(null)}>
          {t("thread:backToList")}
        </button>
      </div>
    );
  }

  const lastId = messages[messages.length - 1]?.id;
  // Where the on-open auto-scroll lands: the first unread message (start of
  // what's new), falling back to the newest one.
  const anchorId = messages.find((m) => !m.isRead && !m.isDraft)?.id ?? lastId;
  anchorIsFirstRef.current = anchorId === messages[0]?.id;
  // The message a reply will target, mirrored as a highlight so it's always
  // clear which one is selected. Defaults (nothing hovered/navigated yet) to
  // the latest incoming message - matching the keyboard `compose` fallback - so
  // the highlight and the reply target never disagree.
  const nonDraft = messages.filter((m) => !m.isDraft);
  const defaultTargetId =
    [...nonDraft].reverse().find((m) => !m.isOutgoing)?.id ??
    nonDraft[nonDraft.length - 1]?.id ??
    null;
  const selectedId = focusedMessageId ?? defaultTargetId;
  // Same message the U shortcut targets, so button and key never disagree.
  const unsubMsg = latestUnsubscribeMessage(messages);

  // Seed a reply composer with the AI's proposed answer, targeting the same
  // message a manual reply would (the highlighted one), quote and recipients
  // included - the user reviews and sends.
  const useProposedReply = (text: string) => {
    const target =
      nonDraft.find((m) => m.id === selectedId) ??
      [...nonDraft].reverse().find((m) => !m.isOutgoing) ??
      nonDraft[nonDraft.length - 1];
    if (!target) return;
    openComposer({
      mode: "reply",
      replyTo: target,
      accountId: target.accountId,
      initial: {
        to: target.isOutgoing ? target.to : [target.from],
        subject: /^re:/i.test(target.subject)
          ? target.subject
          : t("compose:replyPrefix", { subject: target.subject }),
        body: text,
      },
    });
  };

  const editDraft = async (draftId: number) => {
    try {
      const draft = await call("get_draft", { draftId });
      const mode =
        draft.mode === "reply" ||
        draft.mode === "reply_all" ||
        draft.mode === "forward"
          ? draft.mode
          : "new";
      const replyTo =
        draft.inReplyToMessageId == null
          ? undefined
          : data.messages.find((m) => m.id === draft.inReplyToMessageId);
      openComposer({
        mode,
        draftId,
        accountId: draft.accountId,
        replyTo,
        initial: {
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body: draft.bodyText,
          bodyHtml: draft.bodyHtml ?? undefined,
          attachments: draft.attachments,
        },
      });
    } catch (err) {
      useUi.getState().pushToast({
        kind: "error",
        message: t("thread:draftOpenFailed", { detail: errorMessage(err) }),
      });
    }
  };

  const deleteDraft = async (draftId: number) => {
    const ui = useUi.getState();
    try {
      await deleteDrafts([draftId]);
      if (ui.editingDraftId === draftId) ui.closeComposer();
      ui.pushToast({ kind: "info", message: t("thread:draftDeleted"), durationMs: 2500 });
    } catch (err) {
      ui.pushToast({
        kind: "error",
        message: t("compose:discardFailed", { detail: errorMessage(err) }),
      });
    }
  };
  // Expansion follows explicit toggles, the last message, and unread state -   // NOT the selection, so hovering to pick a reply target never expands or
  // collapses a message. Keyboard nav (N/P) expands its target via the effect
  // below ("expand next/previous").
  const isExpanded = (id: number, isRead: boolean) => {
    if (overrides[id] !== undefined) return overrides[id];
    if (id === lastId) return true;
    return !isRead;
  };

  return (
    <div className="co-fade-in flex min-h-0 flex-1 overflow-hidden">
      {/* Keyed by thread so switching conversations (auto-advance after
          archive/delete included) replaces the scroll container outright -
          a fresh node is born at scrollTop 0, independent of how the engine
          times scroll clamping while async iframe bodies grow in. */}
      <div key={threadId} ref={scrollerRef} className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 py-6 pb-24">
        <header className="flex items-start justify-between gap-4">
          <div>
            <button
              className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-faint hover:text-ink-muted"
              onClick={() => openThread(null)}
            >
              ← {t("thread:back")}
              <kbd className="co-kbd !text-[10px]">Esc</kbd>
            </button>
            <h1 className="text-[23px] leading-tight font-semibold tracking-tight text-ink">
              {data.thread.subject || t("thread:noSubject")}
              {data.thread.isStarred && <span className="ml-2 align-middle text-[16px] text-star">★</span>}
            </h1>
            <p className="mt-1 text-[12px] text-ink-faint">
              <button
                type="button"
                className="rounded-sm hover:text-ink-muted hover:underline"
                title={t("thread:jumpToLatest")}
                onClick={scrollToLatest}
              >
                {t("thread:messages", { count: messages.length })}
              </button>{" "}
              · {data.thread.accountEmail} · {relativeTime(data.thread.lastMessageAt)}
              {unsubMsg && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="rounded-sm hover:text-ink-muted hover:underline"
                    title={t("thread:unsubscribeTitle")}
                    onClick={() => void unsubscribeFromMessage(unsubMsg)}
                  >
                    {t("thread:unsubscribe")}
                  </button>
                </>
              )}
              {data.thread.snoozedUntil && data.thread.snoozedUntil > Date.now() && (
                <span className="ml-2 text-accent">{t("thread:snoozedBadge")}</span>
              )}
            </p>
          </div>
          {position >= 0 && (
            <span className="mt-1 shrink-0 text-[11.5px] whitespace-nowrap text-ink-faint tabular-nums">
              {t("thread:positionOf", { pos: position + 1, total: visibleThreadIds.length })}
            </span>
          )}
        </header>

        {hasSummary && <AiThreadSummary key={threadId} threadId={threadId} onUseReply={useProposedReply} />}

        <div className="flex flex-col gap-1.5">
          {messages.map((m) => (
            <div
              key={m.id}
              ref={(el) => {
                if (m.id === lastId) lastMsgRef.current = el;
                if (m.id === anchorId) anchorRef.current = el;
              }}
              onMouseEnter={() => selectMessage(m.id)}
            >
              <MessageCard
                message={m}
                focused={selectedId === m.id}
                expanded={isExpanded(m.id, m.isRead)}
                onEditDraft={m.isDraft ? () => void editDraft(m.id) : undefined}
                onDeleteDraft={m.isDraft ? () => void deleteDraft(m.id) : undefined}
                onToggle={() => {
                  selectMessage(m.id);
                  setOverrides((o) => ({ ...o, [m.id]: !isExpanded(m.id, m.isRead) }));
                }}
              />
            </div>
          ))}
        </div>

        {inlineComposer && composer && (
          <InlineComposerAnchor>
            <Composer
              key={`${composer.mode}-${composer.replyTo?.id ?? "new"}-${composer.draftId ?? 0}`}
              state={composer}
              inline
            />
          </InlineComposerAnchor>
        )}

        <footer className="mt-2 flex items-center gap-2 text-[12px] text-ink-faint">
          <kbd className="co-kbd">↵</kbd> {t("thread:footer.replyAll")} · <kbd className="co-kbd">R</kbd> {t("thread:footer.reply")} ·{" "}
          <kbd className="co-kbd">F</kbd> {t("thread:footer.forward")} · <kbd className="co-kbd">E</kbd> {t("thread:footer.done")} ·{" "}
          <kbd className="co-kbd">H</kbd> {t("thread:footer.snooze")} · <kbd className="co-kbd">{MOD_LABEL}J</kbd> {t("thread:footer.summarize")} ·{" "}
          <kbd className="co-kbd">↑</kbd>
          <kbd className="co-kbd">↓</kbd> {t("thread:footer.message")} · <kbd className="co-kbd">J</kbd>
          <kbd className="co-kbd">K</kbd> {t("thread:footer.nextPrev")}
        </footer>
      </div>
      </div>
    </div>
  );
}

/** Scrolls the inline reply into view when it appears. */
function InlineComposerAnchor({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** A titled group inside the thread summary. */
function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

/**
 * The structured AI thread read, a collapsible block at the top of the
 * conversation (opened with Cmd/Ctrl+J). Key points, the one next action, a
 * timeline, and a proposed reply the user can drop straight into the composer.
 */
function AiThreadSummary({
  threadId,
  onUseReply,
}: {
  threadId: number;
  onUseReply: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const entry = useUi((s) => s.aiSummaries[threadId]);
  const set = useUi((s) => s.set);
  const [collapsed, setCollapsed] = useState(false);
  if (!entry) return null;

  const dismiss = () => {
    const cur = { ...useUi.getState().aiSummaries };
    delete cur[threadId];
    set({ aiSummaries: cur });
  };

  const s = entry.summary;
  const suggestedEvent = s?.calendarSuggestion ?? null;
  const eventPrefill = suggestedEvent ? calendarPrefill(suggestedEvent) : null;

  const toggleLabel = collapsed ? t("thread:aiSummary.expand") : t("thread:aiSummary.collapse");

  return (
    <div data-testid="ai-summary" className="co-fade-in">
      <AiSurface as="section" className="overflow-hidden">
        <div className="flex items-center gap-1 py-1.5 pr-1.5 pl-3.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            title={t("thread:aiSummary.shortcutHint", { kbd: `${MOD_LABEL}J` })}
          >
            <AiBadge label={t("thread:aiSummary.title")} className="text-sm" />
            {entry.pending && <Spinner className="co-ai-icon" />}
          </button>
          <IconButton
            icon={collapsed ? "chevronDown" : "chevronUp"}
            label={toggleLabel}
            size="xs"
            onClick={() => setCollapsed((c) => !c)}
          />
          <IconButton icon="close" label={t("thread:aiSummary.dismiss")} size="xs" onClick={dismiss} />
        </div>

        {collapsed ? null : entry.pending && !s ? (
          <div className="px-3.5 pt-1 pb-3.5 text-base text-ink-faint italic">{t("thread:aiSummary.pending")}</div>
        ) : !s ? (
          <div className="px-3.5 pt-1 pb-3.5 text-base text-ink-faint">{t("thread:aiSummary.empty")}</div>
        ) : (
        <div className="flex flex-col gap-4 px-3.5 pt-1 pb-3.5">
          {s.keyPoints.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {s.keyPoints.map((p, i) => (
                <li key={i} className="flex gap-2 text-base leading-snug text-ink">
                  <span className="mt-[0.5em] size-1 shrink-0 rounded-full bg-ink-faint" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}

          {s.nextAction && (
            <SummarySection title={t("thread:aiSummary.nextAction")}>
              <p className="co-ai-fill rounded-control px-3 py-2 text-sm leading-snug text-ink">{s.nextAction}</p>
            </SummarySection>
          )}

          {s.timeline.length > 0 && (
            <SummarySection title={t("thread:aiSummary.timeline")}>
              <ol className="flex flex-col gap-2.5">
                {s.timeline.map((e, i) => (
                  <li key={i} className="relative flex gap-2.5 pl-1">
                    <span className="mt-1 flex flex-col items-center">
                      <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                      {i < s.timeline.length - 1 && <span className="mt-1 w-px flex-1 bg-hairline" />}
                    </span>
                    <p className="text-sm leading-snug text-ink-muted">
                      <span className="font-medium text-ink">{e.actor}</span> {e.event}
                    </p>
                  </li>
                ))}
              </ol>
            </SummarySection>
          )}

          {suggestedEvent && eventPrefill && (
            <SummarySection title={t("thread:aiSummary.calendarSuggestion")}>
              <div className="rounded-control border border-hairline bg-bg0 px-3 py-2.5">
                <p className="text-sm font-medium text-ink">{suggestedEvent.title}</p>
                <p className="mt-1 text-xs leading-snug text-ink-muted">
                  {new Date(eventPrefill.startsAt).toLocaleString(i18n.language, {
                    dateStyle: "medium",
                    ...(suggestedEvent.allDay ? {} : { timeStyle: "short" as const }),
                  })}
                </p>
                {suggestedEvent.location && (
                  <p className="mt-0.5 text-xs text-ink-faint">{suggestedEvent.location}</p>
                )}
                <Button
                  size="sm"
                  icon="plus"
                  className="mt-2"
                  onClick={() => set({ eventCreate: { prefill: eventPrefill } })}
                >
                  {t("thread:aiSummary.createEvent")}
                </Button>
              </div>
            </SummarySection>
          )}

          {s.proposedReply && (
            <SummarySection title={t("thread:aiSummary.proposedReply")}>
              <p className="rounded-control border border-hairline bg-bg0 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">
                {s.proposedReply}
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-2 self-start"
                onClick={() => onUseReply(s.proposedReply!)}
              >
                {t("thread:aiSummary.useReply")}
              </Button>
            </SummarySection>
          )}
        </div>
        )}
      </AiSurface>
    </div>
  );
}
