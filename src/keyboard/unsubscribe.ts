/** Pure helpers for List-Unsubscribe toast / outcome mapping (unit-tested). */

export type UnsubscribeMethod = "one_click" | "needs_browser" | "mailto" | string;

export interface UnsubscribeOutcomeInput {
  ok: boolean;
  method: UnsubscribeMethod;
  status?: number | null;
  error?: string | null;
  /** True after the mailto draft was successfully queued/sent. */
  mailtoSent?: boolean;
}

export type UnsubscribeToastKind = "success" | "info" | "error";

export interface UnsubscribeToast {
  kind: UnsubscribeToastKind;
  /** i18n key under `commands:toast.*` */
  key: string;
  params?: Record<string, string>;
  /** True when the unsubscribe action itself completed (one-click or mailto sent). */
  unsubscribed: boolean;
}

export function toastForUnsubscribe(r: UnsubscribeOutcomeInput): UnsubscribeToast {
  if (r.method === "one_click" && r.ok) {
    return { kind: "success", key: "unsubscribed", unsubscribed: true };
  }
  if (r.method === "needs_browser") {
    return {
      kind: "info",
      key: "unsubscribeOpenedConfirm",
      unsubscribed: false,
    };
  }
  if (r.method === "mailto") {
    if (r.mailtoSent) {
      return { kind: "success", key: "unsubscribeEmailSent", unsubscribed: true };
    }
    return {
      kind: "error",
      key: "unsubscribeFailed",
      params: { detail: r.error ?? "could not send unsubscribe email" },
      unsubscribed: false,
    };
  }
  return {
    kind: "error",
    key: "unsubscribeFailed",
    params: { detail: r.error ?? `unsubscribe failed (${r.status ?? "?"})` },
    unsubscribed: false,
  };
}

export function parseMailtoFromHeader(raw: string): {
  to: string;
  subject?: string;
  body?: string;
} | null {
  const entries = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  if (entries.length === 0) {
    entries.push(...raw.split(",").map((s) => s.trim()).filter(Boolean));
  }
  const mailto = entries.find((e) => /^mailto:/i.test(e));
  if (!mailto) return null;
  const rest = mailto.replace(/^mailto:/i, "");
  const [addr, query] = rest.split("?");
  const to = addr.trim();
  if (!to) return null;
  let subject: string | undefined;
  let body: string | undefined;
  if (query) {
    for (const pair of query.split("&")) {
      const [k, v] = pair.split("=");
      if (!k || v == null) continue;
      const decoded = decodeURIComponent(v.replace(/\+/g, " "));
      if (k.toLowerCase() === "subject") subject = decoded;
      if (k.toLowerCase() === "body") body = decoded;
    }
  }
  return { to, subject, body };
}
