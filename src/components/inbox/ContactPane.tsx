import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ContactCard, ThreadSummary } from "../../ipc/types";
import { addressName, hueOf, initials, primaryCorrespondent, relativeTime } from "../../lib/format";
import { useContactCard } from "../../queries/hooks";

/** vCard TYPE values / labels the pane translates; others show as written. */
const KNOWN_KINDS = new Set(["home", "work", "cell", "mobile", "fax", "main", "other", "pager"]);

function kindLabel(kind: string | null, t: TFunction): string | null {
  if (!kind) return null;
  return kind
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (KNOWN_KINDS.has(k) ? t(`inbox:pane.kinds.${k}`) : k))
    .join(" · ");
}

/**
 * Superhuman-style contact pane pinned to the right of the inbox list. Shows
 * the correspondent for the highlighted thread (avatar, name, email) and their
 * recent conversations. The parent derives `thread` and `recent` so this
 * re-renders instantly on J/K / hover; the only query is the address-book card,
 * and it is skipped entirely until a CardDAV server is connected.
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
  const { data: card } = useContactCard(primary?.email ?? null);

  // No selection (or a thread with no participants) - mainly first-paint/defensive,
  // since InboxScreen keeps a valid cursor whenever the list is non-empty.
  if (!thread || !primary) {
    return (
      <aside className={`items-center justify-center ${className}`}>
        <p className="px-6 text-center text-sm text-ink-faint">{t("inbox:pane.empty")}</p>
      </aside>
    );
  }

  const hue = hueOf(primary.email);

  return (
    <aside className={`co-fade-in flex-col overflow-y-auto ${className}`}>
      {/* Identity */}
      <div className="flex flex-col items-center px-5 pt-9 pb-6">
        <span
          className="flex size-14 items-center justify-center rounded-full text-lg font-semibold"
          style={{
            background: `color-mix(in srgb, hsl(${hue} 45% 55%) 22%, var(--bg2))`,
            color: `hsl(${hue} 32% 42%)`,
          }}
        >
          {initials(primary)}
        </span>
        <div className="mt-3 max-w-full text-center">
          <div className="truncate text-md font-semibold text-ink">
            {card?.name ?? addressName(primary)}
          </div>
          <div className="mt-0.5 truncate text-sm text-ink-faint">{primary.email}</div>
          {card && (card.title || card.org) && (
            <div className="mt-0.5 truncate text-sm text-ink-muted">
              {[card.title, card.org].filter(Boolean).join(", ")}
            </div>
          )}
        </div>
      </div>

      {card && <CardDetails card={card} email={primary.email} />}

      {/* Recent conversations with this person */}
      <div className="border-t border-hairline px-4 py-4">
        <div className="mb-2 px-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
          {t("inbox:pane.recent")}
        </div>
        {recent.length === 0 ? (
          <p className="px-1 text-sm text-ink-faint">{t("inbox:pane.noRecent")}</p>
        ) : (
          <div className="flex flex-col">
            {recent.map((r) => (
              <button
                key={r.id}
                className="flex items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-bg2"
                onClick={() => onOpen(r.id)}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                  {r.subject || t("inbox:pane.noSubject")}
                </span>
                <span className="shrink-0 text-xs text-ink-faint tabular-nums">
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

/** Address-book extras: the person's other addresses and phone numbers. */
function CardDetails({ card, email }: { card: ContactCard; email: string }) {
  const { t } = useTranslation();
  const others = card.emails.filter((e) => e.email.toLowerCase() !== email.toLowerCase());
  if (others.length === 0 && card.phones.length === 0) return null;
  return (
    <div className="border-t border-hairline px-4 py-4">
      {others.length > 0 && (
        <CardSection
          label={t("inbox:pane.emails")}
          rows={others.map((e) => ({ value: e.email, kind: kindLabel(e.kind, t) }))}
        />
      )}
      {card.phones.length > 0 && (
        <CardSection
          label={t("inbox:pane.phones")}
          rows={card.phones.map((p) => ({ value: p.number, kind: kindLabel(p.kind, t) }))}
        />
      )}
      {card.addressBook && (
        <p className="mt-1 px-1 text-xs text-ink-faint">
          {t("inbox:pane.fromBook", { book: card.addressBook })}
        </p>
      )}
    </div>
  );
}

function CardSection({
  label,
  rows,
}: {
  label: string;
  rows: { value: string; kind: string | null }[];
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 px-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </div>
      {rows.map((r) => (
        <div key={r.value} className="flex items-baseline gap-2 px-1 py-0.5 text-sm">
          <span className="min-w-0 flex-1 truncate text-ink-muted select-text">{r.value}</span>
          {r.kind && <span className="shrink-0 text-xs text-ink-faint">{r.kind}</span>}
        </div>
      ))}
    </div>
  );
}
