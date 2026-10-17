import { memo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Label, ThreadSummary } from "../../ipc/types";
import { participantSummary, primaryCorrespondent, relativeTime } from "../../lib/format";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { Avatar } from "./Avatar";

/** Account marker shown on unified-inbox rows: edge bar color + name chip. */
export type AccountMeta = { color: string; name: string; email: string };

/** Hover/cursor row actions, mirroring the E / H / S shortcuts. */
export type QuickAction = "done" | "remind" | "star";

function ThreadRowImpl({
  thread,
  selected,
  checked,
  selectionMode,
  selfEmails,
  labelMap,
  account,
  onRowClick,
  onRowContextMenu,
  onQuickAction,
  onRowHover,
  onToggleCheck,
  onGutterDown,
  onRowDown,
  leaving,
  arriving,
  jumpHint,
  avatarUi = false,
  photos = false,
}: {
  thread: ThreadSummary;
  selected: boolean;
  checked: boolean;
  selectionMode: boolean;
  selfEmails: Set<string>;
  labelMap?: Map<number, Label>;
  /** When set, the row shows which account the thread belongs to. */
  account?: AccountMeta;
  onRowClick: (id: number, e: MouseEvent) => void;
  /** Right-click hook: opens the row context menu at the pointer. */
  onRowContextMenu?: (id: number, e: MouseEvent) => void;
  /** Hover quick actions; when provided, they replace the timestamp on the
   *  hovered / cursored row. */
  onQuickAction?: (id: number, action: QuickAction) => void;
  /** Hover-intent hook (null on leave); the list debounces and prefetches. */
  onRowHover?: (id: number | null) => void;
  onToggleCheck: (id: number) => void;
  /** When provided, press-and-drag in the gutter starts a range sweep. */
  onGutterDown?: (id: number, e: MouseEvent) => void;
  /** When provided, press-and-drag anywhere on the row starts a range sweep;
   *  a no-move press stays a click (opens the thread). */
  onRowDown?: (id: number, e: MouseEvent) => void;
  leaving?: boolean;
  /** Freshly arrived mail: plays the drop-in + accent wash. */
  arriving?: boolean;
  /** jump-to number shown (in place of the timestamp) while ⌘/Ctrl is held */
  jumpHint?: string;
  /** Avatar inbox UI: avatar, wide sender column, larger type. */
  avatarUi?: boolean;
  /** Avatar UI only: load Gravatar photos into the avatar. */
  photos?: boolean;
}) {
  const { t } = useTranslation();
  const unread = thread.unreadCount > 0;
  const correspondent = avatarUi ? primaryCorrespondent(thread.participants, selfEmails) : null;

  return (
    <div
      className={`co-row flex h-full cursor-default items-center gap-3 pr-6 pl-6 ${leaving ? "co-row-leaving" : arriving ? "co-row-arrive" : ""}`}
      data-selected={selected}
      data-checked={checked}
      onMouseDown={onRowDown ? (e) => onRowDown(thread.id, e) : undefined}
      onClick={(e) => onRowClick(thread.id, e)}
      onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(thread.id, e) : undefined}
      onMouseEnter={onRowHover ? () => onRowHover(thread.id) : undefined}
      onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
    >
      {/* gutter: checkbox (selection) / unread dot / star. self-stretch keeps the
          hit target the full row height so clicking/drag-selecting doesn't
          require landing on the tiny dot. */}
      <button
        className="flex w-5 shrink-0 items-center justify-center self-stretch"
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
            className={`flex size-4 items-center justify-center rounded border ${
              checked
                ? "border-accent bg-accent text-on-accent"
                : "border-hairline-strong text-transparent"
            }`}
          >
            <Icon name="check" size={11} />
          </span>
        ) : unread ? (
          <span className="size-2 rounded-full bg-info" />
        ) : thread.isStarred ? (
          <StarIcon />
        ) : (
          <span className="size-2" />
        )}
      </button>

      {avatarUi ? (
        <>
          {correspondent && (
            <Avatar address={correspondent} size={22} photo={photos} />
          )}
          <span
            className="w-48 shrink-0 truncate text-base font-medium text-ink"
          >
            {participantSummary(thread.participants, selfEmails)}
          </span>

          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-base">
            {thread.isStarred && <StarIcon />}
            <LabelChips labels={thread.labels} labelMap={labelMap} />
            <span className="shrink-0 truncate text-ink" style={{ maxWidth: "60%" }}>
              {thread.subject}
            </span>
            {thread.messageCount > 1 && (
              <span className="shrink-0 rounded border border-hairline bg-bg2 px-1 text-xs leading-[16px] text-ink-faint tabular-nums">
                {thread.messageCount}
              </span>
            )}
            {thread.hasAttachments && (
              <span className="co-row-meta">
                <PaperclipIcon />
              </span>
            )}
            <span className="ml-2 min-w-0 truncate text-ink-faint">{thread.snippet}</span>
          </span>
        </>
      ) : (
        <>
          <span
            className="w-[220px] shrink-0 truncate text-base font-medium text-ink"
          >
            {participantSummary(thread.participants, selfEmails)}
            {thread.messageCount > 1 && (
              <span className="ml-1.5 text-xs font-normal text-ink-faint">
                {thread.messageCount}
              </span>
            )}
          </span>

          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-base">
            <LabelChips labels={thread.labels} labelMap={labelMap} />
            <span className="min-w-0 truncate">
              <span className="text-ink">{thread.subject}</span>
              <span className="text-ink-faint">&ensp;{thread.snippet}</span>
            </span>
          </span>
        </>
      )}

      {account && (
        <span
          className="co-row-meta size-[7px] shrink-0 rounded-full"
          style={{ background: account.color }}
          title={`${account.name} · ${account.email}`}
        />
      )}

      {!avatarUi && thread.isStarred && (unread || checked || selectionMode) && (
        // Hidden with the timestamp while the quick-action star is showing.
        <span className={onQuickAction && !selectionMode ? "co-row-time" : "contents"}>
          <StarIcon />
        </span>
      )}
      {!avatarUi && thread.hasAttachments && (
        <span className="co-row-meta">
          <PaperclipIcon />
        </span>
      )}

      <span
        className={`flex shrink-0 justify-end text-right tabular-nums ${
          "w-[64px] text-sm uppercase"
        } text-ink-muted`}
      >
        {jumpHint ? (
          <kbd className="co-kbd">{jumpHint}</kbd>
        ) : (
          <span className={onQuickAction && !selectionMode ? "co-row-time" : undefined}>
            {relativeTime(thread.lastMessageAt)}
          </span>
        )}
        {onQuickAction && !selectionMode && !jumpHint && (
          <span className="co-row-actions items-center">
            <QuickButton
              icon="check"
              label={t("common:contextMenu.archive")}
              kbd="E"
              onClick={() => onQuickAction(thread.id, "done")}
            />
            <QuickButton
              icon="clock"
              label={t("common:contextMenu.snooze")}
              kbd="H"
              onClick={() => onQuickAction(thread.id, "remind")}
            />
            <QuickButton
              icon="star"
              label={thread.isStarred ? t("common:contextMenu.unstar") : t("common:contextMenu.star")}
              kbd="S"
              onClick={() => onQuickAction(thread.id, "star")}
              active={thread.isStarred}
            />
          </span>
        )}
      </span>
    </div>
  );
}

export const ThreadRow = memo(ThreadRowImpl);

function QuickButton({
  icon,
  label,
  kbd,
  onClick,
  active = false,
}: {
  icon: IconName;
  label: string;
  kbd: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <IconButton
      icon={icon}
      size="xs"
      label={label}
      title={`${label} (${kbd})`}
      filled={active}
      className={active ? "!text-star" : undefined}
      tabIndex={-1}
      // The row's mousedown starts a drag-sweep and its click opens the thread;
      // keep both away from the action buttons.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    />
  );
}

function PaperclipIcon() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 text-ink-faint" title={t("common:threadRow.hasAttachments")} aria-label={t("common:threadRow.attachment")}>
      <Icon name="paperclip" size={13} />
    </span>
  );
}

/** Superhuman-style label chips, placed before the subject. */
function LabelChips({ labels, labelMap }: { labels: number[]; labelMap?: Map<number, Label> }) {
  if (!labelMap || labels.length === 0) return null;
  return (
    <>
      {labels.slice(0, 3).map((id) => {
        const l = labelMap.get(id);
        if (!l) return null;
        return (
          <span
            key={id}
            className="max-w-[110px] shrink-0 truncate rounded-[4px] px-1.5 text-2xs leading-[17px] font-medium"
            style={{ background: `${l.color}24`, color: l.color }}
            title={l.name}
          >
            {l.name}
          </span>
        );
      })}
    </>
  );
}

function StarIcon() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 text-star" aria-label={t("common:threadRow.starred")}>
      <Icon name="star" size={13} filled />
    </span>
  );
}
