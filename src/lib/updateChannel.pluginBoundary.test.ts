import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => {
    throw new Error("updater plugin must not be invoked while channel=locked");
  }),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => {
    throw new Error("relaunch must not run while channel=locked");
  }),
}));

describe("TC-UPD-00 plugin boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("checkForUpdate never imports/calls updater plugin when locked", async () => {
    const { checkForUpdate } = await import("../ipc/updater");
    const { check } = await import("@tauri-apps/plugin-updater");
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("installUpdate refuses before download/relaunch", async () => {
    const { installUpdate } = await import("../ipc/updater");
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await expect(
      installUpdate({
        version: "9.9.9",
        currentVersion: "0.2.26",
        download: async () => {
          throw new Error("download must not run");
        },
      }),
    ).rejects.toThrow(/TC-UPD-00/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
