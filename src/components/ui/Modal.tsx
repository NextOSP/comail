import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * The one modal shell: tinted overlay + centered card. Esc is handled by the
 * global esc-stack (keyboard/context.ts `escape`), not here, so nested
 * overlays always close in the right order. Dialogs whose open state is local
 * (not on that stack, e.g. an editor opened from Settings) pass `closeOnEsc`:
 * a capture-phase listener closes just this dialog before the global handler
 * would close its parent.
 */
export function Modal({
  onClose,
  children,
  width = 440,
  top = "18vh",
  center = false,
  sheet = false,
  className = "",
  style,
  labelledBy,
  closeOnEsc = false,
}: {
  onClose: () => void;
  children: ReactNode;
  width?: number | string;
  /** Distance from the top of the viewport (ignored when `center`). */
  top?: string;
  center?: boolean;
  /** Large panel variant (settings, onboarding): bigger radius. */
  sheet?: boolean;
  className?: string;
  style?: CSSProperties;
  labelledBy?: string;
  closeOnEsc?: boolean;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeOnEsc]);

  return (
    <div
      className={`co-overlay flex justify-center ${center ? "items-center" : "items-start"}`}
      style={center ? undefined : { paddingTop: top }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`co-pop-in max-w-[calc(100vw-32px)] border border-hairline bg-bg1 shadow-elev-2 ${
          sheet ? "rounded-sheet" : "rounded-card"
        } ${className}`}
        style={{ width, ...style }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
