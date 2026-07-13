import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EventMap } from "./types";
import { MOCK_MODE } from "./mock";

/** Subscribe after the native listener is installed, for snapshot handshakes. */
export async function subscribeEvent<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): Promise<() => void> {
  if (MOCK_MODE) return () => {};
  return listen<EventMap[K]>(name, (event) => handler(event.payload));
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export function onEvent<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): () => void {
  if (MOCK_MODE) return () => {};
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  subscribeEvent(name, handler).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  }).catch(() => {
    // The owning screen can recover through its snapshot/read path.
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
