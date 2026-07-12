// Turns errors thrown across the Tauri IPC boundary into localized, human-readable
// text. Backend commands reject with a JSON string `{"code","message"}` (see
// src-tauri/src/commands.rs); anything else (plain strings, JS errors) is passed
// through as-is.

import i18n from "../i18n";

export interface BackendError {
  /** stable snake_case token from CoreError::code(), or "unknown". */
  code: string;
  /** the original English detail message from the backend. */
  message: string;
}

/** Extract a structured code + message from any thrown value. */
export function parseError(err: unknown): BackendError {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { code?: unknown }).code === "string"
    ) {
      const p = parsed as { code: string; message?: unknown };
      return { code: p.code, message: typeof p.message === "string" ? p.message : raw };
    }
  } catch {
    // not a structured backend error - fall through
  }
  return { code: "unknown", message: raw };
}

/**
 * Localized message for any error. Maps a known backend code to an `errors:`
 * catalog string, falling back to the raw backend detail when the code is
 * unmapped so nothing is lost.
 */
export function errorMessage(err: unknown): string {
  const { code, message } = parseError(err);
  return i18n.t(`errors:${code}`, { defaultValue: message });
}
