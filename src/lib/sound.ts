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
  if (MOCK_MODE || unlocked) return;
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

/** Play a bundled UI sound. Best-effort: never throws, no-op in mock mode. */
export function playSound(name: SoundName): void {
  if (MOCK_MODE) return;
  try {
    if (!soundsEnabled()) return;
    const audio = get(name);
    audio.currentTime = 0;
    void audio.play().catch(() => {
      /* autoplay blocked / not ready: ignore */
    });
  } catch {
    /* best-effort */
  }
}
