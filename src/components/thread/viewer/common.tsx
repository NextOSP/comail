import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FileKind } from "../../../lib/fileKind";
import { ViewerIcon, type ViewerIconName } from "./icons";

/** Colored file-type tile (same visual language as the message's attachment chips). */
export function FileBadge({ kind, size = 32 }: { kind: FileKind; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg font-bold tracking-tight text-white uppercase"
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.27)), backgroundColor: kind.color }}
      aria-hidden
    >
      {kind.label}
    </span>
  );
}

/** Square icon button used in the viewer chrome and floating pills. */
export function IconButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
  active,
  size = 32,
}: {
  icon: ViewerIconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`co-viewer-btn ${active ? "is-active" : ""}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <ViewerIcon name={icon} size={Math.round(size * 0.5)} />
    </button>
  );
}

/** Floating translucent control bar pinned to the bottom of the stage. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <div className="co-viewer-pill pointer-events-auto">{children}</div>
    </div>
  );
}

export function PillDivider() {
  return <span className="mx-1 h-5 w-px bg-hairline-strong" aria-hidden />;
}

/** Centered state card for loading / unsupported / failed previews. */
export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="co-pop-in flex max-w-[360px] flex-col items-center text-center">
        {icon}
        <div className="mt-4 text-[15px] font-semibold text-ink">{title}</div>
        {body && <div className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{body}</div>}
        {children && <div className="mt-5 flex gap-2">{children}</div>}
      </div>
    </div>
  );
}

/** `paper` = on a white document page, where the stage's light hairlines vanish. */
export function Spinner({ size = 22, paper = false }: { size?: number; paper?: boolean }) {
  return (
    <span
      className={`inline-block rounded-full border-2 ${paper ? "border-black/10 border-t-black/35" : "border-hairline-strong border-t-accent"}`}
      style={{ width: size, height: size, animation: "co-spin 0.8s linear infinite" }}
      aria-hidden
    />
  );
}

/** Skeleton "page" shown while a preview payload is on its way. */
export function LoadingPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-8" role="status" aria-label={t("thread:attachment.preview.loading")}>
      <div className="relative aspect-[8.5/11] h-[min(78%,720px)] max-w-full overflow-hidden rounded-md bg-bg1 p-10" style={{ boxShadow: "var(--elev-2)" }}>
        <div className="co-skeleton h-6 w-2/3 rounded" />
        <div className="co-skeleton mt-6 h-3 w-full rounded" />
        <div className="co-skeleton mt-3 h-3 w-11/12 rounded" />
        <div className="co-skeleton mt-3 h-3 w-4/5 rounded" />
        <div className="co-skeleton mt-8 h-32 w-full rounded" />
        <div className="co-skeleton mt-8 h-3 w-full rounded" />
        <div className="co-skeleton mt-3 h-3 w-3/5 rounded" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      </div>
    </div>
  );
}

/**
 * Window keydown handler active while the viewer is mounted. Runs in the
 * capture phase so viewer keys (arrows, +/-) win over the global command
 * registry; return true from the handler to claim the key. Never sees keys
 * typed into inputs (page-number field) except Escape/Enter.
 */
export function useViewerKeys(handler: (e: KeyboardEvent) => boolean) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (ref.current(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Size of an element, kept current with a ResizeObserver. Pass `remountKey`
 *  when the element only mounts later (e.g. after a loading state). */
export function useElementSize<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onSize: (w: number, h: number) => void,
  remountKey?: unknown,
) {
  const cb = useRef(onSize);
  cb.current = onSize;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => cb.current(el.clientWidth, el.clientHeight));
    ro.observe(el);
    cb.current(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, [ref, remountKey]);
}

/** Zoom percentage readout, e.g. "125%". */
export function ZoomLabel({ scale, onClick, title }: { scale: number; onClick?: () => void; title?: string }) {
  if (!onClick) {
    return <span className="min-w-[52px] px-1.5 text-center text-[12px] font-medium text-ink-muted tabular-nums">{Math.round(scale * 100)}%</span>;
  }
  return (
    <button
      type="button"
      className="co-viewer-btn !w-auto min-w-[52px] px-1.5 text-[12px] font-medium tabular-nums"
      style={{ height: 28 }}
      onClick={onClick}
      title={title}
    >
      {Math.round(scale * 100)}%
    </button>
  );
}

export interface ViewerActions {
  download: () => void;
  openExternally: () => void;
}

/** Provided by the viewer shell so renderers' dead-end states can offer a way out. */
export const ViewerActionsContext = createContext<ViewerActions | null>(null);

/** "Open in app" (primary) + "Download" buttons for unsupported/failed previews. */
export function ViewerFallbackActions() {
  const { t } = useTranslation();
  const actions = useContext(ViewerActionsContext);
  if (!actions) return null;
  return (
    <>
      <button type="button" className="co-viewer-action is-primary" onClick={actions.openExternally}>
        <ViewerIcon name="external" size={14} />
        {t("thread:attachment.preview.openExternally")}
      </button>
      <button type="button" className="co-viewer-action" onClick={actions.download}>
        <ViewerIcon name="download" size={14} />
        {t("thread:attachment.preview.download")}
      </button>
    </>
  );
}

export { ViewerIcon };
