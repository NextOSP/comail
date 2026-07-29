import { describe, expect, it } from "vitest";
import {
  UPDATE_CHANNEL,
  updateInstallBlockedReason,
  updatesInstallAllowed,
} from "./updateChannel";

describe("TC-UPD-00 update channel lock", () => {
  it("defaults to locked (no personal channel cutover yet)", () => {
    expect(UPDATE_CHANNEL).toBe("locked");
    expect(updatesInstallAllowed()).toBe(false);
    expect(updateInstallBlockedReason()).toMatch(/TC-UPD-00/);
  });

  it("allows install only when channel is rauta", () => {
    expect(updatesInstallAllowed("rauta")).toBe(true);
    expect(updateInstallBlockedReason("rauta")).toBeNull();
    expect(updatesInstallAllowed("locked")).toBe(false);
  });
});
