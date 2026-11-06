import { useSyncExternalStore } from "react";
import { useUi } from "../stores/ui";

export const SIDEBAR_MEDIA = "(min-width: 960px)";
const isWide = () => typeof window !== "undefined" && window.matchMedia(SIDEBAR_MEDIA).matches;
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(SIDEBAR_MEDIA);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

export function useSidebarDocked() {
  const pinned = useUi((s) => s.sidebarPinned);
  const wide = useSyncExternalStore(subscribe, isWide, () => false);
  return pinned && wide;
}

/** Same behavior for the toolbar and command shortcut. Narrow windows retain pin preference. */
export function toggleSidebar() {
  const { sidebarPinned, sidebarOpen, set } = useUi.getState();
  if (sidebarPinned && isWide()) set({ sidebarPinned: false, sidebarOpen: false });
  else set({ sidebarOpen: !sidebarOpen });
}
