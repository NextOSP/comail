import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useThread } from "../../queries/hooks";
import { MessageCard } from "../thread/MessageCard";
import { Button, IconButton } from "../ui/Button";
import { Modal } from "../ui/Modal";

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
  const { t } = useTranslation();
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
    // bg0 so the expanded (bg1) message cards stand off the sheet.
    <Modal
      onClose={onClose}
      center
      width={760}
      className="flex max-h-[82vh] flex-col overflow-hidden"
      style={{ background: "var(--bg0)" }}
    >
        <div className="co-hairline-b flex shrink-0 items-center gap-2 py-2.5 pr-2.5 pl-4">
          <span className="min-w-0 flex-1 truncate text-md font-medium text-ink">
            {data?.thread.subject || t("common:search.previewFallbackTitle")}
          </span>
          <Button size="sm" onClick={onOpenFull}>
            {t("common:search.openFull")}
          </Button>
          <IconButton icon="close" label={t("common:search.closePreview")} onClick={onClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isLoading ? (
            <p className="text-base text-ink-faint">{t("common:loading")}</p>
          ) : isError || !data ? (
            <p className="text-base text-danger">{t("common:search.previewFailed")}</p>
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
    </Modal>
  );
}
