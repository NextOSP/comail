// Short UI sounds (new mail, send) played through the webview audio element.
// This is deliberately independent of OS notifications: desktop banners need a
// properly signed/installed build to appear, but these sounds play regardless,
// so the user still gets an audible new-mail / sent cue.
//
// Webviews (WKWebView on macOS especially) block audio that isn't tied to a
// user gesture. We work around that by "unlocking" each clip on the first user
// interaction (muted play/pause), after which programmatic plays — including
// the new-mail chime while the app is backgrounded — are allowed.
import { MOCK_MODE } from "../ipc/mock";
import type { Settings } from "../ipc/types";
import { queryClient } from "../queries/client";

type SoundName = "new-email" | "send";

const FILES: Record<SoundName, string> = {
  "new-email": "/sounds/new-email.wav",
  send: "/sounds/send.wav",
};

const cache = new Map<SoundName, HTMLAudioElement>();
let unlocked = false;

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

function get(name: SoundName): HTMLAudioElement {
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(FILES[name]);
    audio.preload = "auto";
    cache.set(name, audio);
  }
  return audio;
}

function soundsEnabled(): boolean {
  // Dedicated sound toggle; default on when settings haven't loaded yet.
  const settings = queryClient.getQueryData<Settings>(["settings"]);
  return !settings || settings.soundEnabled;
}

/**
 * Prime audio playback on the first user gesture, so later programmatic plays
 * (e.g. the new-mail chime while backgrounded) aren't blocked by the webview's
 * autoplay policy. Mount once at app startup; safe to call more than once.
 */
export function initSounds(): void {
  if (MOCK_MODE) return;
  // Arm the new-mail chime after a startup grace window (a floor, in case the
  // initial sync's "settled" signal never arrives). markSoundsReady() can arm
  // it sooner once the first sync completes.
  chimeReadyAt = Date.now() + STARTUP_GRACE_MS;
  if (unlocked) return;
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    for (const name of Object.keys(FILES) as SoundName[]) {
      const audio = get(name);
      audio.muted = true;
      audio
        .play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        })
        .catch(() => {
          audio.muted = false;
        });
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
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

    const audio = get(name);
    audio.currentTime = 0;
    void audio.play().catch(() => {
      /* autoplay blocked / not ready: ignore */
    });
  } catch {
    /* best-effort */
  }
}
