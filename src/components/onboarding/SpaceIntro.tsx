import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { prefersReducedMotion } from "../../lib/intro";
import { IntroMark } from "./IntroMark";

/**
 * First-run "into space" welcome - a cinematic, Arc-style intro in four acts:
 *
 *   1. Flythrough - ONE slow, dramatic starfield warp (the "cool animation").
 *   2. Arrival    - the warp decelerates to a calm drift; the Comail mark fades in.
 *   3. Story      - short lines fade through over the *calm* starfield (no re-zoom).
 *   4. Handoff    - the whole space scene fades out to reveal the onboarding on
 *                   its gradient backdrop (mounted underneath at reveal). Space is
 *                   only the intro; the add-account screen keeps the app gradient.
 *
 * Fills the viewport; on desktop it also maximizes the window (not OS fullscreen)
 * for the flythrough. Plays through uninterrupted (not skippable); reduced-motion aware.
 *
 * Deliberately GPU-cheap for WebKitGTK's software compositing (see themes/app.css):
 * only canvas fills + strokes - never a per-frame `filter: blur` or animated
 * blurred layer.
 *
 * Props:
 *   onReveal   - the story is done and the scene is fading; mount the card now.
 *   onFinished - fade-out complete; the intro can be unmounted.
 */

const STAR_COUNT = 520;

// Act 1-2: the single flythrough, in ms. Slow ramp, sustained warp, then decel
// to a calm drift that never re-accelerates.
const WARP_PEAK = 1.0; // gentle glide, not hyperspace
const ACCEL_END = 1400;
const FLYTHROUGH_END = 2400;
const DECEL_END = 3400;
const DRIFT = 0.04; // calm idle speed once we've arrived

// Act 2: the mark fades/scales in as we arrive.
const MARK_IN_START = 2900;
const MARK_IN_MS = 750;

// Act 3: the story lines. Unhurried, with generous cross-fades.
const LINES_START = 3800;
const LINE_MS = 1900;
const FADE_MS = 520; // fade in / fade out portion of each line

// Act 4: after the story, ONE more zoom (a warp burst) while the whole scene
// fades out to reveal the gradient onboarding.
const FINAL_PEAK = 3.2; // exit-warp intensity
const FINAL_WARP_MS = 950;
const FADE_DELAY = 260; // hold the zoom briefly before fading
const FADE_DUR = 720;

// Brand-tinted stars over a near-white majority. Space is dark in both themes.
const COLOR_ACCENT = "157,127,216"; // --accent (carbon purple)
const COLOR_INFO = "123,163,227"; // --info (blue)
const COLOR_INK = "236,233,226"; // near-white ink

const FALLBACK_LINES = [
  "Welcome.",
  "Email, at the speed of thought.",
  "Let's get you set up.",
];

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Maximize the desktop window for the intro (not OS fullscreen). It stays
 *  maximized afterwards. No-op (and safe) on web. */
async function maximizeAppWindow() {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().maximize();
  } catch {
    /* maximizing is a nicety, never fatal */
  }
}

const easeInCubic = (p: number) => p * p * p;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p);

function pickColor(): string {
  const r = Math.random();
  if (r < 0.16) return COLOR_ACCENT;
  if (r < 0.28) return COLOR_INFO;
  return COLOR_INK;
}

interface Star {
  x: number; // [-1, 1]
  y: number; // [-1, 1]
  z: number; // (0, 1], smaller = closer/streaming outward
  color: string;
}

function makeStar(): Star {
  return {
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: Math.random() * 0.9 + 0.1,
    color: pickColor(),
  };
}

/**
 * Starfield speed: ONE flythrough (accelerate -> sustain -> decelerate) that
 * eases down to a calm constant drift and never zooms again.
 */
function starSpeed(elapsed: number): number {
  if (elapsed < ACCEL_END) {
    return DRIFT + easeInCubic(elapsed / ACCEL_END) * WARP_PEAK;
  }
  if (elapsed < FLYTHROUGH_END) return DRIFT + WARP_PEAK;
  if (elapsed < DECEL_END) {
    const p = (elapsed - FLYTHROUGH_END) / (DECEL_END - FLYTHROUGH_END);
    return DRIFT + (1 - easeOutCubic(p)) * WARP_PEAK;
  }
  return DRIFT; // calm from here on - no per-line zoom
}

/** Trapezoidal opacity for a line active at [lineStart, lineStart + LINE_MS]. */
function lineOpacity(t: number): number {
  if (t < 0 || t > LINE_MS) return 0;
  if (t < FADE_MS) return t / FADE_MS;
  if (t > LINE_MS - FADE_MS) return (LINE_MS - t) / FADE_MS;
  return 1;
}

export function SpaceIntro({
  onReveal,
  onFinished,
}: {
  onReveal: () => void;
  onFinished: () => void;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  const [lineText, setLineText] = useState("");

  const raw = t("onboarding:intro.lines", { returnObjects: true });
  const lines = Array.isArray(raw) && raw.length ? (raw as string[]) : FALLBACK_LINES;
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      onReveal();
      return;
    }

    const N = linesRef.current.length;
    const settleAt = LINES_START + N * LINE_MS; // last line done -> exit warp

    void maximizeAppWindow();

    let finishTimer = 0;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      setFading(true); // fade the whole scene out to the gradient onboarding
      onReveal(); // mount the card + gradient backdrop underneath
      finishTimer = window.setTimeout(onFinished, FADE_DELAY + FADE_DUR);
    };

    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      cx = w / 2;
      cy = h / 2;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const stars = Array.from({ length: STAR_COUNT }, makeStar);

    // Opaque base so the full-screen canvas hides the app behind it.
    ctx.fillStyle = "#06060a";
    ctx.fillRect(0, 0, w, h);

    const drawStar = (s: Star, zPrev: number) => {
      const projX = w * 0.5;
      const projY = h * 0.5;
      const sx = cx + (s.x / s.z) * projX;
      const sy = cy + (s.y / s.z) * projY;
      if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) return;
      const px = cx + (s.x / zPrev) * projX;
      const py = cy + (s.y / zPrev) * projY;
      const depth = 1 - s.z; // 0 far .. ~1 near
      const alpha = Math.min(1, depth * 1.3 + 0.22);
      const width = Math.max(0.6, depth * 1.5 + 0.35);
      ctx.strokeStyle = `rgba(${s.color},${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    };

    // Reduced motion: skip the choreography - show the mark + last line, then settle.
    if (prefersReducedMotion()) {
      ctx.lineCap = "round";
      for (const s of stars) drawStar(s, s.z);
      if (markRef.current) markRef.current.style.opacity = "1";
      setLineText(linesRef.current[N - 1] ?? "");
      if (lineRef.current) lineRef.current.style.opacity = "1";
      const timer = window.setTimeout(settle, 700);
      return () => {
        window.clearTimeout(timer);
        window.clearTimeout(finishTimer);
        window.removeEventListener("resize", resize);
      };
    }

    const start = performance.now();
    let last = start;
    let raf = 0;
    let activeIdx = -2; // force first update

    const frame = (now: number) => {
      let dt = (now - last) / 1000;
      if (dt > 0.05) dt = 0.05; // clamp after a tab-switch stall
      last = now;
      const elapsed = now - start;

      // --- Act 2: the mark fades + scales in on arrival ---
      if (markRef.current && !done) {
        const m = easeOutCubic(clamp01((elapsed - MARK_IN_START) / MARK_IN_MS));
        markRef.current.style.opacity = String(m);
        markRef.current.style.transform = `scale(${0.9 + 0.1 * m})`;
      }

      // --- Act 3: which line, and its opacity ---
      const rel = elapsed - LINES_START;
      const idx = rel >= 0 ? Math.floor(rel / LINE_MS) : -1;
      if (idx !== activeIdx) {
        activeIdx = idx;
        setLineText(idx >= 0 && idx < N ? linesRef.current[idx] : "");
      }
      if (lineRef.current && !done) {
        const o = idx >= 0 && idx < N ? lineOpacity(rel - idx * LINE_MS) : 0;
        lineRef.current.style.opacity = String(o);
        lineRef.current.style.transform = `translateY(${(1 - o) * 10}px)`;
      }

      // --- Starfield: flythrough, calm drift, then ONE exit-warp zoom ---
      let speed = starSpeed(elapsed);
      if (elapsed >= settleAt) {
        const p = clamp01((elapsed - settleAt) / FINAL_WARP_MS);
        speed += easeInCubic(p) * FINAL_PEAK; // another zoom on the way out
      }

      // Full opaque clear each frame: crisp stars, no accumulated smear. The warp
      // streak comes from the per-frame line (prev -> current), not a fading trail.
      ctx.fillStyle = "#06060a";
      ctx.fillRect(0, 0, w, h);
      ctx.lineCap = "round";

      for (const s of stars) {
        const dz = speed * dt;
        const zPrev = s.z + dz;
        s.z -= dz;
        if (s.z <= 0.02) {
          s.x = Math.random() * 2 - 1;
          s.y = Math.random() * 2 - 1;
          s.z = 1;
          s.color = pickColor();
          continue;
        }
        drawStar(s, zPrev);
      }

      if (elapsed >= settleAt) settle();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(finishTimer);
      window.removeEventListener("resize", resize);
    };
    // Run once for the lifetime of the intro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="co-space-intro"
      style={{
        zIndex: 60,
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_DUR}ms ease ${FADE_DELAY}ms`,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <canvas ref={canvasRef} className="co-space-canvas" />
      <div className="co-intro-stage">
        <div ref={markRef} className="co-intro-mark" style={{ opacity: 0 }}>
          <IntroMark className="h-full w-full" />
        </div>
        <div ref={lineRef} className="co-intro-line" style={{ opacity: 0 }}>
          {lineText}
        </div>
      </div>
    </div>
  );
}
