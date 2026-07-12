import { invoke } from "@tauri-apps/api/core";
import type { Commands } from "./types";
import { mockInvoke, MOCK_MODE } from "./mock";

/**
 * Typed IPC entry point. In mock mode (plain `pnpm dev` in a browser,
 * VITE_MOCK=1) calls are served from an in-memory fixture instead of Rust.
 */
export async function call<K extends keyof Commands>(
  cmd: K,
  args: Parameters<Commands[K]>[0],
): Promise<Awaited<ReturnType<Commands[K]>>> {
  if (MOCK_MODE) {
    return mockInvoke(cmd, args) as Promise<Awaited<ReturnType<Commands[K]>>>;
  }
  return invoke(cmd as string, args as Record<string, unknown>) as Promise<
    Awaited<ReturnType<Commands[K]>>
  >;
}
