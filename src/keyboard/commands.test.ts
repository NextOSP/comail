import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../queries/client";
import { SPLIT_IMPORTANT, useUi } from "../stores/ui";
import { ALL_COMMANDS } from "./commands";
import { buildCommandContext } from "./context";

const preserved = {
  calendarDrawer: "week" as const,
  calendarFocusDay: 1746057600000,
  calendarView: "month" as const,
  sidebarPinned: true,
  accountFilter: 7,
};

beforeEach(() => {
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
  useUi.setState({
    ...preserved,
    calendarScreen: true,
    view: "sent",
    labelFilter: 90,
    folderFilter: 91,
    splitId: 92,
    searchOpen: true,
    searchQuery: "old query",
    openThreadId: 101,
    focusedMessageId: 102,
    selectedThreadId: 103,
    selectedIndex: 4,
    selection: [103, 104],
    selectAnchorId: 104,
  });
});

afterEach(() => {
  queryClient.clear();
  useUi.setState(useUi.getInitialState(), true);
});

async function runCommand(id: string) {
  const command = ALL_COMMANDS.find((candidate) => candidate.id === id);
  expect(command, id).toBeDefined();
  const context = buildCommandContext();
  expect(command!.when?.(context) ?? true).toBe(true);
  await command!.run(context);
}

function expectMailState(selectAnchorId: number | null = null) {
  expect(useUi.getState()).toMatchObject({
    ...preserved,
    calendarScreen: false,
    folderFilter: null,
    searchOpen: false,
    openThreadId: null,
    focusedMessageId: null,
    selectedThreadId: null,
    selectedIndex: 0,
    selection: [],
    selectAnchorId,
  });
}

describe("calendar to mail command navigation", () => {
  it.each([false, true])("cached label command (isAuto=%s) returns to mail", async (isAuto) => {
    // Slot zero must follow label position, not query-cache insertion order.
    queryClient.setQueryData(["labels"], [
      { id: 99, name: "Later", position: 10, isAuto: false },
      { id: 42, name: "Target", position: 0, isAuto },
    ]);
    await runCommand("go-label-0");
    // Auto-label navigation historically retains the range-selection anchor.
    expectMailState(isAuto ? 104 : null);
    expect(useUi.getState()).toMatchObject({
      view: isAuto ? "inbox" : "all",
      splitId: null,
      labelFilter: 42,
      searchQuery: isAuto ? "" : "old query",
    });
  });

  it.each([
    "inbox", "starred", "drafts", "sent", "done", "snoozed", "trash", "spam", "all",
  ] as const)("go-%s uses the real command context to leave calendar", async (view) => {
    await runCommand(`go-${view}`);
    expectMailState();
    expect(useUi.getState()).toMatchObject({
      view,
      splitId: view === "inbox" ? SPLIT_IMPORTANT : null,
      labelFilter: null,
      searchQuery: "old query",
    });
  });
});
