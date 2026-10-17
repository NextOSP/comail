import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { clampZoom, currentPageIndex, stepZoom } from "../../../lib/viewer";
import { EmptyState, IconButton, LoadingPage, Pill, PillDivider, Spinner, ViewerFallbackActions, ViewerIcon, ZoomLabel, useElementSize, useViewerKeys } from "./common";

type ZoomMode = "auto" | "width" | "page" | number;

const PAD = 32; // stage padding around the page column (px)
const GAP = 16; // vertical gap between pages
const AUTO_MAX_WIDTH = 920; // "auto" fits width but never wider than a comfortable reading column
const THUMB_W = 104;
const MAX_CANVAS_PIXELS = 16_000_000; // WebKit refuses (blank) canvases much past this

interface PageSize {
  w: number;
  h: number;
}

/**
 * Bundled-pdf.js viewer: pages are laid out at their real size up front and
 * rasterized lazily as they near the viewport (released again when far away),
 * so a 200-page deck opens as fast as a one-pager and doesn't hold gigabytes
 * of canvases. Zoom keeps the reading position; the thumbnail rail tracks the
 * current page.
 */
export function PdfViewer({ base64 }: { base64: string }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<ZoomMode>("auto");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [current, setCurrent] = useState(0);
  const [rail, setRail] = useState(() => window.innerWidth >= 1100);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Destroying the loading task tears down the document and its worker.
    const held: { task: { destroy(): Promise<unknown> } | null } = { task: null };
    setDoc(null);
    setSizes([]);
    setFailed(false);
    setCurrent(0);
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const task = pdfjs.getDocument({ data: bytes });
      held.task = task;
      const loaded = await task.promise;
      if (cancelled) return;
      // Page boxes only (no rasterizing) - cheap, and lets the scroll height
      // be right from the first frame.
      const all: PageSize[] = [];
      for (let n = 1; n <= loaded.numPages; n++) {
        const vp = (await loaded.getPage(n)).getViewport({ scale: 1 });
        all.push({ w: vp.width, h: vp.height });
      }
      if (cancelled) return;
      setSizes(all);
      setDoc(loaded);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      void held.task?.destroy();
    };
  }, [base64]);

  useElementSize(scrollerRef, (w, h) => setBox({ w, h }), doc);

  const maxW = useMemo(() => Math.max(1, ...sizes.map((s) => s.w)), [sizes]);
  const firstH = sizes[0]?.h ?? 1;
  const scale = useMemo(() => {
    const availW = Math.max(120, box.w - PAD * 2);
    if (typeof mode === "number") return mode;
    if (mode === "page") return clampZoom(Math.min(availW / maxW, Math.max(80, box.h - PAD * 2) / firstH));
    if (mode === "width") return clampZoom(availW / maxW);
    return clampZoom(Math.min(availW, AUTO_MAX_WIDTH) / maxW);
  }, [mode, box, maxW, firstH]);

  // Keep the reading position when the scale changes.
  const prevScale = useRef(scale);
  const measured = useRef(false);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || prevScale.current === scale) return;
    // The first real measurement isn't a zoom - just adopt it (no jump).
    if (!measured.current) {
      measured.current = box.w > 0;
      prevScale.current = scale;
      return;
    }
    const k = scale / prevScale.current;
    const line = el.clientHeight * 0.4;
    el.scrollTop = (el.scrollTop + line - PAD) * k + PAD - line;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    prevScale.current = scale;
  }, [scale]);

  // While a programmatic smooth scroll is in flight, its target is the
  // current page: scroll events from the animation must not pull it back, and
  // repeated J presses keep counting from the target.
  const nav = useRef<{ target: number; until: number } | null>(null);
  const navigating = () => nav.current != null && Date.now() < nav.current.until;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el || navigating()) return;
    const tops = pageRefs.current.map((p) => p?.offsetTop ?? 0);
    setCurrent(currentPageIndex(tops, el.scrollTop, el.clientHeight));
  };

  const goTo = (index: number) => {
    const i = Math.max(0, Math.min(sizes.length - 1, index));
    nav.current = { target: i, until: Date.now() + 700 };
    const el = pageRefs.current[i];
    if (el && scrollerRef.current) scrollerRef.current.scrollTo({ top: el.offsetTop - PAD / 2, behavior: "smooth" });
    setCurrent(i);
  };

  const zoom = (dir: 1 | -1) => setMode(stepZoom(scale, dir));

  // Pinch / ctrl-wheel zoom. Non-passive so the webview doesn't page-zoom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setMode((m) => {
        const base = typeof m === "number" ? m : prevScale.current;
        return clampZoom(base * Math.exp(-e.deltaY * 0.01));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc]);

  useViewerKeys((e) => {
    if (!doc || e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case "+":
      case "=":
        zoom(1);
        return true;
      case "-":
      case "_":
        zoom(-1);
        return true;
      case "0":
        setMode("auto");
        return true;
      case "PageDown":
      case "j":
        goTo((navigating() ? nav.current!.target : current) + 1);
        return true;
      case "PageUp":
      case "k":
        goTo((navigating() ? nav.current!.target : current) - 1);
        return true;
      case "Home":
        goTo(0);
        return true;
      case "End":
        goTo(sizes.length - 1);
        return true;
      case "t":
        setRail((r) => !r);
        return true;
    }
    return false;
  });

  if (failed) {
    return (
      <EmptyState
        icon={<span className="text-danger"><ViewerIcon name="alert" size={40} /></span>}
        title={t("thread:attachment.preview.pdfFailed")}
        body={t("thread:attachment.preview.pdfFailedBody")}
      >
        <ViewerFallbackActions />
      </EmptyState>
    );
  }
  if (!doc) return <LoadingPage />;

  const multi = sizes.length > 1;

  return (
    <div className="flex h-full min-h-0">
      {multi && rail && (
        <ThumbRail doc={doc} sizes={sizes} current={current} onPick={goTo} />
      )}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollerRef}
          className="co-viewer-scroll h-full overflow-auto"
          onScroll={onScroll}
          data-testid="pdf-scroller"
        >
          <div className="flex min-w-fit flex-col items-center" style={{ padding: `${PAD}px ${PAD}px ${PAD + 64}px`, gap: GAP }}>
            {sizes.map((s, i) => (
              <div key={i} ref={(el) => void (pageRefs.current[i] = el)}>
                <PdfPage doc={doc} n={i + 1} size={s} scale={scale} rootRef={scrollerRef} />
              </div>
            ))}
          </div>
        </div>
        <Pill>
          {multi && (
            <>
              <IconButton
                icon="sidebar"
                label={t("thread:attachment.preview.thumbnails")}
                shortcut="T"
                active={rail}
                onClick={() => setRail((r) => !r)}
                size={28}
              />
              <PillDivider />
              <IconButton icon="chevronUp" label={t("thread:attachment.preview.prevPage")} shortcut="K" disabled={current === 0} onClick={() => goTo(current - 1)} size={28} />
              <PageInput current={current} total={sizes.length} onGo={goTo} />
              <IconButton icon="chevronDown" label={t("thread:attachment.preview.nextPage")} shortcut="J" disabled={current >= sizes.length - 1} onClick={() => goTo(current + 1)} size={28} />
              <PillDivider />
            </>
          )}
          <IconButton icon="minus" label={t("thread:attachment.preview.zoomOut")} shortcut="−" onClick={() => zoom(-1)} size={28} />
          <ZoomLabel scale={scale} onClick={() => setMode("auto")} title={t("thread:attachment.preview.resetZoom")} />
          <IconButton icon="plus" label={t("thread:attachment.preview.zoomIn")} shortcut="+" onClick={() => zoom(1)} size={28} />
          <PillDivider />
          {mode === "page" ? (
            <IconButton icon="fitWidth" label={t("thread:attachment.preview.fitWidth")} onClick={() => setMode("width")} size={28} />
          ) : (
            <IconButton icon="fitPage" label={t("thread:attachment.preview.fitPage")} onClick={() => setMode("page")} size={28} />
          )}
        </Pill>
      </div>
    </div>
  );
}

function PageInput({ current, total, onGo }: { current: number; total: number; onGo: (i: number) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft != null) {
      const n = parseInt(draft, 10);
      if (Number.isFinite(n)) onGo(n - 1);
    }
    setDraft(null);
  };
  return (
    <span className="flex items-center gap-1 px-1 text-[12px] text-ink-muted tabular-nums">
      <input
        className="co-viewer-input w-9 text-center"
        value={draft ?? String(current + 1)}
        aria-label={t("thread:attachment.preview.pageNumber")}
        inputMode="numeric"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
      />
      <span>/ {total}</span>
    </span>
  );
}

function ThumbRail({
  doc,
  sizes,
  current,
  onPick,
}: {
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  current: number;
  onPick: (i: number) => void;
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    itemRefs.current[current]?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <div
      ref={railRef}
      className="co-viewer-scroll co-hairline-r flex w-[148px] shrink-0 flex-col items-center gap-3 overflow-y-auto py-4"
      aria-label={t("thread:attachment.preview.thumbnails")}
    >
      {sizes.map((s, i) => (
        <button
          key={i}
          ref={(el) => void (itemRefs.current[i] = el)}
          type="button"
          className="group flex cursor-pointer flex-col items-center gap-1.5 focus:outline-none"
          onClick={() => onPick(i)}
          aria-current={i === current ? "page" : undefined}
          aria-label={t("thread:attachment.preview.goToPage", { n: i + 1 })}
        >
          <span
            className={`block rounded-[3px] ring-2 transition-shadow ${
              i === current ? "ring-accent" : "ring-transparent group-hover:ring-hairline-strong group-focus-visible:ring-accent/60"
            }`}
          >
            <PdfPage doc={doc} n={i + 1} size={s} scale={THUMB_W / s.w} rootRef={railRef} thumb />
          </span>
          <span className={`text-[11px] tabular-nums ${i === current ? "font-semibold text-ink" : "text-ink-faint"}`}>{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

/** One page box; rasterizes when near the viewport, debounced across zoom steps. */
function PdfPage({
  doc,
  n,
  size,
  scale,
  rootRef,
  thumb = false,
}: {
  doc: PDFDocumentProxy;
  n: number;
  size: PageSize;
  scale: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  thumb?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [renderScale, setRenderScale] = useState(scale);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: rootRef.current,
      rootMargin: "150% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [rootRef]);

  // Re-rasterize only once a zoom gesture settles; meanwhile the previous
  // bitmap is stretched by CSS so the page never goes blank.
  useEffect(() => {
    if (!rendered) {
      setRenderScale(scale);
      return;
    }
    const id = window.setTimeout(() => setRenderScale(scale), 160);
    return () => window.clearTimeout(id);
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!near) {
      // Far off-screen: drop the bitmap so long documents stay light.
      for (const c of host.querySelectorAll("canvas")) {
        c.width = 0;
        c.height = 0;
        c.remove();
      }
      setRendered(false);
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(n);
      if (cancelled) return;
      let dpr = window.devicePixelRatio || 1;
      const cssW = size.w * renderScale;
      const cssH = size.h * renderScale;
      if (cssW * cssH * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH));
      const viewport = page.getViewport({ scale: renderScale * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "absolute inset-0 h-full w-full";
      task = page.render({ canvas, viewport });
      await task.promise;
      if (cancelled) return;
      for (const old of host.querySelectorAll("canvas")) {
        old.width = 0;
        old.height = 0;
        old.remove();
      }
      host.appendChild(canvas);
      setRendered(true);
    })().catch(() => {
      /* cancelled render or a broken page - leave the blank sheet */
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n, near, renderScale, size.w, size.h]);

  return (
    <div
      ref={hostRef}
      className={`relative overflow-hidden bg-white ${thumb ? "rounded-[3px]" : "rounded-[2px]"}`}
      style={{
        width: Math.round(size.w * scale),
        height: Math.round(size.h * scale),
        boxShadow: thumb ? "0 1px 3px rgb(0 0 0 / 0.4)" : "0 2px 6px rgb(0 0 0 / 0.35), 0 12px 40px rgb(0 0 0 / 0.35)",
      }}
    >
      {!rendered && !thumb && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={18} paper />
        </div>
      )}
    </div>
  );
}
