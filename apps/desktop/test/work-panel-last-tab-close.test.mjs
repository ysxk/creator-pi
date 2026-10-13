import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");

function resetStore() {
  useAppStore.setState({
    activeSessionId: "s1",
    workPanelOpen: false,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
    workPanelContexts: {},
  });
}

const panel = () => {
  const state = useAppStore.getState();
  return {
    open: state.workPanelOpen,
    tabs: state.workPanelTabs.map((tab) => tab.id),
    saved: state.workPanelContexts.s1,
  };
};

test("closing the only preview closes the panel that opened for it", () => {
  resetStore();
  useAppStore.getState().openFileInWorkPanel("src/App.tsx");
  assert.deepEqual([panel().open, panel().tabs], [true, ["file:src/App.tsx"]]);

  useAppStore.getState().closeWorkPanelTab("file:src/App.tsx");
  assert.deepEqual([panel().open, panel().tabs], [false, []]);
  // The session's own record closes too, or switching away and back would
  // bring the empty panel back.
  assert.equal(panel().saved.open, false);
  assert.deepEqual(panel().saved.tabs, []);
});

test("the panel stays while another tab is left, then leaves with the last one", () => {
  resetStore();
  useAppStore.getState().openFileInWorkPanel("a.md");
  useAppStore.getState().openFileInWorkPanel("b.md");

  useAppStore.getState().closeWorkPanelTab("file:a.md");
  assert.deepEqual([panel().open, panel().tabs], [true, ["file:b.md"]]);
  assert.equal(panel().saved.open, true);

  useAppStore.getState().closeWorkPanelTab("file:b.md");
  assert.equal(panel().open, false);
});

test("a panel opened by hand still shows the New launcher, and a New tab closes it", () => {
  resetStore();
  useAppStore.getState().openWorkPanel();
  assert.deepEqual([panel().open, panel().tabs], [true, []]);

  // Nothing to close: the empty panel is what the user asked for.
  useAppStore.getState().closeWorkPanelTab("file:missing.md");
  assert.equal(panel().open, true);

  useAppStore.getState().openNewWorkPanelTab();
  const [newTab] = panel().tabs;
  useAppStore.getState().closeWorkPanelTab(newTab);
  assert.deepEqual([panel().open, panel().tabs], [false, []]);

  // Reopening lands on the launcher again rather than restoring a tab.
  useAppStore.getState().toggleWorkPanel();
  assert.deepEqual([panel().open, panel().tabs], [true, []]);
});
