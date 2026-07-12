import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../../ipc/types";
import { addressName, hueOf, initials, primaryCorrespondent, relativeTime } from "../../lib/format";

/**
 * Superhuman-style contact pane pinned to the right of the inbox list. Shows
 * the correspondent for the highlighted thread (avatar, name, email) and their
 * recent conversations. Purely presentational — the parent derives `thread` and
 * `recent` so this re-renders instantly on J/K / hover without extra queries.
 */
export function ContactPane({
  thread,
  recent,
  selfEmails,
  onOpen,
  className = "",
}: {
  thread: ThreadSummary | null;
  recent: ThreadSummary[];
  selfEmails: Set<string>;
  onOpen: (id: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();

  const primary = thread ? primaryCorrespondent(thread.participants, selfEmails) : null;

  // No selection (or a thread with no participants) — mainly first-paint/defensive,
  // since InboxScreen keeps a valid cursor whenever the list is non-empty.
  if (!thread || !primary) {
    return (
      <aside className={`items-center justify-center ${className}`}>
        <p className="px-6 text-center text-[12.5px] text-ink-faint">{t("inbox:pane.empty")}</p>
      </aside>
    );
  }

  const hue = hueOf(primary.email);

  return (
    <aside className={`co-fade-in flex-col overflow-y-auto ${className}`}>
      {/* Identity */}
      <div className="flex flex-col items-center px-5 pt-9 pb-6">
        <span
          className="flex size-14 items-center justify-center rounded-full text-[18px] font-semibold"
          style={{
            background: `color-mix(in srgb, hsl(${hue} 45% 55%) 22%, var(--bg2))`,
            color: `hsl(${hue} 32% 42%)`,
          }}
        >
          {initials(primary)}
        </span>
        <div className="mt-3 max-w-full text-center">
          <div className="truncate text-[14.5px] font-semibold text-ink">{addressName(primary)}</div>
          <div className="mt-0.5 truncate text-[12px] text-ink-faint">{primary.email}</div>
        </div>
      </div>

      {/* Recent conversations with this person */}
      <div className="border-t border-hairline px-4 py-4">
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
          {t("inbox:pane.recent")}
        </div>
        {recent.length === 0 ? (
          <p className="px-1 text-[12px] text-ink-faint">{t("inbox:pane.noRecent")}</p>
        ) : (
          <div className="flex flex-col">
            {recent.map((r) => (
              <button
                key={r.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
                onClick={() => onOpen(r.id)}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
                  {r.subject || t("inbox:pane.noSubject")}
                </span>
                <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                  {relativeTime(r.lastMessageAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
