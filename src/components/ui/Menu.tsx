import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Floating menu/popover at a viewport point, clamped on-screen once measured.
 * Closes on outside press, scroll or resize (the anchor would move out from
 * under it). Lifted from the thread context menu so every menu behaves alike.
 */
export function Popover({
  x,
  y,
  onClose,
  children,
  className = "",
  minWidth = 190,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(x, window.innerWidth - width - pad);
    const top = Math.min(y, window.innerHeight - height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [x, y]);

  useEffect(() => {
    const close = () => closeRef.current();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        role="menu"
        className={`co-pop-in absolute rounded-card border border-hairline bg-bg1 p-1 shadow-elev-2 ${className}`}
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          minWidth,
          visibility: pos ? "visible" : "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function MenuItem({
  label,
  kbd,
  onClick,
  danger = false,
  active = false,
  icon,
}: {
  label: ReactNode;
  kbd?: string;
  onClick: () => void;
  danger?: boolean;
  /** Current choice (e.g. the selected signature). */
  active?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center justify-between gap-6 rounded-control px-2.5 py-1.5 text-left text-base hover:bg-bg2 ${
        danger ? "text-danger" : "text-ink"
      } ${active ? "font-medium" : ""}`}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2 truncate">
        {icon}
        {label}
      </span>
      {kbd && <kbd className="co-kbd">{kbd}</kbd>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-hairline" />;
}
