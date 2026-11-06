import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { View } from "../ipc/types";
import { SPLIT_IMPORTANT, SPLIT_OTHER, useUi } from "./ui";

const views = {
  inbox: true,
  starred: true,
  snoozed: true,
  sent: true,
  drafts: true,
  done: true,
  trash: true,
  spam: true,
  all: true,
} satisfies Record<View, true>;

const preserved = {
  calendarDrawer: "day" as const,
  calendarFocusDay: 1746057600000,
  calendarView: "month" as const,
  calendarSidebar: false,
  sidebarPinned: true,
  sidebarOpen: true,
  accountFilter: 12,
  searchQuery: "existing search",
};

function expectMailNavigation(destination: {
  view: View;
  splitId: number | null;
  labelFilter: number | null;
  folderFilter: number | null;
}) {
  expect(useUi.getState()).toMatchObject({
    ...preserved,
    ...destination,
    calendarScreen: false,
    openThreadId: null,
    focusedMessageId: null,
    searchOpen: false,
    selection: [],
    selectAnchorId: null,
    selectedIndex: 0,
    selectedThreadId: null,
  });
}

beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
  useUi.setState({
    ...preserved,
    calendarScreen: true,
    view: "sent",
    splitId: 81,
    labelFilter: 82,
    folderFilter: 83,
    openThreadId: 101,
    focusedMessageId: 102,
    searchOpen: true,
    selection: [101, 103],
    selectAnchorId: 103,
    selectedIndex: 4,
    selectedThreadId: 103,
  });
});

afterEach(() => {
  useUi.setState(useUi.getInitialState(), true);
});

describe("mail navigation from fullscreen calendar", () => {
  it.each(Object.keys(views) as View[])("setView(%s) returns to mail", (view) => {
    useUi.getState().setView(view);
    expectMailNavigation({
      view,
      splitId: view === "inbox" ? SPLIT_IMPORTANT : null,
      labelFilter: null,
      folderFilter: null,
    });
  });

  it.each([SPLIT_IMPORTANT, SPLIT_OTHER, 42, null])(
    "setView preserves explicitly requested inbox split %s",
    (splitId) => {
      useUi.getState().setView("inbox", splitId);
      expectMailNavigation({ view: "inbox", splitId, labelFilter: null, folderFilter: null });
    },
  );

  it.each([42, null])("selectLabel(%s) returns to the all-mail label filter", (labelFilter) => {
    useUi.getState().selectLabel(labelFilter);
    expectMailNavigation({ view: "all", splitId: null, labelFilter, folderFilter: null });
  });

  it.each([42, null])("selectFolder(%s) returns to the all-mail folder filter", (folderFilter) => {
    useUi.getState().selectFolder(folderFilter);
    expectMailNavigation({ view: "all", splitId: null, labelFilter: null, folderFilter });
  });

  it.each(["view", "label", "folder"] as const)(
    "%s navigation also preserves an unpinned sidebar and closed calendar drawer",
    (target) => {
      useUi.setState({ sidebarPinned: false, calendarDrawer: null });
      const ui = useUi.getState();
      if (target === "view") ui.setView("inbox");
      else if (target === "label") ui.selectLabel(42);
      else ui.selectFolder(42);
      expect(useUi.getState()).toMatchObject({
        calendarScreen: false,
        sidebarPinned: false,
        calendarDrawer: null,
        calendarFocusDay: preserved.calendarFocusDay,
        calendarView: preserved.calendarView,
      });
    },
  );
});
