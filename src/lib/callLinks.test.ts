import { describe, expect, it } from "vitest";
import {
  bothCallLinksDescription,
  callLaunchUrl,
  callLinkDigits,
  callLocationLabel,
  mergeCallDescription,
} from "./callLinks";

describe("callLinks", () => {
  it("normalizes E.164 to digits", () => {
    expect(callLinkDigits("+1 (415) 602-3047")).toBe("14156023047");
    expect(callLinkDigits("415")).toBeNull();
  });

  it("builds https Rauta launch URLs", () => {
    expect(callLaunchUrl("facetime", "+14156023047")).toBe(
      "https://gateway.rauta.ai/call/facetime/14156023047",
    );
    expect(callLaunchUrl("whatsapp", "14156023047")).toBe(
      "https://gateway.rauta.ai/call/whatsapp/14156023047",
    );
  });

  it("labels location for single and both", () => {
    expect(callLocationLabel("facetime")).toBe("FaceTime");
    expect(callLocationLabel("whatsapp")).toBe("WhatsApp");
    expect(callLocationLabel("both")).toBe("FaceTime / WhatsApp");
  });

  it("lists both options for description", () => {
    const block = bothCallLinksDescription("+14156023047");
    expect(block).toContain("FaceTime: https://gateway.rauta.ai/call/facetime/14156023047");
    expect(block).toContain("WhatsApp: https://gateway.rauta.ai/call/whatsapp/14156023047");
  });

  it("merges description without duplicating", () => {
    const block = bothCallLinksDescription("+14156023047")!;
    expect(mergeCallDescription("Notes", block)).toContain("Notes");
    expect(mergeCallDescription("Notes", block)).toContain("Join options:");
    expect(mergeCallDescription(block, block)).toBe(block);
  });
});
