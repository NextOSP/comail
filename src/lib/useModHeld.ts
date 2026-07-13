import { useEffect, useState } from "react";
import { IS_MAC } from "./format";

/** True while the primary shortcut modifier is held down (⌘ on macOS, Ctrl
 *  elsewhere). Used to reveal keyboard-shortcut hints (e.g. tab numbers).
 *  Resets on key-up and on window blur so a Cmd+Tab away can't leave it stuck. */
export function useModHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const isMod = (e: KeyboardEvent) => (IS_MAC ? e.key === "Meta" : e.key === "Control");
    const down = (e: KeyboardEvent) => {
      if (isMod(e)) setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (isMod(e)) setHeld(false);
    };
    const reset = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}
