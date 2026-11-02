import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const require = createRequire(join(desktop, "package.json"));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { resolveChatFileRef } = await import("../electron/main/chat-ref-resolve.ts");

function wav(sample) {
  const data = Buffer.alloc(60);
  data.write("RIFF"); data.writeUInt32LE(52, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(16, 40);
  for (let i = 44; i < 60; i += 2) data.writeInt16LE(sample, i);
  return data;
}

test("a named audio preview follows generated exact files and the opener across remounts", {
  timeout: 60000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron UI test requires a display" : false,
}, async () => {
  const fixture = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "audio-path-fix-ui-"));
  const workspace = join(fixture, "workspace");
  const oldRef = "worker/old/audio/voiceover.wav";
  const ref = "worker/new/audio/voiceover.wav";
  const shortRef = "short/clip.wav";
  const suffixRef = "prefix/short/clip.wav";
  function write(ref, sample) {
    const file = join(workspace, ref);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, wav(sample));
  }
  write(oldRef, 1234);
  write(suffixRef, 1111);
  const roots = { project: [{ path: workspace, name: "fixture", primary: true }] };
  const server = createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("Content-Security-Policy", "default-src 'self'; media-src pi-media:"); res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(fixture, "bundle.js"))); return; }
    if (req.url === "/create") { write(ref, 5678); res.end("ok"); return; }
    if (req.url === "/create-short") { write(shortRef, 2222); res.end("ok"); return; }
    if (req.url === "/resolve") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { ref: path } = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ match: await resolveChatFileRef(path, roots) }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const entry = join(fixture, "entry.tsx");
  writeFileSync(entry, `
import React, { useState } from ${JSON.stringify(require.resolve("react"))};
import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
import { MentionedMedia, MarkdownChatMediaContext, useOpenReplyFileRef } from ${JSON.stringify(join(desktop, "src/components/MarkdownChatMedia.tsx"))};
import { useAppStore } from ${JSON.stringify(join(desktop, "src/stores/app-store.ts"))};
const workspace = ${JSON.stringify(workspace)}, ref = ${JSON.stringify(ref)}, oldRef = ${JSON.stringify(oldRef)}, shortRef = ${JSON.stringify(shortRef)};
window.piDesktop = { invoke: async (channel, args) => {
  if (channel.endsWith('/fs/resolveRef')) { const data = await (await fetch('/resolve', {method:'POST', body:JSON.stringify(args)})).json(); window.lookupFinished = true; return {ok:true,data}; }
  if (channel.endsWith('/plugins/views')) return {ok:true,data:[]};
  if (channel.endsWith('/plugins/list')) return {ok:true,data:{plugins:[]}};
  throw Error('unexpected IPC: '+channel);
}};
useAppStore.setState({ workspace: {path: workspace, name:'fixture'}, activeSessionId: 'fixture-session', openFileInWorkPanel: path => { window.openedPath = path; }, showToast: () => { window.missingReported = true; } });
const claims = new Map();
const media = { folders: [], openImage() {}, claim(file, owner) {if(claims.has(file)) return false; claims.set(file, owner); return true;}, release(file, owner) {if(claims.get(file)===owner) claims.delete(file);} };
function App() {
  return <MarkdownChatMediaContext.Provider value={media}><Content /></MarkdownChatMediaContext.Provider>;
}
function Content() {
  const [version, setVersion] = useState(0);
  const [both, setBoth] = useState(false);
  const [short, setShort] = useState(false);
  const open = useOpenReplyFileRef();
  return <>
    <button id="remount" onClick={() => setVersion(version+1)}>remount</button>
    <button id="both" onClick={() => setBoth(true)}>both</button>
    <button id="open" onClick={e => open(ref, '', e.currentTarget)}>open</button>
    <button id="short" onClick={() => setShort(true)}>short</button>
    <button id="open-short" onClick={e => open(shortRef, '', e.currentTarget)}>open short</button>
    <MentionedMedia key={version} path={ref} kind="audio" baseDir="" />
    {both && <MentionedMedia path={oldRef} kind="audio" baseDir="" />}
    {short && <MentionedMedia path={shortRef} kind="audio" baseDir="" />}
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
`);
  const bundle = join(fixture, "bundle.js");
  try {
    await require("esbuild").build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "browser", format: "iife", nodePaths: [join(desktop, "node_modules")], logLevel: "silent" });
    const main = join(fixture, "electron.cjs");
    writeFileSync(main, `
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', ${JSON.stringify(join(fixture, "profile"))});
protocol.registerSchemesAsPrivileged([{scheme:'pi-media', privileges:{standard:true, secure:true, stream:true}}]);
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');
app.whenReady().then(async () => {
 protocol.handle('pi-media', request => {
   const file = decodeURIComponent(new URL(request.url).pathname.slice(1));
   const relative = path.relative(${JSON.stringify(workspace)}, file);
   if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, {status:403});
   try { const bytes = fs.readFileSync(file); console.log('SAMPLE:'+bytes.readInt16LE(44)); return new Response(bytes, {headers:{'content-type':'audio/wav'}}); } catch { return new Response(null, {status:404}); }
 });
 const win = new BrowserWindow({ show:false, webPreferences:{sandbox:true, contextIsolation:true} });
 win.webContents.on('console-message', (_e, _level, message) => console.log('renderer:',message));
 await win.loadURL('http://127.0.0.1:${port}/');
 try {
  const result = await win.webContents.executeJavaScript(${JSON.stringify(`(async () => {
    const until = async (fn, name) => { for (let i=0;i<150;i++) { const value=fn(); if(value) return value; await new Promise(r=>setTimeout(r,100)); } throw Error('timeout: '+name); };
    await until(()=>document.querySelector('#open'), 'mount');
    await until(()=>window.lookupFinished, 'missing lookup');
    if(document.querySelector('audio')) throw Error('missing target rendered audio');
    document.querySelector('#open').click();
    await until(()=>window.missingReported, 'missing workbench report');
    if (window.openedPath) throw Error('missing target opened a file');
    await fetch('/create');
    const audio = await until(()=>document.querySelector('audio'), 'generated target');
    const first = audio.getAttribute('src');
    document.querySelector('#remount').click();
    await until(()=>document.querySelector('audio') && document.querySelector('audio') !== audio, 'remount');
    const second = document.querySelector('audio').getAttribute('src');
    document.querySelector('#open').click();
    const opened = await until(()=>window.openedPath, 'open workbench');
    document.querySelector('#both').click();
    await until(()=>document.querySelectorAll('audio').length === 2, 'both');
    await until(()=>Array.from(document.querySelectorAll('audio')).every(a => a.readyState >= 1), 'media metadata');
    document.querySelector('#short').click();
    const suffix = await until(()=>Array.from(document.querySelectorAll('audio')).find(a => decodeURIComponent(a.getAttribute('src')).endsWith('/prefix/short/clip.wav')), 'full suffix');
    const suffixSrc = suffix.getAttribute('src');
    window.openedPath = null;
    document.querySelector('#open-short').click();
    const openedSuffix = await until(()=>window.openedPath, 'open suffix');
    await fetch('/create-short');
    await until(()=>Array.from(document.querySelectorAll('audio')).find(a => decodeURIComponent(a.getAttribute('src')).endsWith('/short/clip.wav') && !decodeURIComponent(a.getAttribute('src')).endsWith('/prefix/short/clip.wav')), 'exact replacing suffix');
    return {first, second, opened, openedSuffix, suffix: suffixSrc, sources:Array.from(document.querySelectorAll('audio'), a=>a.getAttribute('src'))};
  })()`)});
  console.log('RESULT:'+JSON.stringify(result)); app.exit(0);
 } catch(error) {console.error(error.stack); app.exit(1);}
});
`);
    const electron = require("electron");
    const output = await new Promise((resolve, reject) => {
      const child = spawn(electron, [main], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(text) : reject(new Error(`Electron exit ${code}: ${text}`)));
    });
    const result = JSON.parse(output.match(/RESULT:(.*)/)?.[1] ?? "null");
    const { parseMediaViewUrl } = await import("@pi-desktop/shared");
    assert.match(output, /SAMPLE:5678/);
    assert.equal(result.openedSuffix, suffixRef);
    assert.equal(parseMediaViewUrl(result.suffix), join(workspace, suffixRef));
    assert.match(output, /SAMPLE:1234/);
    assert.equal(parseMediaViewUrl(result.first), join(workspace, ref));
    assert.deepEqual(new Set(result.sources.map(parseMediaViewUrl)), new Set([join(workspace, ref), join(workspace, oldRef), join(workspace, shortRef)]));
    assert.equal(result.opened, ref);
    assert.equal(parseMediaViewUrl(result.second), join(workspace, ref));
  } finally {
    server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
