import { beforeEach, describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "./commands";
import { currentTargets } from "./context";
import { useUi } from "../stores/ui";

describe("TC-CUSTOM-01 target priority", () => {
  beforeEach(() => {
    useUi.setState({
      selection: [],
      openThreadId: null,
      selectedThreadId: null,
      hoveredThreadId: null,
      selectedIndex: 0,
    });
  });

  it("multi-select beats hover when list has selection and no open thread", () => {
    useUi.setState({
      selection: [10, 11],
      hoveredThreadId: 99,
      selectedThreadId: 1,
      openThreadId: null,
    });
    expect(currentTargets(useUi.getState())).toEqual([10, 11]);
  });

  it("hover beats cursor / open thread", () => {
    useUi.setState({
      selection: [],
      hoveredThreadId: 42,
      openThreadId: 7,
      selectedThreadId: 3,
    });
    expect(currentTargets(useUi.getState())).toEqual([42]);
  });

  it("registers U = archive+unsubscribe and Shift+U = read", () => {
    const markDoneUnsub = ALL_COMMANDS.find((c) => c.id === "mark-done-unsubscribe");
    const read = ALL_COMMANDS.find((c) => c.id === "read");
    expect(markDoneUnsub?.keys).toEqual(["u"]);
    expect(read?.keys).toEqual(["shift+u"]);
  });
});
