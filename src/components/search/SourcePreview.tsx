import { useEffect, useState } from "react";
import { useThread } from "../../queries/hooks";
import { MessageCard } from "../thread/MessageCard";

// A lightweight, read-only thread preview shown as a modal over the search/Ask
// screen. Opening a source this way keeps SearchScreen (and the in-flight Ask)
// mounted, so glancing at a citation never cancels the answer. "Open full"
// hands off to the real conversation view.
export function SourcePreview({
  threadId,
  onClose,
  onOpenFull,
}: {
  threadId: number;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const { data, isLoading, isError } = useThread(threadId);
  // Expand/collapse overrides; messages default to expanded for a quick read.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Capture so it closes the modal before the search screen's own Esc handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const messages = data?.messages ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl bg-bg0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="co-hairline-b flex shrink-0 items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
            {data?.thread.subject || "Conversation"}
          </span>
          <button
            onClick={onOpenFull}
            className="co-chip !py-1 text-[12px] text-ink-muted hover:bg-bg2"
          >
            Open full
          </button>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-ink-faint hover:bg-bg2"
          >
            Esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isLoading ? (
            <p className="text-[13px] text-ink-faint">Loading…</p>
          ) : isError || !data ? (
            <p className="text-[13px] text-danger">Couldn't load this conversation.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m) => (
                <MessageCard
                  key={m.id}
                  message={m}
                  expanded={!collapsed[m.id]}
                  focused={false}
                  onToggle={() =>
                    setCollapsed((c) => ({ ...c, [m.id]: !c[m.id] }))
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
