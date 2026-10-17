import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { centered, clampPan, fitScale, stepZoom, zoomAt, type View } from "../../../lib/viewer";
import { IconButton, Pill, PillDivider, ZoomLabel, useElementSize, useViewerKeys } from "./common";

const MARGIN = 40; // breathing room around a fitted image

/**
 * Zoomable image stage: fits by default, pinch / ctrl-wheel zooms around the
 * cursor, drag or scroll pans once zoomed, double-click toggles fit <-> 2x.
 * Transparent images sit on a checkerboard so their edges are visible.
 */
export function ImageViewer({ src }: { src: string }) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [fitted, setFitted] = useState(true);
  const [animate, setAnimate] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useElementSize(boxRef, (w, h) => setBox({ w, h }));

  const fit = natural ? fitScale(natural.w, natural.h, box.w - MARGIN * 2, box.h - MARGIN * 2) : 1;

  // While "fitted", follow window resizes.
  useEffect(() => {
    if (natural && fitted) setView(centered(fit, natural.w, natural.h, box.w, box.h));
  }, [natural, fitted, fit, box.w, box.h]);

  const apply = (next: View, smooth: boolean) => {
    if (!natural) return;
    setAnimate(smooth);
    setFitted(false);
    setView(clampPan(next, natural.w, natural.h, box.w, box.h));
  };
  const zoomTo = (scale: number, px = box.w / 2, py = box.h / 2, smooth = true) => apply(zoomAt(view, scale, px, py), smooth);
  const toFit = () => {
    setAnimate(true);
    setFitted(true);
  };

  const larger = natural != null && (natural.w * view.scale > box.w + 1 || natural.h * view.scale > box.h + 1);

  // Non-passive wheel: ctrl/⌘ (and trackpad pinch) zooms; plain wheel pans.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !natural) return;
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setFitted(false);
        setAnimate(false);
        setView((v) =>
          clampPan(zoomAt(v, v.scale * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top), natural.w, natural.h, r.width, r.height),
        );
      } else {
        e.preventDefault();
        setAnimate(false);
        setView((v) => clampPan({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }, natural.w, natural.h, r.width, r.height));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [natural]);

  useViewerKeys((e) => {
    if (!natural || e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case "+":
      case "=":
        zoomTo(stepZoom(view.scale, 1));
        return true;
      case "-":
      case "_":
        zoomTo(stepZoom(view.scale, -1));
        return true;
      case "0":
        toFit();
        return true;
      case "1":
        zoomTo(1);
        return true;
    }
    return false;
  });

  return (
    <div className="relative h-full">
      <div
        ref={boxRef}
        className={`absolute inset-0 overflow-hidden ${larger ? (dragging ? "cursor-grabbing" : "cursor-grab") : fitted ? "cursor-zoom-in" : "cursor-zoom-out"}`}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (fitted) zoomTo(Math.max(1, fit * 2), e.clientX - r.left, e.clientY - r.top);
          else toFit();
        }}
        onPointerDown={(e) => {
          if (!larger || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !natural) return;
          setAnimate(false);
          setView(clampPan({ scale: view.scale, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }, natural.w, natural.h, box.w, box.h));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          className="co-checker absolute top-0 left-0 max-w-none origin-top-left select-none"
          style={{
            width: natural?.w,
            height: natural?.h,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: animate ? "transform 160ms cubic-bezier(0.2, 0, 0, 1)" : undefined,
            imageRendering: view.scale >= 3 ? "pixelated" : undefined,
            visibility: natural ? "visible" : "hidden",
            boxShadow: "0 12px 48px rgb(0 0 0 / 0.45)",
          }}
        />
      </div>
      {natural && (
        <Pill>
          <IconButton icon="minus" label={t("thread:attachment.preview.zoomOut")} shortcut="−" onClick={() => zoomTo(stepZoom(view.scale, -1))} size={28} />
          <ZoomLabel scale={view.scale} />
          <IconButton icon="plus" label={t("thread:attachment.preview.zoomIn")} shortcut="+" onClick={() => zoomTo(stepZoom(view.scale, 1))} size={28} />
          <PillDivider />
          <IconButton icon="maximize" label={t("thread:attachment.preview.fit")} shortcut="0" active={fitted} onClick={toFit} size={28} />
          <button
            type="button"
            className={`co-viewer-btn !w-auto px-2 text-[12px] font-medium ${!fitted && Math.abs(view.scale - 1) < 0.001 ? "is-active" : ""}`}
            style={{ height: 28 }}
            onClick={() => zoomTo(1)}
            title={`${t("thread:attachment.preview.actualSize")} (1)`}
          >
            1:1
          </button>
          <PillDivider />
          <span className="px-1.5 text-[11.5px] text-ink-faint tabular-nums">
            {t("thread:attachment.preview.dimensions", { w: natural.w, h: natural.h })}
          </span>
        </Pill>
      )}
    </div>
  );
}
