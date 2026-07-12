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
  const composer = useUi((s) => s.composer);
  const inlineComposer = composer != null && composer.replyTo?.threadId === threadId;

  // Explicit expand/collapse overrides (id -> expanded)
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  useEffect(() => setOverrides({}), [threadId]);

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
  const isExpanded = (id: number, isRead: boolean) => {
    if (overrides[id] !== undefined) return overrides[id];
    if (focusedMessageId === id) return true;
    if (id === lastId) return true;
    return !isRead;
  };

  return (
    <div className="co-fade-in min-h-0 flex-1 overflow-y-auto">
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
            <h1 className="text-[19px] leading-snug font-semibold tracking-tight text-ink">
              {data.thread.subject || t("thread:noSubject")}
              {data.thread.isStarred && <span className="ml-2 align-middle text-[14px] text-star">★</span>}
            </h1>
            <p className="mt-1 text-[12px] text-ink-faint">
              {t("thread:messages", { count: messages.length })} ·{" "}
              {data.thread.accountEmail} · {relativeTime(data.thread.lastMessageAt)}
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

        <AiSummaryBanner threadId={threadId} />

        <div className="flex flex-col gap-2.5">
          {messages.map((m) => (
            <MessageCard
              key={m.id}
              message={m}
              focused={focusedMessageId === m.id}
              expanded={isExpanded(m.id, m.isRead)}
              onToggle={() =>
                setOverrides((o) => ({ ...o, [m.id]: !isExpanded(m.id, m.isRead) }))
              }
            />
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
          <kbd className="co-kbd">J</kbd>
          <kbd className="co-kbd">K</kbd> {t("thread:footer.nextPrev")}
        </footer>
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

/** Dismissible AI thread summary pinned above the messages (Shift+J). */
function AiSummaryBanner({ threadId }: { threadId: number }) {
  const { t } = useTranslation();
  const entry = useUi((s) => s.aiSummaries[threadId]);
  const set = useUi((s) => s.set);
  if (!entry) return null;

  const dismiss = () => {
    const cur = { ...useUi.getState().aiSummaries };
    delete cur[threadId];
    set({ aiSummaries: cur });
  };

  return (
    <div
      data-testid="ai-summary"
      className="co-fade-in flex items-start gap-3 rounded-lg border border-hairline bg-bg1 py-3 pr-3 pl-4"
      style={{ borderLeft: "3px solid var(--accent)", boxShadow: "var(--elev-1)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[10.5px] font-semibold tracking-[0.12em] text-accent uppercase">
          {t("thread:aiSummary.title")}
        </div>
        {entry.pending ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-faint italic">
            <span className="co-spinner size-3 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
            {t("thread:aiSummary.pending")}
          </div>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-ink-muted italic">{entry.text}</p>
        )}
      </div>
      <button
        className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-bg2 hover:text-ink"
        onClick={dismiss}
        aria-label={t("thread:aiSummary.dismiss")}
      >
        ✕
      </button>
    </div>
  );
}
