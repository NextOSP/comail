import { describe, expect, it } from "vitest";
import type { Settings } from "../ipc/types";
import { isOpenRouterUrl, usesOpenRouter } from "./openrouter";

const base = {
  aiBaseUrl: "https://api.openai.com/v1",
  decisionProvider: "off",
  decisionBaseUrl: "",
  decisionBackups: [],
} as unknown as Settings;

describe("openrouter endpoint detection", () => {
  it("matches the host, not a substring", () => {
    expect(isOpenRouterUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterUrl(" https://EU.openrouter.ai/api/v1 ")).toBe(true);
    expect(isOpenRouterUrl("https://openrouter.ai.evil.example/v1")).toBe(false);
    expect(isOpenRouterUrl("https://proxy.example/openrouter.ai/v1")).toBe(false);
    expect(isOpenRouterUrl("")).toBe(false);
  });

  it("counts chat and every decision endpoint", () => {
    expect(usesOpenRouter(base)).toBe(false);
    expect(
      usesOpenRouter({ ...base, aiBaseUrl: "https://openrouter.ai/api/v1" }),
    ).toBe(true);
    expect(usesOpenRouter({ ...base, decisionProvider: "openrouter" })).toBe(
      true,
    );
    expect(
      usesOpenRouter({
        ...base,
        decisionBackups: [
          {
            provider: "custom",
            model: "",
            baseUrl: "https://openrouter.ai/api/alpha/decisions",
            format: "openrouter",
          },
        ],
      }),
    ).toBe(true);
  });
});
