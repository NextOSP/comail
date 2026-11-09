import { IconButton } from "../ui/Button";

/**
 * Top-bar mail check: a plain status line plus the refresh button. The button
 * owns the only spinner, so a running check never shows two rotating rings.
 */
export function SyncControl({
  syncing,
  statusLabel,
  buttonLabel,
  onSync,
}: {
  syncing: boolean;
  statusLabel: string;
  buttonLabel: string;
  onSync: () => void;
}) {
  return (
    <>
      {syncing && (
        <span role="status" className="text-xs text-ink-muted">
          {statusLabel}
        </span>
      )}
      <IconButton icon="refresh" label={buttonLabel} busy={syncing} onClick={onSync} />
    </>
  );
}
