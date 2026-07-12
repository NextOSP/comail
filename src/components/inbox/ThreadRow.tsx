import { memo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Label, ThreadSummary } from "../../ipc/types";
import { participantSummary, relativeTime } from "../../lib/format";

function ThreadRowImpl({
  thread,
  selected,
  checked,
  selectionMode,
  selfEmails,
  labelMap,
  onRowClick,
  onToggleCheck,
  onGutterDown,
  onHover,
  leaving,
}: {
  thread: ThreadSummary;
  selected: boolean;
  checked: boolean;
  selectionMode: boolean;
  selfEmails: Set<string>;
  labelMap?: Map<number, Label>;
  onRowClick: (id: number, e: MouseEvent) => void;
  onToggleCheck: (id: number) => void;
  /** When provided, press-and-drag in the gutter starts a range sweep. */
  onGutterDown?: (id: number, e: MouseEvent) => void;
  onHover?: (id: number) => void;
  leaving?: boolean;
}) {
  const { t } = useTranslation();
  const unread = thread.unreadCount > 0;

  return (
    <div
      className={`co-row flex h-full cursor-default items-center gap-3 pr-5 pl-4 ${leaving ? "co-row-leaving" : ""}`}
      data-selected={selected}
      data-checked={checked}
      onClick={(e) => onRowClick(thread.id, e)}
      onMouseEnter={onHover ? () => onHover(thread.id) : undefined}
    >
      {/* gutter: checkbox (selection) / unread dot / star */}
      <button
        className="flex w-5 shrink-0 items-center justify-center"
        onMouseDown={
          onGutterDown
            ? (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                onGutterDown(thread.id, e);
              }
            : undefined
        }
        onClick={
          onGutterDown
            ? (e) => e.stopPropagation() // drag controller handles toggle on mouseup
            : (e) => {
                e.stopPropagation();
                onToggleCheck(thread.id);
              }
        }
        tabIndex={-1}
        aria-label={checked ? t("common:threadRow.deselect") : t("common:threadRow.select")}
      >
        {checked || selectionMode ? (
          <span
            className={`flex size-4 items-center justify-center rounded border text-[10px] ${
              checked
                ? "border-accent bg-accent text-bg0"
                : "border-hairline-strong text-transparent"
            }`}
          >
            ✓
          </span>
        ) : unread ? (
          <span className="size-2 rounded-full bg-info" />
        ) : thread.isStarred ? (
          <StarIcon />
        ) : (
          <span className="size-2" />
        )}
      </button>

      <span
        className={`w-52 shrink-0 truncate text-[13.5px] ${
          unread ? "font-semibold text-ink" : "text-ink-muted"
        }`}
      >
        {participantSummary(thread.participants, selfEmails)}
        {thread.messageCount > 1 && (
          <span className="ml-1.5 text-[11.5px] font-normal text-ink-faint">
            {thread.messageCount}
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1 truncate text-[13.5px]">
        <span className={unread ? "font-semibold text-ink" : "text-ink"}>{thread.subject}</span>
        <span className="text-ink-faint">&ensp;-&ensp;{thread.snippet}</span>
      </span>

      {labelMap && thread.labels.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {thread.labels.slice(0, 3).map((id) => {
            const l = labelMap.get(id);
            if (!l) return null;
            return (
              <span
                key={id}
                className="max-w-[110px] truncate rounded-full px-2 py-[1px] text-[10.5px] font-medium"
                style={{ background: `${l.color}22`, color: l.color }}
                title={l.name}
              >
                {l.name}
              </span>
            );
          })}
        </span>
      )}

      {thread.isStarred && (unread || checked || selectionMode) && <StarIcon />}
      {thread.hasAttachments && (
        <span className="shrink-0 text-ink-faint" title={t("common:threadRow.hasAttachments")} aria-label={t("common:threadRow.attachment")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
      )}

      <span
        className={`w-14 shrink-0 text-right text-[11.5px] tabular-nums ${
          unread ? "font-semibold text-info" : "text-ink-faint"
        }`}
      >
        {relativeTime(thread.lastMessageAt)}
      </span>
    </div>
  );
}

export const ThreadRow = memo(ThreadRowImpl);

function StarIcon() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 text-star" aria-label={t("common:threadRow.starred")}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l2.94 6.26 6.87.86-5.06 4.73 1.31 6.79L12 17.27l-6.06 3.37 1.31-6.79L2.19 9.12l6.87-.86L12 2z" />
      </svg>
    </span>
  );
}
