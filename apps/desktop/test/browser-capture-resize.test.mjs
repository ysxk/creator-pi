import assert from "node:assert/strict";
import { once } from "node:events";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Only Electron is replaced: exercise the production Host, Pane and CDP path.
// Chromium restores the viewport saved when capture starts, even if a native
// bounds update arrives before capture finishes.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class WebContentsView {
    static instances = [];
    constructor() {
      const wc = Object.assign(new EventEmitter(), {
        id: WebContentsView.instances.length + 1,
        url: "", destroyed: false, viewport: { width: 0, height: 0 },
        captures: [],
        layoutSize: { width: 800, height: 6000 },
        async loadURL(url) {
          this.emit("did-start-navigation", {}, url, false, true);
          this.url = url;
          this.emit("did-navigate", {}, url);
        },
        getURL() { return this.url; },
        getTitle: () => "fixture", isLoading: () => false,
        isDestroyed() { return this.destroyed; },
        close() { this.destroyed = true; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      wc.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        async sendCommand(method, params) {
          if (method === "Page.getLayoutMetrics") {
            return { cssContentSize: { ...wc.layoutSize } };
          }
          if (method !== "Page.captureScreenshot") return {};
          const savedViewport = { ...wc.viewport };
          let resolve, reject;
          const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
          wc.captures.push({ params, resolve, reject });
          wc.emit("capture-start");
          try {
            await pending;
            return { data: "fixture-image" };
          } finally { wc.viewport = savedViewport; }
        },
      });
      this.webContents = wc;
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.webContents.viewport = { width: bounds.width, height: bounds.height };
    }
    setVisible() {}
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView } = await import("electron");

async function harness(t) {
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => new BrowserPane(onState, onOpenUrl),
    isPluginLoaded: () => true, getFileRoot: async () => null, onState: () => {},
  });
  const children = [];
  const window = { minimized: false };
  host.setWindow({ isDestroyed: () => false, isMinimized: () => window.minimized, contentView: {
    children,
    addChildView(view) { children.push(view); },
    removeChildView(view) { children.splice(children.indexOf(view), 1); },
  } });
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 0, y: 0, width: 1200, height: 900 } });
  const resize = (width, height) => host.setGuestHole("pi.browser", { x: 0, y: 0, width, height });
  resize(800, 500);
  host.setChromeSession("session", "first");
  await host.navigate({ url: "https://fixture.invalid/first" }, "session");
  t.after(() => host.dispose());
  return { host, resize, window, children, view: WebContentsView.instances.at(-1),
    wc: WebContentsView.instances.at(-1).webContents };
}

test("a capture lifts the guest off a minimized window and puts it back", async (t) => {
  const { host, window, children, view, wc } = await harness(t);
  assert.ok(children.includes(view));
  window.minimized = true;
  const started = once(wc, "capture-start");
  const capture = host.screenshot();
  await started;
  assert.equal(children.includes(view), false, "a minimized window gives an attached view no frame");
  wc.captures.at(-1).resolve();
  await capture;
  assert.equal(children.at(-1), view, "the guest returns on top of the plugin chrome");
});

test("a page opened off screen gets a real viewport before its first capture", async (t) => {
  const { host } = await harness(t);
  // The panel showed a guest at 800×500, so a background session's first
  // page lays out at that size instead of 0×0, which never answers a capture.
  await host.navigateForSession({ url: "https://fixture.invalid/background" }, "other-session");
  const background = WebContentsView.instances.at(-1).webContents;
  assert.deepEqual(background.viewport, { width: 800, height: 500 });
  const started = once(background, "capture-start");
  const capture = host.screenshot({}, "other-session");
  await started;
  background.captures.at(-1).resolve();
  await capture;

  const cold = new BrowserHost({
    createPane: (onState, onOpenUrl) => new BrowserPane(onState, onOpenUrl),
    isPluginLoaded: () => true, getFileRoot: async () => null, onState: () => {},
  });
  t.after(() => cold.dispose());
  await cold.navigateForSession({ url: "https://fixture.invalid/cold" }, "cold-session");
  assert.deepEqual(WebContentsView.instances.at(-1).webContents.viewport, { width: 1280, height: 800 },
    "with no panel size known yet, a background page uses the default viewport");
});

test("full-page screenshot scales both dimensions to provider-safe limits", async (t) => {
  const { host, wc } = await harness(t);
  for (const [layoutSize, expectedScale] of [
    [{ width: 800, height: 6000 }, 2048 / 6000],
    [{ width: 4000, height: 6000 }, 1280 / 4000],
  ]) {
    wc.layoutSize = layoutSize;
    const started = once(wc, "capture-start");
    const capture = host.screenshot({ fullPage: true });
    await started;
    assert.deepEqual(wc.captures.at(-1).params.clip, {
      x: 0,
      y: 0,
      width: layoutSize.width,
      height: layoutSize.height,
      scale: expectedScale,
    });
    wc.captures.at(-1).resolve();
    await capture;
  }
});

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} restores the latest panel size`, async (t) => {
    const { host, resize, wc } = await harness(t);
    const started = once(wc, "capture-start");
    const request = raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot({ fullPage: true });
    await started;
    resize(910, 590);
    resize(960, 620);
    wc.captures[0].resolve();
    await request;
    assert.deepEqual(wc.viewport, { width: 960, height: 620 });
    assert.equal(wc.captures.length, 1, "resizing must not repeat the screenshot");
  });
}

test("a failed capture releases resizing and does not poison the next capture", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const failed = assert.rejects(host.screenshot(), /fixture capture failure/);
  await started;
  resize(940, 600);
  wc.captures[0].reject(new Error("fixture capture failure"));
  await failed;
  assert.deepEqual(wc.viewport, { width: 940, height: 600 });
  const nextStarted = once(wc, "capture-start");
  const next = host.screenshot();
  await nextStarted;
  wc.captures[1].resolve();
  assert.equal((await next).data, "fixture-image");
});

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} timeout releases the queue for the next capture`, async (t) => {
    const { host, wc } = await harness(t);
    const capture = () => raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot();
    const setTimeout = globalThis.setTimeout;
    let expire;
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.equal(delay, 30_000);
      expire = () => callback(...args);
      return 1;
    };
    t.after(() => { globalThis.setTimeout = setTimeout; });
    const failed = assert.rejects(
      capture(),
      (error) => {
        assert.match(error.message, /browser screenshot timed out after 30000ms/);
        assert.equal(error.code, "TIMEOUT");
        return true;
      },
    );
    await once(wc, "capture-start");
    expire();

    await failed;
    assert.equal(wc.debugger.isAttached(), false, "detach the stalled CDP session");
    wc.captures[0].reject(new Error("debugger detached"));
    const nextStarted = once(wc, "capture-start");
    const next = capture();
    await nextStarted;
    wc.captures[1].resolve();
    assert.equal((await next).data, "fixture-image");
  });
}

test("overlapping capture APIs serialize per page, not across sibling tabs", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const nextStarted = once(wc, "capture-start");
  const next = host.cdpCommand("Page.captureScreenshot", { format: "png" });
  host.setChromeSession("session", "second");
  await host.navigate({ url: "https://fixture.invalid/second" }, "session");
  const sibling = WebContentsView.instances.at(-1).webContents;
  const siblingStarted = once(sibling, "capture-start");
  const siblingShot = host.screenshot();
  await siblingStarted;
  assert.equal(wc.captures.length, 1, "the first page must not capture concurrently");
  sibling.captures[0].resolve();
  await siblingShot;
  wc.captures[0].resolve();
  await first;
  await nextStarted;
  assert.equal(wc.captures.length, 2, "queued capture must retain its original page");
  host.setChromeSession("session", "first");
  resize(920, 610);
  wc.captures[1].resolve();
  await next;
  assert.deepEqual(wc.viewport, { width: 920, height: 610 });
  assert.equal(sibling.captures.length, 1);
});

test("closing a tab rejects its queued capture without capturing a replacement", async (t) => {
  const { host, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const queued = assert.rejects(host.screenshot(), /browser guest is not available/);
  host.closeTab("session", "first");
  host.setChromeSession("session", "replacement");
  await host.navigate({ url: "https://fixture.invalid/replacement" }, "session");
  wc.captures[0].resolve();
  await first;
  await queued;
  assert.equal(wc.captures.length, 1);
  assert.equal(WebContentsView.instances.at(-1).webContents.captures.length, 0);
});
