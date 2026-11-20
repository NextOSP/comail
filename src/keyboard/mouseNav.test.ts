import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../queries/client";
import { useUi } from "../stores/ui";
import { installFrameMouseNav, installMouseNav } from "./registry";

// The suite runs without a DOM, so a bare EventTarget stands in for the
// message iframe's contentDocument and for the parent window: dispatching on
// one never reaches the other, exactly like a real iframe document (#107).
// Event + an own `button` is all handleMouseNav reads off a MouseEvent.
function press(target: EventTarget, button: number) {
  const events = ["mousedown", "mouseup", "auxclick"].map((type) =>
    Object.assign(new Event(type, { cancelable: true }), { button }),
  );
  for (const e of events) target.dispatchEvent(e);
  return events;
}

let frameDoc: EventTarget;
const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
let uninstall = () => {};

beforeEach(() => {
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
  frameDoc = new EventTarget();
  installFrameMouseNav(frameDoc as Document);
  if (!hadWindow) g.window = new EventTarget();
  uninstall = installMouseNav();
});

afterEach(() => {
  uninstall();
  if (!hadWindow) delete g.window;
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
});

describe("mouse back/forward over a message body iframe (#107)", () => {
  it("back closes the open conversation and cancels the frame's own history step", () => {
    useUi.setState({ openThreadId: 7, selectedThreadId: 7 });
    const events = press(frameDoc, 3);
    expect(useUi.getState().openThreadId).toBeNull();
    expect(events.map((e) => e.defaultPrevented)).toEqual([true, true, true]);
  });

  it("forward re-opens the thread under the cursor from the list", () => {
    useUi.setState({ openThreadId: null, selectedThreadId: 9 });
    const events = press(frameDoc, 4);
    expect(useUi.getState().openThreadId).toBe(9);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
  });

  it("acts once per press, on release", () => {
    useUi.setState({ openThreadId: 7, searchOpen: true, searchQuery: "q" });
    press(frameDoc, 3);
    // One step out of the stack: the conversation closes, search stays open.
    expect(useUi.getState()).toMatchObject({ openThreadId: null, searchOpen: true });
  });

  it("leaves the primary, middle and context-menu buttons native", () => {
    useUi.setState({ openThreadId: 7 });
    for (const button of [0, 1, 2]) {
      const events = press(frameDoc, button);
      expect(events.some((e) => e.defaultPrevented)).toBe(false);
    }
    expect(useUi.getState().openThreadId).toBe(7);
  });

  it("still works on the parent window, alongside the frame listener", () => {
    useUi.setState({ openThreadId: 7 });
    press(window, 3);
    expect(useUi.getState().openThreadId).toBeNull();
  });
});
