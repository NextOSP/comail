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

type SoundName = "new-email" | "send";

const FILES: Record<SoundName, string> = {
  "new-email": "/sounds/new-email.wav",
  send: "/sounds/send.wav",
};

let audioCtx: AudioContext | null = null;
const buffers = new Map<SoundName, AudioBuffer>();

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
    void fetch(FILES[name])
      .then((r) => r.arrayBuffer())
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buf) => buffers.set(name, buf))
      .catch(() => {
        /* clip missing/undecodable: that sound stays silent */
      });
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
 * Keep the chime quiet while the initial catch-up sync is still running — a
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
export function playSound(name: SoundName): void {
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
    src.connect(ctx.destination);
    src.start();
  } catch {
    /* best-effort */
  }
}
