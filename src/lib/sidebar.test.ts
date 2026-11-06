import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleSidebar } from "./sidebar";
import { useUi } from "../stores/ui";

afterEach(() => {
  useUi.getState().set({ sidebarOpen: false, sidebarPinned: false });
  vi.unstubAllGlobals();
});

function viewport(wide: boolean) {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: wide }) });
}

describe("sidebar toggle", () => {
  it("opens and closes the unpinned drawer", () => {
    viewport(true);
    toggleSidebar();
    expect(useUi.getState().sidebarOpen).toBe(true);
    toggleSidebar();
    expect(useUi.getState().sidebarOpen).toBe(false);
  });

  it("collapses and unpins a docked sidebar", () => {
    viewport(true);
    useUi.getState().set({ sidebarPinned: true, sidebarOpen: true });
    toggleSidebar();
    expect(useUi.getState().sidebarPinned).toBe(false);
    expect(useUi.getState().sidebarOpen).toBe(false);
  });

  it("preserves the pin preference when toggling in a narrow window", () => {
    viewport(false);
    useUi.getState().set({ sidebarPinned: true });
    toggleSidebar();
    expect(useUi.getState().sidebarOpen).toBe(true);
    expect(useUi.getState().sidebarPinned).toBe(true);
    toggleSidebar();
    expect(useUi.getState().sidebarOpen).toBe(false);
    expect(useUi.getState().sidebarPinned).toBe(true);
  });

  it("persists the pin preference", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    useUi.getState().set({ sidebarPinned: true });
    expect(setItem).toHaveBeenCalledWith("comail.sidebarPinned", "true");
    useUi.getState().set({ sidebarPinned: false });
    expect(setItem).toHaveBeenCalledWith("comail.sidebarPinned", "false");
  });
});
