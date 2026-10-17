import type { ReactNode } from "react";

/**
 * The one loading ring. Inherits the surrounding text color (via
 * `currentColor`), so it reads correctly on primary, ghost and AI buttons
 * without per-call color plumbing.
 */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`co-spinner inline-block size-3 shrink-0 rounded-full border-[1.5px] ${className}`}
      style={{ borderColor: "currentColor", borderTopColor: "transparent", opacity: 0.85 }}
    />
  );
}

/**
 * Loading label for action buttons: an inline spinner followed by the busy
 * text (e.g. "Checking…"). Keeps the button from silently swapping to a static
 * string with no motion.
 */
export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Spinner />
      {children}
    </span>
  );
}
