#!/usr/bin/env node
/** Refresh the production host file viewer and tree after agent tool calls end. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repositoryRoot } from "./e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-files-tab-auto-refresh-"));
const server = createServer(async (request, response) => {
  const assets = { "/": ["index.html", "text/html"], "/renderer.js": ["renderer.js", "text/javascript"], "/work-panel.css": ["work-panel.css", "text/css"] };
  const asset = assets[request.url];
  if (!asset) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(temp, asset[0]));
    response.writeHead(200, { "Content-Type": asset[1] }).end(body);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/files-tab-auto-refresh.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: dirname(desktopRequire.resolve("react/package.json")),
      "react-dom": dirname(desktopRequire.resolve("react-dom/package.json")),
    },
    nodePaths: desktopRequire.resolve.paths("react"),
  });
  const viewerStyles = await readFile(join(root, "apps/desktop/src/styles/work-panel.css"), "utf8");
  const transcriptStyles = await readFile(join(root, "apps/desktop/src/styles/chat-shell.css"), "utf8");
  await writeFile(join(temp, "work-panel.css"), `${viewerStyles}\n${transcriptStyles}\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}`);
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="work-panel.css"><div id="root"></div><script src="renderer.js"></script>',
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.disableHardwareAcceleration();
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 420,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadURL(${JSON.stringify(url)});
    const result = await window.webContents.executeJavaScript("window.filesTabAutoRefreshProbe()");
    console.log("FILES_TAB_AUTO_REFRESH " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("FILES_TAB_AUTO_REFRESH " + (error?.stack ?? String(error)));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopRequire("electron"), [
    "--headless=new",
    "--disable-gpu",
    join(temp, "main.cjs"),
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output += chunk; });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((item) => item.startsWith("FILES_TAB_AUTO_REFRESH {"));
  assert(line, `renderer returned no auto-refresh result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("FILES_TAB_AUTO_REFRESH ".length));
  console.log(line);
  assert.equal(code, 0, output.slice(-4000));
  assert.deepEqual(result.browserErrors, [], "browser reports no uncaught errors or rejections");
  assert.deepEqual(result.transcript, { ordinaryReturn: true, runningPreserved: true, freshSearch: true });
  assert.equal(result.initialReadsWhileHeld, 1, "initial open and automatic refresh share read ownership");
  assert.equal(result.initialSwitchSafe, true, "an initial read cannot overwrite another file");
  assert.equal(result.workspaceSafe, true, "workspace changes discard old reads and pending refreshes");
  assert.equal(result.directorySwitchSafe, true, "returning to the same workspace cannot revive an obsolete directory response");
  assert.equal(result.unmountSafe, true, "unmount releases listeners, timers, and trailing refreshes");
  assert.equal(result.overlap.newestVisible, true, "an older same-file response cannot overwrite the newer tool result");
  assert.equal(result.overlap.readsWhileHeld, 1, "same-file refreshes are single-flight with a trailing read");
  assert.equal(result.readsAfterMessage, 0, "a non-tool agent event must not re-read the file");
  assert.deepEqual(result.editRefresh.reads, ["target.txt"], "a burst of tool calls re-reads the open file once");
  assert.deepEqual(result.editRefresh.lists, [""], "a burst of tool calls re-lists each loaded folder once");
  assert.equal(result.editRefresh.scrollTop, 0, "a refresh keeps the user's scroll position");
  assert.equal(result.editRefresh.lineJumps, 1, "a refresh does not repeat the requested line jump");
  assert.deepEqual(result.treeAfterBack, ["notes.txt", "target.txt", "added.txt"]);
  assert.equal(result.viewerPath, "notes.txt");
  assert.equal(result.viewerShowsNotes, true);
  assert.equal(result.viewerShowsStale, false, "a re-read for a file no longer open must not land");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
