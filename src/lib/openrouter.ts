import type { Settings } from "../ipc/types";

/** Is `url` an OpenRouter endpoint (`openrouter.ai` or a regional subdomain)?
 *  Mirrors `is_openrouter` in comail-core `ai/mod.rs`: the parsed host, not a
 *  substring. */
export function isOpenRouterUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function decisionUsesOpenRouter(provider: string, baseUrl: string): boolean {
  return (
    provider === "openrouter" ||
    (provider === "custom" && isOpenRouterUrl(baseUrl))
  );
}

/** Does any chat or decision request go to OpenRouter? Gates the
 *  zero-data-retention setting, which only OpenRouter understands. */
export function usesOpenRouter(s: Settings): boolean {
  return (
    isOpenRouterUrl(s.aiBaseUrl) ||
    decisionUsesOpenRouter(s.decisionProvider, s.decisionBaseUrl) ||
    s.decisionBackups.some((ep) =>
      decisionUsesOpenRouter(ep.provider, ep.baseUrl),
    )
  );
}
