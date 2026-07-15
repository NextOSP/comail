import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { performThreadAction } from "../../queries/actions";
import { useThread } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

import { relativeTime } from "../../lib/format";
import { Composer } from "../compose/Composer";
import { MessageCard } from "./MessageCard";

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
  useEffect(() => {
    if (!data || autoScrolledFor.current === threadId) return;
    autoScrolledFor.current = threadId;
    let timer: number | undefined;
    const raf = requestAnimationFrame(() => {
      const el = anchorRef.current;
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      // Message bodies render into iframes that grow after first paint and
      // shift the layout, so re-center once things settle - unless the user
      // has scrolled in the meantime.
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1)
        scroller = scroller.parentElement;
      const pos = scroller?.scrollTop;
      timer = window.setTimeout(() => {
        if (scroller == null || scroller.scrollTop === pos)
          anchorRef.current?.scrollIntoView({ block: "center" });
      }, 350);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timer !== undefined) clearTimeout(timer);
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
      <div className="min-w-0 flex-1 overflow-y-auto">
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
          <kbd className="co-kbd">H</kbd> {t("thread:footer.snooze")} · <kbd className="co-kbd">⇧J</kbd> {t("thread:footer.summarize")} ·{" "}
          <kbd className="co-kbd">↑</kbd>
          <kbd className="co-kbd">↓</kbd> {t("thread:footer.message")} · <kbd className="co-kbd">J</kbd>
          <kbd className="co-kbd">K</kbd> {t("thread:footer.nextPrev")}
        </footer>
      </div>
      </div>

      {hasSummary && <AiSummarySidebar threadId={threadId} onUseReply={useProposedReply} />}
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

/** A section heading in the summary sidebar. */
function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[10.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The structured AI thread read, docked to the right of the conversation
 * (opened with Shift+J). Timeline, key points, the one next action, and a
 * proposed reply the user can drop straight into the composer.
 */
function AiSummarySidebar({
  threadId,
  onUseReply,
}: {
  threadId: number;
  onUseReply: (text: string) => void;
}) {
  const { t } = useTranslation();
  const entry = useUi((s) => s.aiSummaries[threadId]);
  const set = useUi((s) => s.set);
  if (!entry) return null;

  const dismiss = () => {
    const cur = { ...useUi.getState().aiSummaries };
    delete cur[threadId];
    set({ aiSummaries: cur });
  };

  const s = entry.summary;

  return (
    <aside
      data-testid="ai-summary"
      className="co-fade-in flex w-[326px] shrink-0 flex-col overflow-y-auto border-l border-hairline bg-bg1"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-hairline bg-bg1 px-4 py-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9L12 2zM19 14l.9 2.6L22.5 17l-2.6.9L19 20l-.9-2.1L15.5 17l2.6-.4L19 14z" />
          </svg>
          {t("thread:aiSummary.title")}
        </div>
        <button
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-ink-faint hover:bg-bg2 hover:text-ink"
          onClick={dismiss}
          aria-label={t("thread:aiSummary.dismiss")}
        >
          ✕
        </button>
      </div>

      {entry.pending ? (
        <div className="flex items-center gap-2 px-4 py-4 text-[13px] text-ink-faint italic">
          <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
          {t("thread:aiSummary.pending")}
        </div>
      ) : !s ? (
        <div className="px-4 py-4 text-[13px] text-ink-faint">{t("thread:aiSummary.empty")}</div>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4">
          {s.timeline.length > 0 && (
            <SummarySection title={t("thread:aiSummary.timeline")}>
              <ol className="flex flex-col gap-2.5">
                {s.timeline.map((e, i) => (
                  <li key={i} className="relative flex gap-2.5 pl-1">
                    <span className="mt-1 flex flex-col items-center">
                      <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                      {i < s.timeline.length - 1 && <span className="mt-1 w-px flex-1 bg-hairline" />}
                    </span>
                    <p className="text-[12.5px] leading-snug text-ink-muted">
                      <span className="font-medium text-ink">{e.actor}</span> {e.event}
                    </p>
                  </li>
                ))}
              </ol>
            </SummarySection>
          )}

          {s.keyPoints.length > 0 && (
            <SummarySection title={t("thread:aiSummary.keyPoints")}>
              <ul className="flex flex-col gap-1.5">
                {s.keyPoints.map((p, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink-muted">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-faint" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </SummarySection>
          )}

          {s.nextAction && (
            <SummarySection title={t("thread:aiSummary.nextAction")}>
              <p
                className="border border-hairline bg-bg0 px-3 py-2 text-[12.5px] leading-snug text-ink"
                style={{ borderLeft: "3px solid var(--accent)" }}
              >
                {s.nextAction}
              </p>
            </SummarySection>
          )}

          {s.proposedReply && (
            <SummarySection title={t("thread:aiSummary.proposedReply")}>
              <p className="border border-hairline bg-bg0 px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                {s.proposedReply}
              </p>
              <button
                className="mt-0.5 self-start rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
                onClick={() => onUseReply(s.proposedReply!)}
              >
                {t("thread:aiSummary.useReply")}
              </button>
            </SummarySection>
          )}
        </div>
      )}
    </aside>
  );
}
