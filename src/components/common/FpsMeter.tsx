import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "comail:fpsMeter";

/**
 * Dev FPS overlay. Toggle with Ctrl+Shift+F (persisted across reloads).
 *
 * Measures the actual presented frame rate via requestAnimationFrame - which
 * the compositor drives at the monitor's refresh rate - so it reflects the true
 * ceiling (e.g. ~120 on a 120Hz display when GPU compositing is working, ~60 if
 * the display/compositor is capped there). To keep the meter itself from being
 * the thing that drops frames, it writes straight to the DOM node and never
 * triggers a React re-render while running.
 */
export function FpsMeter() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const valueRef = useRef<HTMLSpanElement>(null);
  const minRef = useRef<HTMLSpanElement>(null);

  // Toggle with Ctrl+Shift+F. Capture phase so it beats the app's key handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        e.stopPropagation();
        setOn((v) => {
          const next = !v;
          try {
            localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
          } catch {
            /* ignore */
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let lastShown = -1;
    let min = Infinity;

    const loop = (now: number) => {
      frames++;
      const dt = now - windowStart;
      if (dt >= 250) {
        const fps = Math.round((frames * 1000) / dt);
        if (fps < min) {
          min = fps;
          if (minRef.current) minRef.current.textContent = `min ${min}`;
        }
        if (fps !== lastShown && valueRef.current) {
          valueRef.current.textContent = String(fps);
          valueRef.current.style.color =
            fps >= 100 ? "#22c55e" : fps >= 50 ? "#eab308" : "#ef4444";
          lastShown = fps;
        }
        frames = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  if (!on) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        right: 8,
        zIndex: 9999,
        pointerEvents: "none",
        font: "600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
        background: "rgba(0,0,0,0.62)",
        color: "#fff",
        padding: "5px 8px",
        borderRadius: 7,
        display: "flex",
        gap: 6,
        alignItems: "baseline",
        letterSpacing: "0.02em",
      }}
    >
      <span
        ref={valueRef}
        style={{
          color: "#22c55e",
          minWidth: 22,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        -
      </span>
      <span style={{ opacity: 0.6, fontSize: 10 }}>FPS</span>
      <span ref={minRef} style={{ opacity: 0.45, fontSize: 10 }}>min -</span>
    </div>
  );
}
