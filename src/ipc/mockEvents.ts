import type { EventMap } from "./types";

const listeners = new Map<keyof EventMap, Set<(payload: never) => void>>();

export function subscribeMockEvent<K extends keyof EventMap>(
  name: K,
  handler: (payload: EventMap[K]) => void,
): () => void {
  const handlers = listeners.get(name) ?? new Set();
  listeners.set(name, handlers);
  handlers.add(handler as (payload: never) => void);
  return () => { handlers.delete(handler as (payload: never) => void); };
}

export function emitMockEvent<K extends keyof EventMap>(name: K, payload: EventMap[K]): void {
  listeners.get(name)?.forEach((handler) => handler(payload as never));
}
