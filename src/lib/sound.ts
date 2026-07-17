// Short UI sounds (new mail, send) played through Web Audio. This is
// deliberately independent of OS notifications: desktop banners need a
// properly signed/installed build to appear, but these sounds play regardless,
// so the user still gets an audible new-mail / sent cue.
//
// Web Audio, not <audio>, on purpose. Webviews (WKWebView on macOS especially)
// block audio that isn't tied to a user gesture; the classic HTMLAudioElement
// workaround "unlocks" each clip by playing it muted on the first interaction,
// but on some WebKit builds that muted priming is AUDIBLE - the app would blow
// the send whoosh on the user's first click or keypress after launch. An
// AudioContext instead unlocks by resume(), which produces no sound by
// definition; nothing can ever reach the speakers except an explicit
// playSound(). Decoded buffers also start with zero latency and keep working
// while the app is backgrounded.
import { MOCK_MODE } from "../ipc/mock";
import type { Settings } from "../ipc/types";
import { queryClient } from "../queries/client";

type SoundName = "new-email" | "send" | "intro";

const FILES: Record<SoundName, string> = {
  "new-email": "/sounds/new-email.wav",
  send: "/sounds/send.wav",
  intro: "/sounds/intro.wav",
};

let audioCtx: AudioContext | null = null;
const buffers = new Map<SoundName, AudioBuffer>();
// Decode promises, so the intro music can start as soon as its (large) clip
// finishes decoding instead of silently missing the show.
const loads = new Map<SoundName, Promise<AudioBuffer | null>>();

// The new-mail chime is suppressed until this time, to cover the initial
// catch-up sync after launch: reopening the app shouldn't replay a chime for
// mail that arrived (or was sent) while it was closed. 0 = not yet armed.
let chimeReadyAt = Number.POSITIVE_INFINITY;
// Fallback window if the initial sync never reports "settled".
const STARTUP_GRACE_MS = 20_000;

// Rate limiting so a burst of arrivals doesn't machine-gun the speakers.
const COOLDOWN_MS = 1_500; // ignore repeats of the same sound within this window
const CHIME_WINDOW_MS = 10_000; // rolling window for the chime cap
const MAX_CHIMES = 5; // most new-mail chimes allowed per window
// Per-sound playback volume (1 = clip's natural level).
const GAINS: Record<Exclude<SoundName, "intro">, number> = {
  send: 0.5,
  "new-email": 0.8,
};

const lastPlayedAt = new Map<SoundName, number>();
const chimeTimes: number[] = [];

function soundsEnabled(): boolean {
  // Dedicated sound toggle; default on when settings haven't loaded yet.
  const settings = queryClient.getQueryData<Settings>(["settings"]);
  return !settings || settings.soundEnabled;
}

/**
 * Create the audio context, start decoding the clips, and arm a first-gesture
 * unlock (`AudioContext.resume()` - silent, unlike the old muted-<audio>
 * priming). Mount once at app startup; safe to call more than once.
 */
export function initSounds(): void {
  if (MOCK_MODE) return;
  // Arm the new-mail chime after a startup grace window (a floor, in case the
  // initial sync's "settled" signal never arrives). markSoundsReady() can arm
  // it sooner once the first sync completes; extendStartupQuiet() pushes it
  // out while that sync is still running.
  chimeReadyAt = Date.now() + STARTUP_GRACE_MS;
  if (audioCtx) return;

  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return; // no audio output available; sounds stay off
  }
  audioCtx = ctx;

  for (const name of Object.keys(FILES) as SoundName[]) {
    loads.set(
      name,
      fetch(FILES[name])
        .then((r) => r.arrayBuffer())
        .then((raw) => ctx.decodeAudioData(raw))
        .then((buf) => {
          buffers.set(name, buf);
          return buf;
        })
        .catch(() => null /* clip missing/undecodable: that sound stays silent */),
    );
  }

  // The context starts suspended under the webview's autoplay policy; any
  // user gesture may resume it. Keep trying until it actually runs.
  const unlock = () => {
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === "running") {
          window.removeEventListener("pointerdown", unlock);
          window.removeEventListener("keydown", unlock);
        }
      })
      .catch(() => {
        /* try again on the next gesture */
      });
  };
  unlock();
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/**
 * Arm the new-mail chime immediately (call when the initial catch-up sync has
 * settled). Only ever brings the ready time forward, never pushes it back.
 */
export function markSoundsReady(): void {
  chimeReadyAt = Math.min(chimeReadyAt, Date.now());
}

/**
 * Keep the chime quiet while the initial catch-up sync is still running - a
 * big backlog easily outlasts the fixed startup grace window, and arming on
 * that timer mid-sync replays chimes for mail that arrived while the app was
 * closed. Each call pushes the ready time to "grace window from now"; the
 * settle signal (markSoundsReady) then arms it the moment the sync finishes.
 * No-op once the chime is live, so routine later syncs can't mute real mail.
 */
export function extendStartupQuiet(): void {
  const now = Date.now();
  if (now >= chimeReadyAt) return; // already live
  chimeReadyAt = Math.max(chimeReadyAt, now + STARTUP_GRACE_MS);
}

/** Play a bundled UI sound. Best-effort: never throws, no-op in mock mode. */
export function playSound(name: Exclude<SoundName, "intro">): void {
  if (MOCK_MODE) return;
  try {
    if (!soundsEnabled()) return;
    // Skip the new-mail chime for the post-launch catch-up sync (backlog), so
    // reopening the app doesn't chime for old mail. The user-initiated send
    // whoosh is never suppressed.
    if (name === "new-email" && Date.now() < chimeReadyAt) return;

    const ctx = audioCtx;
    const buf = buffers.get(name);
    // Not decoded yet, or no user gesture has resumed the context: skip
    // (matches the old autoplay-blocked behavior).
    if (!ctx || !buf || ctx.state !== "running") return;

    const now = Date.now();
    // Coalesce a rapid burst of the same sound into a single play.
    if (now - (lastPlayedAt.get(name) ?? 0) < COOLDOWN_MS) return;
    if (name === "new-email") {
      // Hard-cap the chime so a large batch of new mail can't play endlessly.
      while (chimeTimes.length && now - chimeTimes[0] > CHIME_WINDOW_MS) chimeTimes.shift();
      if (chimeTimes.length >= MAX_CHIMES) return;
      chimeTimes.push(now);
    }
    lastPlayedAt.set(name, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = GAINS[name];
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {
    /* best-effort */
  }
}

// Film-style gain envelope for the intro soundtrack, in clip-time seconds:
// silence under the fade-to-black, a swell as the lamp warms up, a calm
// sustain under the photographs and the typewriter, a swell for the title,
// then a fade-out across the tail. The 30s track ends at the envelope's tail.
const INTRO_ENVELOPE: Array<[number, number]> = [
  [0, 0],
  [2.4, 0.1], // barely-there rumble while the screen fades to black
  [5.2, 0.55], // rising as the lamp warms up
  [7.0, 0.9], // full presence under the photographs and the typewriter
  [15.5, 0.85],
  [17.8, 1.0], // title swell
  [22.0, 0.95],
  [26.0, 0.8],
  [30.0, 0], // resolve; if the user clicks earlier, the stop fade takes over
];

/**
 * Start the intro soundtrack with its cinematic gain envelope. Call when the
 * space intro mounts; returns a stop function taking an optional fade-out in
 * seconds. The default is a fast fade for effect cleanup (StrictMode's dev
 * double-mount must not leave two overlapping tracks); pass a longer fade for
 * the user-triggered exit so the score releases with the scene.
 *
 * The webview may not allow audio before a user gesture. We try to resume the
 * context immediately (Tauri usually permits it); if that fails, the first
 * pointer/key gesture starts the music offset-synced into the clip, so it
 * joins the scene in progress instead of restarting from the top. The same
 * offset logic covers a slow decode of the (large) clip.
 */
export function playIntroMusic(): (fadeS?: number) => void {
  if (MOCK_MODE) return () => {};
  // The intro mounts before App's own initSounds() effect runs (child effects
  // fire first), so make sure the context + decodes exist. Idempotent.
  initSounds();
  const ctx = audioCtx;
  const load = loads.get("intro");
  if (!ctx || !load || !soundsEnabled()) return () => {};

  const introStart = performance.now();
  let stopped = false;
  let started = false;
  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;

  const begin = (buf: AudioBuffer) => {
    if (stopped || started || ctx.state !== "running") return;
    // How far into the intro we are (a gesture unlock or slow decode may have
    // delayed the start). Past that point there is nothing left worth playing.
    const offset = (performance.now() - introStart) / 1000;
    if (offset >= buf.duration - 1) return;
    started = true;
    detach();

    gain = ctx.createGain();
    // Schedule the envelope on the clip's own clock: t0 is where clip-time 0
    // maps onto the context clock. Points already in the past collapse into an
    // immediate jump, which is exactly the catch-up we want on a late start.
    const t0 = ctx.currentTime - offset;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    for (const [t, v] of INTRO_ENVELOPE) {
      gain.gain.linearRampToValueAtTime(v, Math.max(t0 + t, ctx.currentTime));
    }

    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0, offset);
  };

  const attempt = () => {
    if (stopped || started) return;
    void ctx
      .resume()
      .then(() => load)
      .then((buf) => {
        if (buf) begin(buf);
      })
      .catch(() => {
        /* wait for the next gesture */
      });
  };
  const detach = () => {
    window.removeEventListener("pointerdown", attempt);
    window.removeEventListener("keydown", attempt);
  };

  attempt();
  window.addEventListener("pointerdown", attempt);
  window.addEventListener("keydown", attempt);

  return (fadeS = 0.2) => {
    if (stopped) return;
    stopped = true;
    detach();
    try {
      if (src && gain) {
        // Fade instead of a hard cut, however we're stopped mid-track.
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeS);
        src.stop(ctx.currentTime + fadeS + 0.05);
      }
    } catch {
      /* best-effort */
    }
  };
}
