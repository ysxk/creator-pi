import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Agent browser calls act on the calling session's own page, on screen or
// not (D703). The CDP layer is a stub; one instance belongs to each page.
register(new URL("./helpers/browser-cdp-stub-hook.mjs", import.meta.url).href);
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserCdp } = await import("./helpers/browser-cdp-stub.mjs");

const settled = () => new Promise(setImmediate);
const unavailable = (pattern) => (error) => error?.code === "UNAVAILABLE" && pattern.test(error.message);

function harness() {
  const loads = [], opened = [], panes = [];
  const h = { holdLoads: false, loads, opened, panes };
  const createPane = (onState) => {
    let state = null;
    const wc = { isDestroyed: () => false };
    const pane = {
      visible: false, disposed: false,
      setWindow: () => {}, setBounds: () => {},
      setVisible(value) { this.visible = value; },
      getState: () => state,
      getWebContents: () => wc,
      invalidateNavigation: () => {},
      captureScreenshot: (run) => run(wc),
      navigateAndWait(target) {
        return new Promise((resolve) => {
          const finish = () => {
            state = { url: target, title: target, isLoading: false, canGoBack: false, canGoForward: false };
            onState(state); resolve(state);
          };
          loads.push({ target, pane, finish });
          if (!h.holdLoads) finish();
        });
      },
      dispose() { this.visible = false; this.disposed = true; },
    };
    panes.push(pane);
    return pane;
  };
  h.host = new BrowserHost({
    createPane, isPluginLoaded: () => true,
    getFileRoot: async (sessionId) => `/projects/${sessionId}`,
    onState: () => {},
    openTab: (sessionId, tabId, location) => opened.push({ sessionId, tabId, location }),
  });
  h.surface = (visible = true) => h.host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  h.surface();
  h.host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return h;
}

/** Show a session's tab the way the renderer does, and return its page's CDP. */
async function show(h, sessionId, tabId, location) {
  h.host.setChromeSession(sessionId, tabId, location);
  await settled(); await settled();
  return BrowserCdp.current;
}

test("BrowserPreview loads its tab in the calling session while another session is on screen", async () => {
  const h = harness();
  const cdpA = await show(h, "A", "a", "a.html");
  const preview = await h.host.previewWorkspaceFile("B", "preview.html");
  const cdpB = BrowserCdp.current;
  assert.deepEqual(preview, { ok: true });
  assert.notEqual(cdpB, cdpA);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].sessionId, "B");
  assert.match(h.opened[0].tabId, /^plugin:pi\.browser\/browser:agent-/);
  assert.deepEqual(h.opened[0].location, { path: "preview.html" });
  assert.equal(h.loads.at(-1).target, "preview.html");
  assert.equal(h.host.getState().url, "a.html", "the page on screen is untouched");
  assert.equal(h.loads.at(-1).pane.visible, false, "the background page stays off screen");

  assert.deepEqual(await h.host.evaluate("document.title", "B"), { expression: "document.title" });
  assert.equal((await h.host.snapshot("B")).tree, "fixture-tree");
  await h.host.screenshot({}, "B");
  await h.host.click("e1", "B");
  await h.host.fill("e2", "text", "B");
  await h.host.cdpCommand("Page.getLayoutMetrics", {}, "B");
  assert.deepEqual(cdpB.calls, ["evaluate", "snapshot", "screenshot", "click", "fill", "Page.getLayoutMetrics"]);
  assert.deepEqual(cdpA.calls, [], "no call reaches the visible session's page");
});

test("a session without its own page never reaches the page on screen", async () => {
  const h = harness();
  const cdpA = await show(h, "A", "a", "a.html");
  const none = unavailable(/no open Browser page/);
  await assert.rejects(h.host.evaluate("document.cookie", "B"), none);
  await assert.rejects(h.host.screenshot({}, "B"), none);
  await assert.rejects(h.host.snapshot("B"), none);
  await assert.rejects(h.host.click("e1", "B"), none);
  await assert.rejects(h.host.cdpCommand("Page.getLayoutMetrics", {}, "B"), none);
  assert.deepEqual(h.host.console(10, "B"), { messages: [] });
  assert.deepEqual(cdpA.calls, []);
});

test("agent calls keep working while the Browser view is hidden; calls without a session do not", async () => {
  const h = harness();
  await show(h, "A", "a", "a.html");
  h.surface(false);
  assert.deepEqual(await h.host.evaluate("1", "A"), { expression: "1" });
  await h.host.screenshot({}, "A");
  const state = await h.host.navigateForSession({ url: "https://fixture.invalid/next" }, "A");
  assert.equal(state.url, "https://fixture.invalid/next");
  await assert.rejects(h.host.evaluate("1"), unavailable(/must be visible/));
  await assert.rejects(h.host.screenshot(), unavailable(/must be visible/));
});

test("agent navigation opens a tab for a session without one and reuses it afterwards", async () => {
  const h = harness();
  await show(h, "A", "a", "a.html");
  await h.host.navigateForSession({ url: "https://fixture.invalid/one" }, "C");
  await h.host.navigateForSession({ url: "https://fixture.invalid/two" }, "C");
  assert.equal(h.opened.length, 1, "only the first navigation creates a tab");
  assert.deepEqual(h.opened[0].location, { url: "https://fixture.invalid/one" });
  const [first, second] = h.loads.slice(-2);
  assert.equal(first.pane, second.pane, "the second navigation reuses the session's page");
  assert.equal(second.target, "https://fixture.invalid/two");
  assert.equal(h.host.getState().url, "a.html");
});

test("the renderer adopts a host-created tab without loading it again", async () => {
  const h = harness();
  await show(h, "A", "a", "a.html");
  await h.host.previewWorkspaceFile("A", "preview.html");
  const loads = h.loads.length;
  await show(h, "A", h.opened[0].tabId, "preview.html");
  assert.equal(h.loads.length, loads, "showing the tab reuses the loaded page");
  assert.equal(h.host.getState().url, "preview.html");
  assert.equal(h.loads.at(-1).pane.visible, true);
  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "a.html", "the earlier tab keeps its own page");
});

test("a page that is still loading says so instead of acting on another page", async () => {
  const h = harness();
  const cdpA = await show(h, "A", "a", "a.html");
  h.holdLoads = true;
  const pending = h.host.navigateForSession({ url: "https://fixture.invalid/slow" }, "D");
  await settled(); await settled();
  await assert.rejects(h.host.evaluate("1", "D"), unavailable(/still loading/));
  h.loads.at(-1).finish();
  await pending;
  assert.deepEqual(await h.host.evaluate("1", "D"), { expression: "1" });
  assert.deepEqual(cdpA.calls, []);
});
