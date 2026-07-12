import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EventMap } from "./types";
import { MOCK_MODE } from "./mock";

/** Subscribe to a backend event. Returns an unsubscribe function. */
export function onEvent<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): () => void {
  if (MOCK_MODE) return () => {};
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<EventMap[K]>(name, (e) => handler(e.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
