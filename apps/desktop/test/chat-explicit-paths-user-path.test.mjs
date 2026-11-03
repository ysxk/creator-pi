import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "../../../scripts/e2e/hosted-search-sidecar.mjs";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const root = resolve(desktop, "../..");
const require = createRequire(join(desktop, "package.json"));
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveChatFileRef } = await import("../electron/main/chat-ref-resolve.ts");

function wav(sample) {
  const bytes = Buffer.alloc(60);
  bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(sample, i);
  return bytes;
}

test("chat renders only path-qualified inferred files and keeps explicit destinations usable", {
  timeout: 60000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron UI test requires a display" : false,
}, async () => {
  const fixture = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "chat-explicit-paths-"));
  const workspace = join(fixture, "workspace");
  const reference = "worker/10.27-omni-model/audio/voiceover.wav";
  const oldReference = "worker/10.13-old/audio/voiceover.wav";
  const snippets = {
    bare: "文件 `素材清单.md` 与 `voiceover.wav`、`shot.png`、`clip.mp4`。",
    table: "已保存到 `worker/10.27-omni-model/audio/`。\n\n| 路径 | 说明 |\n| --- | --- |\n| `worker/10.27-omni-model/subtitle/words.json` | 对应 `voiceover.wav` |",
    full: "音频：`" + reference + "`",
    explicit: "[`voiceover.wav`](" + reference + ")",
    dot: "`./voiceover.wav`",
  };
  for (const [path, sample] of [[reference, 5678], [oldReference, 1234], ["voiceover.wav", 9012]]) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), wav(sample));
  }
  const lookups = [];
  const server = createServer((req, res) => { void (async () => {
    if (req.url === "/resolve") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const args = JSON.parse(Buffer.concat(chunks).toString());
      lookups.push(args.ref);
      const match = await resolveChatFileRef(args.ref, { project: [{ path: workspace, name: "fixture", primary: true }] });
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ match })); return;
    }
    const name = req.url?.split("?")[0] === "/" ? "index.html" : req.url?.split("?")[0]?.slice(1);
    if (!name || name.includes("/") || name.includes("..")) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src pi-media:; font-src 'self' data:");
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(join(fixture, name)));
  })().catch((error) => { res.writeHead(500).end(String(error)); }); });
  let child;
  try {
    const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "@pi-desktop/i18n/locales/en";
import { flattenCatalog } from "@pi-desktop/i18n/locale-info";
import { ChatMarkdown } from "./apps/desktop/src/features/chat/transcript/ChatMarkdown";
import { useAppStore } from "./apps/desktop/src/stores/app-store";
const calls = [], pending = new Set();
window.piDesktop = { on() { return () => {}; }, async invoke(channel, ...args) {
  calls.push({ channel, args });
  if (channel.endsWith('/fs/resolveRef')) {
    const request = fetch('/resolve', {method:'POST',body:JSON.stringify(args[0])}).then(response => response.json());
    pending.add(request); try { return {ok:true,data:await request}; } finally { pending.delete(request); }
  }
  if (channel.endsWith('/plugins/views')) return {ok:true,data:[]};
  if (channel.endsWith('/plugins/list')) return {ok:true,data:{plugins:[]}};
  throw Error('Unexpected fixture IPC: '+channel);
} };
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
(async () => {
  await i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:flattenCatalog(en)}},interpolation:{escapeValue:false}});
  useAppStore.setState({workspace:{path:${JSON.stringify(workspace)},name:'fixture'}, activeSessionId:'synthetic-session', openFileInWorkPanel:path=>{window.opened=path;}});
  const root = createRoot(document.getElementById('root'));
  let version=0;
  window.renderSource = async (source, remount=false) => {
    if(remount)version++;
    flushSync(()=>root.render(<div className="prose-chat"><ChatMarkdown key={version} source={source}/></div>));
    await frame(); await Promise.all([...pending]); await frame();
    return {lookups:calls.filter(call=>call.channel.endsWith('/fs/resolveRef')).length, interactive:document.querySelectorAll('#root a,#root .chat-code-link').length, media:document.querySelectorAll('#root .chat-media-mention,#root .chat-media-thumb').length, code:[...document.querySelectorAll('#root code')].map(node=>node.textContent)};
  };
  window.dispatchEvent(new Event('fixture-ready'));
})();
`;
    await require("esbuild").build({ stdin: { contents: source, loader: "tsx", resolveDir: root }, outfile: join(fixture, "renderer.js"),
      bundle: true, platform: "browser", format: "esm", jsx: "automatic", nodePaths: [join(desktop, "node_modules")],
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      plugins: [{ name: "url-assets", setup(build) {
        build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path.slice(0, -4)), namespace: "asset" }));
        build.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
      } }], logLevel: "silent" });
    await writeFile(join(fixture, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const main = `
const assert = require('node:assert/strict');
const {app,BrowserWindow,protocol} = require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(join(fixture, "profile"))});
protocol.registerSchemesAsPrivileged([{scheme:'pi-media',privileges:{standard:true,secure:true,stream:true}}]);
app.commandLine.appendSwitch('autoplay-policy','user-gesture-required');
app.whenReady().then(async()=>{
 const reads=[];
 protocol.handle('pi-media',request=>{
  const file=decodeURIComponent(new URL(request.url).pathname.slice(1));
  const rel=path.relative(${JSON.stringify(workspace)},file);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))return new Response(null,{status:403});
  const bytes=fs.readFileSync(file);reads.push({rel,sample:bytes.readInt16LE(44)});
  return new Response(bytes,{headers:{'content-type':'audio/wav'}});
 });
 const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)&&!details.url.startsWith(${JSON.stringify(origin)})}));
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
 try {
  await win.loadURL(${JSON.stringify(origin)});
  const result=await win.webContents.executeJavaScript(${JSON.stringify(`(async()=>{
    if(!window.renderSource)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture readiness')),10000);window.addEventListener('fixture-ready',()=>{clearTimeout(timer);resolve();},{once:true});});
    const bare=${JSON.stringify(snippets.bare)};
    const plain=await renderSource(bare);
    const table=await renderSource(${JSON.stringify(snippets.table)});
    const full=await renderSource(${JSON.stringify(snippets.full)});
    const audio=document.querySelector('audio');if(!audio)throw Error('full path player missing');
    await new Promise((resolve,reject)=>{if(audio.readyState>=1)return resolve();const timer=setTimeout(()=>reject(Error('media metadata')),10000);audio.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});});
    const src=audio.getAttribute('src');
    const later=await renderSource(bare,true);
    const explicit=await renderSource(${JSON.stringify(snippets.explicit)});
    document.querySelector('#root a').click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const dot=await renderSource(${JSON.stringify(snippets.dot)});
    return {plain,table,full,later,explicit,dot,src,opened:window.opened};
  })()`)});
  console.log('PROBE '+JSON.stringify(result));
  assert.equal(result.plain.interactive,0);assert.equal(result.plain.media,0);assert.equal(result.plain.lookups,0);
  assert.ok(result.plain.code.includes('素材清单.md'));assert.ok(result.plain.code.includes('voiceover.wav'));
  assert.equal(result.table.media,0);assert.equal(result.table.lookups,0);
  assert.equal(result.full.media,1);assert.equal(decodeURIComponent(new URL(result.src).pathname.slice(1)),${JSON.stringify(join(workspace, reference))});
  assert.equal(result.later.interactive,0);assert.equal(result.later.media,0);assert.equal(result.later.lookups,result.full.lookups);
  assert.equal(result.explicit.media,1);assert.ok(result.explicit.interactive>0);assert.equal(result.opened,${JSON.stringify(reference)});
  assert.equal(result.dot.media,1);
  assert.ok(reads.some(read=>read.rel===${JSON.stringify(reference)}&&read.sample===5678));
  assert.ok(!reads.some(read=>read.rel===${JSON.stringify(oldReference)}));
  console.log('EXPLICIT_PATHS_RESULT '+JSON.stringify(result));app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
`;
    await writeFile(join(fixture, "main.cjs"), main);
    const env = await isolatedEnv(fixture);
    for (const key of ["DISPLAY", "XAUTHORITY"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    child = spawn(resolveElectronBinary(root).electronBinary, [join(fixture, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    assert.match(output, /EXPLICIT_PATHS_RESULT/);
    assert.ok(lookups.slice(0, -1).every((ref) => resolve(workspace, ref) === join(workspace, reference)), "only the qualified target is resolved before the explicit dot-relative scene");
    assert.equal(lookups.at(-1), "voiceover.wav", "./voiceover.wav retains its workspace-root target");
  } finally {
    if (child?.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
