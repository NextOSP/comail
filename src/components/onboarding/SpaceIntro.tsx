import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { prefersReducedMotion } from "../../lib/intro";
import { playIntroMusic } from "../../lib/sound";
import { IntroMark } from "./IntroMark";

/**
 * First-run welcome - a vintage film-reel intro (the component keeps its
 * historical SpaceIntro name to avoid churn), scored by a 20s soundtrack
 * (public/sounds/intro.wav) whose gain envelope is choreographed to the same
 * clock as the visuals (see INTRO_ENVELOPE in lib/sound.ts):
 *
 *   0. Blackout - the screen dims darker and darker to pure black while the
 *      music creeps in from silence. A borderless window over the black
 *      cinema-backdrop window (below): the whole screen reads as one dark
 *      surface.
 *   1. Lamp - a warm projector-lamp glow swells alone in the dark; film grain
 *      and a soft flicker come up with it. The reel has started.
 *   2. Story - the lines type out letter by letter (typewriter), while real
 *      public-domain photographs of computing history flip through above
 *      them like prints tossed on a table: ENIAC (first computer), the
 *      IBM 704 (ran the first OS), WorldWideWeb (first browser), and the
 *      ARPANET map (the network that carried the first email). Sources in
 *      public/intro/CREDITS.md.
 *   3. Title - the wordmark simply arrives: a long serif fade with a barely
 *      perceptible settle. Then the scene HOLDS: a translucent arrow button
 *      fades in; click through, or the show rolls on by itself after a beat.
 *   4. Handoff - the scene and the score fade out together to reveal the
 *      onboarding on its gradient backdrop (mounted underneath at reveal).
 *
 * Deliberately GPU-cheap for WebKitGTK's software compositing (see
 * themes/app.css): canvas fills only - never a per-frame `filter: blur` or
 * animated blurred layer. The grain is a pre-rendered noise tile jittered
 * per frame; the photos animate with plain transforms.
 *
 * Props:
 *   onReveal   - the story is done and the scene is fading; mount the card now.
 *   onFinished - fade-out complete; the intro can be unmounted.
 */

// Act 0: fade the screen to pure black before anything plays. Slow on
// purpose - the room dims like a theater, never a hard cut. Timings below
// are tuned against the 20s score.
const BLACKOUT_MS = 2400;

// Act 1: the lamp - a glow swelling in the black, breathing, then settling
// low behind the photographs. Timed against the 30s score.
const GLOW_START = BLACKOUT_MS;
const GLOW_IN_MS = 1600;
const GLOW_SETTLE_START = 5200; // eases down as the story begins
const GLOW_SETTLE_MS = 1600;
const GLOW_LINGER = 0.35; // fraction kept as the projector keeps running

// Act 2: the story. Each line types out letter by letter, holds, and fades.
// The typeface itself evolves with the story - the history of written email:
// a typewriter, then print-era Times, then the web's Comic Sans; the title
// answers in the app's own modern font.
const LINES_START = 5200;
const LINE_MS = 3800;
const CHAR_MS = 42; // typing speed
const LINE_OUT_MS = 450; // fade at the end of each line
const CARET_BLINK_MS = 420;
const LINE_FONTS = [
  '"American Typewriter", "Courier Prime", "Courier New", monospace',
  '"Times New Roman", Times, serif',
  '"Comic Sans MS", "Comic Sans", cursive',
];

// The photographs: computing history in chronological order, flipping
// through like prints tossed on a table - an accelerating montage from the
// first computer to the first browser. Sources: public/intro/CREDITS.md.
const PHOTOS = [
  "/intro/eniac.jpg", // 1946: the first computer
  "/intro/ibm704.jpg", // 1956: ran the first operating system
  "/intro/mouse.jpg", // 1964: the first mouse
  "/intro/asr33.jpg", // 1971: the terminal of the first email
  "/intro/modem.jpg", // the dial-up era
  "/intro/ibmpc.jpg", // 1981: the personal computer
  "/intro/webserver.jpg", // 1990: the first web server
  "/intro/worldwideweb.png", // 1991: the first web browser
  "/intro/office2000.jpg", // 2000: the office desktop era
  "/intro/blackberry.jpg", // the 2000s: email in a pocket qwerty
  "/intro/iphone.jpg", // 2007: the smartphone era
];
const PHOTOS_START = 5200;
// The beats accelerate to fit the whole history inside the three lines.
const PHOTO_MS = Math.floor((LINE_MS * 3) / PHOTOS.length);
const PHOTO_IN_MS = 300;
const PHOTO_OUT_MS = 280;

// Act 3: the title card. Restraint is the design: the wordmark simply
// arrives - a long fade with a barely-perceptible settle - and stays up
// through the exit. Once it has landed, the continue button fades in; the
// user can click through, or the show rolls on by itself after a beat (a
// held screen with no obvious exit reads as "stuck").
const TITLE_FADE_MS = 1800;
const CTA_IN_START = 1800; // after the title starts
const CTA_IN_MS = 700;
const AUTO_EXIT_AFTER_CTA = 6000; // self-advance if the user never clicks

// Act 4: the handoff fade, in step with the music's release.
const FADE_DELAY = 400;
const FADE_DUR = 2100;
const EXIT_MUSIC_FADE_S = 2.2;

// The color grade: a full-screen gradient of drifting light fields - indigo,
// magenta, and blue breathing into each other over a deep violet base, with
// grain and vignette keeping the film texture.
const FIELDS = [
  { color: "122,92,255", ox: 0.09, oy: 0.12, ax: 0.32, ay: 0.22 },
  { color: "214,92,196", ox: 0.06, oy: 0.08, ax: 0.36, ay: 0.26 },
  { color: "92,158,255", ox: 0.08, oy: 0.05, ax: 0.3, ay: 0.24 },
] as const;
const FIELD_ALPHA = 0.26; // per-field peak, additive: covers the screen
const BASE = "#100e20"; // deep violet-black

const FALLBACK_LINES = [
  "Email hasn't changed in twenty years.",
  "Today, it does.",
  "Fast. Calm. Simply beautiful.",
];
const FALLBACK_TITLE = "Comail";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const CINEMA_LABEL = "cinema-backdrop";

/** Cinema mode, the Arc way: the app window stays a normal floating window
 *  (no fullscreen, no resize), while a borderless black backdrop window covers
 *  the screen behind it, so nothing outside the app breaks the dark. No-op
 *  (and safe) on web. */
async function openCinemaBackdrop() {
  if (!isTauri) return;
  try {
    const { currentMonitor, getCurrentWindow } = await import("@tauri-apps/api/window");
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    if (await WebviewWindow.getByLabel(CINEMA_LABEL)) return; // dev double-mount
    const monitor = await currentMonitor();
    if (!monitor) return;
    const scale = monitor.scaleFactor || 1;
    const backdrop = new WebviewWindow(CINEMA_LABEL, {
      url: "backdrop.html",
      x: monitor.position.x / scale,
      y: monitor.position.y / scale,
      width: monitor.size.width / scale,
      height: monitor.size.height / scale,
      decorations: false,
      shadow: false,
      resizable: false,
      focus: false,
      skipTaskbar: true,
      // Transparent window; backdrop.html's black sheet does the fading
      // (in at the start, out on "cinema:fade-out").
      transparent: true,
      // Float above normal windows so no other app can sandwich itself
      // between the backdrop and the (also floated, focused) app window.
      alwaysOnTop: true,
    });
    // The backdrop is created above the app window; bring the app back to front.
    void backdrop.once("tauri://created", () => {
      void getCurrentWindow().setFocus();
    });
  } catch {
    /* the backdrop is a nicety, never fatal */
  }
}

/** Tell the backdrop's black sheet to fade away (it listens for this event);
 *  the window itself is closed at unmount, after the fade has finished. */
async function fadeCinemaBackdrop() {
  if (!isTauri) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("cinema:fade-out");
  } catch {
    /* worst case it stays black until the close */
  }
}

/** Fade and close the backdrop. The Rust command is the authoritative
 *  teardown (it evals the fade into the backdrop and closes the window
 *  itself, so no webview capability or global-API wiring can break it); the
 *  JS handle close stays as a fallback for older binaries. */
async function closeCinemaBackdrop(delayMs?: number, fadeMs?: number) {
  if (!isTauri) return;
  try {
    await call("cinema_close", { delayMs: delayMs ?? null, fadeMs: fadeMs ?? null });
    return;
  } catch {
    /* fall through to the JS close */
  }
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const backdrop = await WebviewWindow.getByLabel(CINEMA_LABEL);
    await backdrop?.close();
  } catch {
    /* already gone */
  }
}

/** The intro window is borderless: over the black backdrop a chromeless dark
 *  window is invisible, so the show seems to play on the screen itself. The
 *  titlebar comes back at the handoff. No-op (and safe) on web. */
async function setAppDecorations(on: boolean) {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setDecorations(on);
  } catch {
    /* chrome is cosmetic here, never fatal */
  }
}

/** Cold start: the main window launches hidden (tauri.conf `visible: false`)
 *  so the user never sees a flash of unstyled white app. Dress the window
 *  while it is still invisible - chromeless, centered, the intro painted
 *  black via `paintBlackNow` - and only then reveal it. On a preview run
 *  (window already visible) just dress it in place; the theater dim-down
 *  covers that transition. No-op on web. */
async function prepareCinemaWindow(paintBlackNow: () => void): Promise<void> {
  if (!isTauri) return;
  // Every step individually best-effort, and the reveal at the end runs NO
  // MATTER WHAT failed before it: a hidden window that never shows is the
  // worst possible outcome. (Rust holds a second forced-show watchdog.)
  let win;
  try {
    win = (await import("@tauri-apps/api/window")).getCurrentWindow();
  } catch {
    return;
  }
  let hidden = false;
  try {
    hidden = !(await win.isVisible());
  } catch {
    /* assume visible */
  }
  if (hidden) paintBlackNow();
  try {
    await win.setDecorations(false);
  } catch {
    /* cosmetic */
  }
  try {
    await win.center();
  } catch {
    /* cosmetic */
  }
  try {
    // Float with the backdrop for the show, so nothing can slot in between;
    // released again when the darkness lifts.
    await win.setAlwaysOnTop(true);
  } catch {
    /* cosmetic */
  }
  try {
    if (hidden) {
      // Let the black commit before the reveal. A timer, not an animation
      // frame: hidden webviews may not tick rAF at all.
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    await win.show(); // no-op when already visible
    await win.setFocus();
  } catch {
    /* the Rust watchdog will force the show */
  }
}

/** Release the show's always-on-top float (see prepareCinemaWindow). */
async function releaseCinemaFloat(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setAlwaysOnTop(false);
  } catch {
    /* cosmetic, never fatal */
  }
}

const easeInCubic = (p: number) => p * p * p;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p);

export function SpaceIntro({
  onReveal,
  onFinished,
}: {
  onReveal: () => void;
  onFinished: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  // The click handler is wired inside the effect (it needs its clock/state);
  // the button just calls whatever is current.
  const beginExitRef = useRef<() => void>(() => {});
  const [blackIn, setBlackIn] = useState(false);
  // Cold start from a hidden window: skip the dim-down and open on black.
  const [instantBlack, setInstantBlack] = useState(false);
  const [fading, setFading] = useState(false);

  const raw = t("onboarding:intro.lines", { returnObjects: true });
  const lines = Array.isArray(raw) && raw.length ? (raw as string[]) : FALLBACK_LINES;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const title = t("onboarding:intro.title", FALLBACK_TITLE);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      onReveal();
      return;
    }

    const N = linesRef.current.length;
    const titleStart = LINES_START + N * LINE_MS; // story done -> title card
    const ctaAt = titleStart + CTA_IN_START; // title landed -> continue button

    void openCinemaBackdrop();
    void prepareCinemaWindow(() => {
      setInstantBlack(true);
      setBlackIn(true);
    });

    // Warm the photo cache so each flip lands on a decoded image.
    for (const src of PHOTOS) {
      const im = new Image();
      im.src = src;
    }

    // The score starts with the blackout (from the first frame, below): its
    // envelope creeps up from silence while the screen darkens.
    let stopMusic: ((fadeS?: number) => void) | null = null;

    let finishTimer = 0;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      setFading(true); // fade the whole scene out to the gradient onboarding
      // Also write the fade straight onto the element: the handoff must not
      // depend on a React re-render actually happening.
      if (rootRef.current) {
        rootRef.current.style.transition = `opacity ${FADE_DUR}ms ease ${FADE_DELAY}ms`;
        rootRef.current.style.opacity = "0";
      }
      // Bring the window chrome back while the scene still covers the window,
      // so the titlebar's return is masked by the fade, and let the black
      // desktop backdrop dissolve with it.
      void setAppDecorations(true);
      void releaseCinemaFloat();
      void fadeCinemaBackdrop();
      // Rust fades the backdrop's black sheet in step with the scene fade
      // and closes the window after it (the delay runs backend-side, so even
      // an unmount race can't cancel it); the event-driven fade above and
      // the unmount cleanup remain as fallback layers.
      void closeCinemaBackdrop(FADE_DELAY + FADE_DUR + 400, FADE_DELAY + FADE_DUR);
      onReveal(); // mount the card + gradient backdrop underneath
      finishTimer = window.setTimeout(onFinished, FADE_DELAY + FADE_DUR);
    };

    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    // Film vignette: darkened corners over everything, rebuilt on resize.
    let vignette: CanvasGradient | null = null;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      cx = w / 2;
      cy = h / 2;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      vignette = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.38, cx, cy, Math.max(w, h) * 0.76);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.62)");
    };
    resize();
    window.addEventListener("resize", resize);

    // Film grain: several pre-rendered noise tiles; every frame picks a
    // random tile AND a random offset, so no pattern ever repeats visibly.
    // Still one pattern-fill per frame - cheap, and reads as real stock.
    const GRAIN_TILE = 256;
    const grains: CanvasPattern[] = [];
    for (let n = 0; n < 4; n++) {
      const tile = document.createElement("canvas");
      tile.width = GRAIN_TILE;
      tile.height = GRAIN_TILE;
      const nctx = tile.getContext("2d");
      if (!nctx) break;
      const id = nctx.createImageData(GRAIN_TILE, GRAIN_TILE);
      for (let i = 0; i < id.data.length; i += 4) {
        const v = Math.floor(Math.random() * 256);
        id.data[i] = v;
        id.data[i + 1] = v;
        id.data[i + 2] = v;
        id.data[i + 3] = 24; // faint, baked into the tile
      }
      nctx.putImageData(id, 0, 0);
      const p = ctx.createPattern(tile, "repeat");
      if (p) grains.push(p);
    }

    // Opaque base so the full-screen canvas hides the app behind it.
    ctx.fillStyle = BASE;
    ctx.fillRect(0, 0, w, h);

    // Reduced motion: skip the choreography - show the mark, title, and the
    // continue button right away, and wait for the click like the full intro.
    if (prefersReducedMotion()) {
      setBlackIn(true);
      if (vignette) {
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, w, h);
      }
      if (titleRef.current) titleRef.current.style.opacity = "1";
      if (ctaRef.current) {
        ctaRef.current.style.opacity = "1";
        ctaRef.current.style.pointerEvents = "auto";
      }
      beginExitRef.current = () => {
        if (ctaRef.current) ctaRef.current.style.pointerEvents = "none";
        settle();
      };
      return () => {
        void closeCinemaBackdrop();
        void setAppDecorations(true);
        void releaseCinemaFloat();
        window.clearTimeout(finishTimer);
        window.removeEventListener("resize", resize);
      };
    }

    // Fail-open watchdog: the show must NEVER trap the user. If, for any
    // reason (a crashed frame loop, a stalled webview, a bug we have not
    // met yet), the intro has not handed off well past its natural end, it
    // hands off by force. Sized from mount with generous slack for a slow
    // first frame.
    const watchdog = window.setTimeout(
      () => {
        if (done) return;
        console.error("intro watchdog fired; forcing the handoff");
        settle();
      },
      ctaAt + AUTO_EXIT_AFTER_CTA + 15_000,
    );

    // The intro clock starts at the FIRST FRAME, not at mount: a cold launch
    // can stall the main thread for seconds after the effect runs, and an
    // effect-time clock would let the acts race ahead of the fade-to-black.
    // Anchoring blackout, music, and choreography to the same first frame
    // keeps them in sync no matter how late rendering actually starts.
    let start = 0;
    let raf = 0;
    // Windows that launch hidden can leave the webview's display link paused:
    // requestAnimationFrame never fires even after the window shows. If the
    // first frame has not arrived shortly after mount, drive the show with a
    // plain timer instead (timers keep running when rAF does not).
    let timerDriven = false;
    let intervalId = 0;
    const rafFallback = window.setTimeout(() => {
      if (start || done) return;
      console.error("intro rAF never ticked; driving the show with a timer");
      cancelAnimationFrame(raf);
      timerDriven = true;
      intervalId = window.setInterval(() => {
        if (done) {
          window.clearInterval(intervalId);
          return;
        }
        safeFrame(performance.now());
      }, 33);
    }, 1500);
    let typedCount = -1;
    let typedIdx = -2;
    let caretPhase = -1;
    let activePhoto = -1;
    let backdropGone = false; // the desktop darkness lifts once, mid-show
    let exitFrom: number | null = null; // elapsed ms when the exit began
    // An occasional vertical scratch, like worn stock.
    let scratchX = 0;
    let scratchUntil = 0;

    // The held title screen ends on the user's gesture: release the score
    // over the scene fade and hand off to onboarding.
    beginExitRef.current = () => {
      if (done || exitFrom != null || !start) return;
      const elapsed = performance.now() - start;
      if (elapsed < ctaAt) return; // not interactive until the button shows
      exitFrom = elapsed;
      if (ctaRef.current) ctaRef.current.style.pointerEvents = "none";
      stopMusic?.(EXIT_MUSIC_FADE_S);
      settle();
    };

    // Fail-open: an exception anywhere in the frame loop would silently end
    // the rAF chain and freeze the show with no exit. Crash -> log it and
    // hand off to onboarding instead.
    const safeFrame = (now: number) => {
      try {
        frame(now);
      } catch (e) {
        console.error("intro frame crashed; handing off", e);
        settle();
      }
    };

    const frame = (now: number) => {
      if (!start) {
        start = now;
        setBlackIn(true); // begin the fade-to-black
        stopMusic = playIntroMusic();
      }
      const elapsed = now - start;

      // --- Act 2: the story types out, letter by letter ---
      const rel = elapsed - LINES_START;
      const idx = rel >= 0 ? Math.floor(rel / LINE_MS) : -1;
      if (lineRef.current && !done) {
        if (idx >= 0 && idx < N) {
          const line = linesRef.current[idx];
          const lt = rel - idx * LINE_MS;
          const count = Math.min(line.length, Math.floor(lt / CHAR_MS));
          // The caret blinks while the line is up, and leaves with it.
          const phase = Math.floor(lt / CARET_BLINK_MS) % 2;
          // Only touch the DOM when the visible string actually changes:
          // writing textContent every frame would force a layout every frame.
          if (idx !== typedIdx || count !== typedCount || phase !== caretPhase) {
            if (idx !== typedIdx) {
              // The typeface evolves with the story: typewriter, then Times,
              // then Comic Sans - the title answers in the app's own font.
              lineRef.current.style.fontFamily = LINE_FONTS[Math.min(idx, LINE_FONTS.length - 1)];
            }
            typedIdx = idx;
            typedCount = count;
            caretPhase = phase;
            lineRef.current.textContent = line.slice(0, count) + (phase === 0 ? "▌" : " ");
          }
          const out = clamp01((lt - (LINE_MS - LINE_OUT_MS)) / LINE_OUT_MS);
          lineRef.current.style.opacity = String(1 - out);
        } else {
          lineRef.current.style.opacity = "0";
        }
      }

      // --- Act 2: the photographs flip through above the story ---
      const prel = elapsed - PHOTOS_START;
      const pIdx = prel >= 0 ? Math.floor(prel / PHOTO_MS) : -1;
      if (photoRef.current && imgRef.current && !done) {
        if (pIdx !== activePhoto && pIdx >= 0 && pIdx < PHOTOS.length) {
          activePhoto = pIdx;
          imgRef.current.src = PHOTOS[pIdx];
        }
        let o = 0;
        let rotY = 0;
        let rotZ = 0;
        if (pIdx >= 0 && pIdx < PHOTOS.length) {
          const pt = prel - pIdx * PHOTO_MS;
          const inP = easeOutCubic(clamp01(pt / PHOTO_IN_MS));
          const outP = easeInCubic(clamp01((pt - (PHOTO_MS - PHOTO_OUT_MS)) / PHOTO_OUT_MS));
          o = inP * (1 - outP);
          // Flips in from one side, tips away to the other - a print turned
          // over onto the table. Each sits slightly askew.
          rotY = (1 - inP) * -78 + outP * 78;
          rotZ = pIdx % 2 === 0 ? -2.5 : 2;
        }
        photoRef.current.style.opacity = String(o);
        photoRef.current.style.transform = `perspective(1100px) rotateY(${rotY}deg) rotate(${rotZ}deg)`;
      }

      // --- Act 3: the title row (mark + wordmark, one line) simply arrives ---
      if (titleRef.current && !done) {
        const p = easeOutCubic(clamp01((elapsed - titleStart) / TITLE_FADE_MS));
        const hold = clamp01((elapsed - titleStart - TITLE_FADE_MS) / 8000);
        titleRef.current.style.opacity = String(p);
        titleRef.current.style.transform = `translateY(${(1 - p) * 8}px) scale(${1.03 - 0.03 * p + 0.012 * hold})`;
      }

      // --- Act 3b: the continue button fades in once the title has landed ---
      if (ctaRef.current && !done) {
        const p = easeOutCubic(clamp01((elapsed - ctaAt) / CTA_IN_MS));
        ctaRef.current.style.opacity = String(p);
        ctaRef.current.style.pointerEvents = p > 0.6 ? "auto" : "none";
      }

      // The theater darkness lifts while the show is STILL PLAYING, but only
      // once the story has been told: as the title lands, the desktop slowly
      // fades back in around the window - the dark belongs to the opening
      // and the reel, the finale plays in daylight.
      if (!backdropGone && elapsed >= titleStart) {
        backdropGone = true;
        void fadeCinemaBackdrop();
        void closeCinemaBackdrop(4600, 4200);
        // The darkness is lifting: stop floating over other apps.
        window.setTimeout(() => void releaseCinemaFloat(), 4600);
      }

      // Self-advance: if the user never clicks, the show ends on its own beat.
      if (exitFrom == null && elapsed >= ctaAt + AUTO_EXIT_AFTER_CTA) {
        beginExitRef.current();
      }

      // ---- The canvas: warm black, drifting lamplight, grain, vignette ----
      ctx.fillStyle = BASE;
      ctx.fillRect(0, 0, w, h);

      // Act 0: hold pure black while the scene fades in.
      if (elapsed < BLACKOUT_MS) {
        if (!timerDriven) raf = requestAnimationFrame(safeFrame);
        return;
      }

      // The color grade: a full-screen gradient. Big overlapping fields that
      // cover the whole frame and drift into each other - never flat black.
      const gradeIn = clamp01((elapsed - BLACKOUT_MS) / 3000);
      if (gradeIn > 0) {
        const tSec = elapsed / 1000;
        ctx.globalCompositeOperation = "lighter";
        for (const f of FIELDS) {
          const nx = cx + Math.sin(tSec * f.ox * 2) * w * f.ax;
          const ny = cy + Math.cos(tSec * f.oy * 2) * h * f.ay;
          const nr = Math.max(w, h) * 0.85;
          const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
          g.addColorStop(0, `rgba(${f.color},${FIELD_ALPHA * gradeIn})`);
          g.addColorStop(1, `rgba(${f.color},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.globalCompositeOperation = "source-over";
      }

      // Act 1: the lamp - swells alone in the dark, then settles low and
      // keeps breathing behind the photographs.
      const lampIn = easeOutCubic(clamp01((elapsed - GLOW_START) / GLOW_IN_MS));
      const lampSettle = clamp01((elapsed - GLOW_SETTLE_START) / GLOW_SETTLE_MS);
      const lamp = lampIn * (1 - (1 - GLOW_LINGER) * lampSettle);
      if (lamp > 0) {
        const breathe = 1 + 0.05 * Math.sin(elapsed / 340) + 0.02 * Math.sin(elapsed / 97);
        const r = Math.min(w, h) * (0.2 + 0.12 * lampIn) * breathe;
        ctx.globalCompositeOperation = "lighter";
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        core.addColorStop(0, `rgba(240,242,255,${0.75 * lamp})`);
        core.addColorStop(0.55, `rgba(178,168,240,${0.32 * lamp})`);
        core.addColorStop(1, "rgba(150,130,220,0)");
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, w, h);
        const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2);
        halo.addColorStop(0, `rgba(150,130,220,${0.24 * lamp})`);
        halo.addColorStop(1, "rgba(150,130,220,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }

      // Projector flicker: a faint luminance wobble over the whole frame.
      const flicker = 0.02 + 0.018 * Math.abs(Math.sin(elapsed / 137));
      ctx.fillStyle = `rgba(0,0,0,${flicker})`;
      ctx.fillRect(0, 0, w, h);

      // An occasional vertical scratch, held for a few frames.
      if (now > scratchUntil && Math.random() < 0.006) {
        scratchX = Math.random() * w;
        scratchUntil = now + 80 + Math.random() * 140;
      }
      if (now <= scratchUntil) {
        ctx.fillStyle = "rgba(235,224,200,0.05)";
        ctx.fillRect(scratchX, 0, 1, h);
      }

      // Film grain: a random tile at a random offset, fresh every frame.
      if (grains.length) {
        const jx = Math.floor(Math.random() * GRAIN_TILE);
        const jy = Math.floor(Math.random() * GRAIN_TILE);
        ctx.save();
        ctx.translate(-jx, -jy);
        ctx.fillStyle = grains[Math.floor(Math.random() * grains.length)];
        ctx.fillRect(0, 0, w + GRAIN_TILE, h + GRAIN_TILE);
        ctx.restore();
      }

      // Vignette on top of everything - darkened corners each frame.
      if (vignette) {
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, w, h);
      }

      if (!timerDriven) raf = requestAnimationFrame(safeFrame);
    };
    raf = requestAnimationFrame(safeFrame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(rafFallback);
      window.clearInterval(intervalId);
      window.clearTimeout(watchdog);
      stopMusic?.();
      void closeCinemaBackdrop();
      void setAppDecorations(true);
      void releaseCinemaFloat();
      window.clearTimeout(finishTimer);
      window.removeEventListener("resize", resize);
    };
    // Run once for the lifetime of the intro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className="co-space-intro"
      style={{
        zIndex: 60,
        // Three phases: mount transparent, fade to black (Act 0), and at the
        // end fade the whole scene out to the onboarding (Act 4). The exit
        // fade is ALSO written straight onto the element in settle(), so the
        // handoff cannot be blocked by a wedged React render.
        opacity: fading ? 0 : blackIn ? 1 : 0,
        transition: fading
          ? `opacity ${FADE_DUR}ms ease ${FADE_DELAY}ms`
          : instantBlack
            ? "none"
            : `opacity ${BLACKOUT_MS}ms ease-in`,
        // The scene ignores the pointer; only the continue button (which sets
        // its own pointer-events once visible) is interactive.
        pointerEvents: "none",
      }}
    >
      <canvas ref={canvasRef} className="co-space-canvas" aria-hidden />
      {/* The story: photographs over the typewriter line, centered as a group. */}
      <div className="co-intro-stage" aria-hidden>
        <div className="co-intro-topslot">
          <div ref={photoRef} className="co-intro-photo" style={{ opacity: 0 }}>
            <img ref={imgRef} alt="" draggable={false} />
          </div>
        </div>
        <div ref={lineRef} className="co-intro-line" style={{ opacity: 0 }} />
      </div>
      {/* The finale gets its own centered layer, so the empty photo slot
          above never pushes the title row (mark + wordmark) off middle. */}
      <div className="co-intro-titlelayer">
        <div ref={titleRef} className="co-intro-title" style={{ opacity: 0 }} aria-hidden>
          <IntroMark className="co-intro-title-mark" />
          <span>{title}</span>
        </div>
        <button
          ref={ctaRef}
          type="button"
          className="co-intro-cta"
          style={{ opacity: 0, pointerEvents: "none" }}
          aria-label={t("onboarding:intro.continue", "Begin")}
          onClick={() => beginExitRef.current()}
        >
          <svg
            className="co-intro-cta-arrow"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
