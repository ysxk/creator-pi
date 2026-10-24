import { readAppSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidecarSource = await readFile(
  new URL("../../../packages/host-runtime/src/agent-sidecar.ts", import.meta.url),
  "utf8",
);
const mainSource = await readMainSource();
const appSource = await readAppSource();
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const browserPluginSource = await readFile(
  new URL("../resources/plugins/pi.browser/main.js", import.meta.url),
  "utf8",
);

test("sidecar routes main-local tools before the host-core proxy", () => {
  // Local tools short-circuit tools.execute; other methods still proxy.
  assert.match(sidecarSource, /setLocalTool\(name: string, handler: LocalToolHandler\)/);
  assert.match(
    sidecarSource,
    /method === "tools\.execute"\s*\?\s*this\.localTools\.get/,
  );
  // Host availability is only required on the proxy path, after local
  // dispatch — a local tool must work even if host-core is restarting.
  const proxyBranch = sidecarSource.slice(
    sidecarSource.indexOf('msg.method === "host.proxy"'),
  );
  assert.ok(
    proxyBranch.indexOf("this.localTools.get") <
      proxyBranch.indexOf('throw new Error("host unavailable")'),
  );
});

test("main serves BrowserPreview from its originating session workspace", () => {
  assert.match(mainSource, /s\.setLocalTool\("BrowserPreview"/);
  // The local tool receives session identity from the sidecar and resolves the
  // workspace from that durable session, never from the visible shell project.
  const handler = mainSource.slice(
    mainSource.indexOf('s.setLocalTool("BrowserPreview"'),
    mainSource.indexOf("sidecar = s;"),
  );
  assert.match(handler, /async \(\{ args, sessionId \}\)/);
  assert.match(handler, /host\?\.call\("session\.get", \{ id: sessionId \}\)/);
  assert.match(handler, /res\?\.session\?\.projectPath/);
  assert.doesNotMatch(handler, /workspace\.get/);
  // The host creates and loads the session's own tab (D703) and lists it in
  // the renderer itself; the handler no longer asks the renderer to navigate.
  assert.match(handler, /await browserHost\.previewWorkspaceFile\(sessionId, raw\)/);
  assert.ok(
    handler.indexOf("resolveLocalFile(raw, root)") <
      handler.indexOf("browserHost.previewWorkspaceFile"),
  );
  assert.doesNotMatch(handler, /browserPane\.navigate/);
  assert.doesNotMatch(handler, /IPC\.event\.browserPreview/);
  assert.match(handler, /preview\.loadError/);
  assert.match(mainSource, /openTab: \(sessionId, tabId, location\) =>\s*sendToRenderer\(IPC\.event\.browserPreview, \{ sessionId, tabId, \.\.\.location \}\)/);
  assert.match(protocolSource, /browserPreview: "pi-desktop\/browser\/event\/preview"/);
});

test("renderer routes browser preview events to the originating session", () => {
  assert.match(
    apiSource,
    /onBrowserPreview:[\s\S]*event: \{ sessionId: string; path\?: string; url\?: string; tabId\?: string \}/,
  );
  const previewHandler =
    appSource.match(/api\.onBrowserPreview\([\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.ok(previewHandler, "browser preview renderer handler exists");
  assert.match(
    previewHandler,
    /openWorkPanelTabForSession\((?:event\.)?sessionId,[\s\S]*browserPluginTab/,
  );
  // A host-created tab keeps the id main gave it, so it maps to the page main
  // already loaded (D703).
  assert.match(previewHandler, /event\.tabId \? \{ id: event\.tabId \} : \{\}/);
  assert.doesNotMatch(
    appSource,
    /api\.onBrowserPreview\(\(\) => \{\s*useAppStore\.getState\(\)\.openWorkPanelTab/,
  );
  assert.match(appSource, /offBrowserPreview\(\);/);
});

test("agent runtime exposes BrowserPreview in every mode and prompts for it", () => {
  // The complete registry includes BrowserPreview even though the active
  // provider context may defer its schema until ToolSearch activates it.
  const builderStart = runtimeSource.indexOf("const tools =");
  const builderEnd = runtimeSource.indexOf(
    "const builtins = tools.map(exec)",
    builderStart,
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  assert.match(runtimeSource.slice(builderStart, builderEnd), /"BrowserPreview"/);
  // `path` carries an alias alongside it (D273), so assert the entry and its
  // canonical argument rather than one exact line of source.
  assert.match(
    runtimeSource,
    /BrowserPreview: \{\s*path: pathParam\([^)]*\),\s*file_path: aliasParam\("path"\),\s*\}/,
  );
  // BrowserPreview tool description mentions live-reload behaviour.
  assert.match(runtimeSource, /live-reloads/);
});

test("Browser tool prompt works on the session's own tab without asking for the panel", () => {
  assert.match(
    browserPluginSource,
    /Every action works on this session's own Browser tab, whether or not the user is viewing it/,
  );
  assert.match(browserPluginSource, /do not ask the user to open the Browser panel/);
  assert.match(
    browserPluginSource,
    /For a workspace HTML file, call BrowserPreview first; it opens and loads a Browser tab for this session/,
  );
  assert.match(
    browserPluginSource,
    /For other URLs, use action=navigate; it loads in this session's Browser tab, or opens one/,
  );
  assert.doesNotMatch(browserPluginSource, /ensure the Browser view is open and visible/);
  assert.doesNotMatch(browserPluginSource, /ask the user to open it and wait/);
});
