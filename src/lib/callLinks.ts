/**
 * FaceTime / WhatsApp join URLs for calendar Meeting link.
 *
 * Calendar clients only treat http(s) as a Join link, so we use the Rauta
 * gateway launch pages (which hand off to the native app) instead of bare
 * facetime:// schemes.
 */

export type CallLinkMethod = "facetime" | "whatsapp";

const DEFAULT_GATEWAY = "https://gateway.rauta.ai";

/** Digits-only (7–15). Accepts E.164 with + or formatting. */
export function callLinkDigits(e164OrDigits: string): string | null {
  const digits = e164OrDigits.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function callLaunchUrl(
  method: CallLinkMethod,
  e164OrDigits: string,
  gatewayBase = DEFAULT_GATEWAY,
): string | null {
  const digits = callLinkDigits(e164OrDigits);
  if (!digits) return null;
  const base = gatewayBase.replace(/\/$/, "") || DEFAULT_GATEWAY;
  return `${base}/call/${method}/${digits}`;
}

export function callLocationLabel(method: CallLinkMethod | "both"): string {
  if (method === "both") return "FaceTime / WhatsApp";
  if (method === "whatsapp") return "WhatsApp";
  return "FaceTime";
}

/** Plain-text block listing both join options (for DESCRIPTION). */
export function bothCallLinksDescription(e164OrDigits: string): string | null {
  const ft = callLaunchUrl("facetime", e164OrDigits);
  const wa = callLaunchUrl("whatsapp", e164OrDigits);
  if (!ft || !wa) return null;
  return ["Join options:", `FaceTime: ${ft}`, `WhatsApp: ${wa}`].join("\n");
}

/** Merge call-link notes into an existing description without duplicating. */
export function mergeCallDescription(existing: string, block: string): string {
  const trimmed = existing.trim();
  if (!trimmed) return block;
  if (trimmed.includes("gateway.rauta.ai/call/") || trimmed.includes("Join options:")) {
    return trimmed;
  }
  return `${trimmed}\n\n${block}`;
}
