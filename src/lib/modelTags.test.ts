import { describe, expect, it } from "vitest";
import { splitModelTags, tagsFor, toggleModelTag } from "./modelTags";

describe("model tags", () => {
  it("peels only known tags", () => {
    expect(splitModelTags("z-ai/glm-5.3:nitro:thinking")).toEqual([
      "z-ai/glm-5.3",
      ["nitro", "thinking"],
    ]);
    expect(splitModelTags("qwen3:8b")).toEqual(["qwen3:8b", []]);
    expect(splitModelTags("qwen/qwen3.8-27b:free")).toEqual([
      "qwen/qwen3.8-27b:free",
      [],
    ]);
  });

  it("toggles tags, keeping one routing tag", () => {
    expect(toggleModelTag("openai/gpt-6-luna", "nitro")).toBe(
      "openai/gpt-6-luna:nitro",
    );
    expect(toggleModelTag("openai/gpt-6-luna:nitro", "floor")).toBe(
      "openai/gpt-6-luna:floor",
    );
    expect(toggleModelTag("openai/gpt-6-luna:floor", "thinking")).toBe(
      "openai/gpt-6-luna:floor:thinking",
    );
    expect(toggleModelTag("openai/gpt-6-luna:floor:thinking", "floor")).toBe(
      "openai/gpt-6-luna:thinking",
    );
    expect(toggleModelTag("", "nitro")).toBe("");
  });

  it("offers tags per endpoint", () => {
    expect(tagsFor("")).toContain("nitro");
    expect(tagsFor("https://api.openai.com/v1")).toEqual([
      "fast",
      "flex",
      "thinking",
    ]);
    expect(tagsFor("https://api.z.ai/api/paas/v4")).toEqual([]);
  });
});
