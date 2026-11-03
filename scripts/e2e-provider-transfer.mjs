#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { isolatedEnv } from "./e2e/hosted-search-sidecar.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-channel-transfer-e2e-"));
const nodePaths = [join(root, "apps/desktop/node_modules")];
await build({ entryPoints: [join(root, "scripts/e2e/provider-transfer-ui.jsx")], outfile: join(directory, "renderer.js"), bundle: true,
  platform: "browser", format: "esm", jsx: "automatic", nodePaths,
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  plugins: [{ name: "fixture-url-assets", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path.slice(0, -4)), namespace: "fixture-url" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
  } }],
});
await build({ entryPoints: [join(root, "scripts/e2e/provider-transfer-main.mjs")], outfile: join(directory, "main.mjs"), bundle: true,
  platform: "node", format: "esm", external: ["electron"], nodePaths });
await build({ entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")], outfile: join(directory, "preload.cjs"), bundle: true,
  platform: "node", format: "cjs", external: ["electron"], nodePaths });
const renderer = join(root, "apps/desktop/out/renderer");
const html = await readFile(join(renderer, "index.html"), "utf8");
const styles = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
assert.ok(styles.length, "Build the desktop renderer before running this suite");
await symlink(join(renderer, "assets"), join(directory, "assets"), "dir");
await writeFile(join(directory, "index.html"), `<!doctype html><html data-theme="dark" data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
const env = { ...await isolatedEnv(directory), PI_TRANSFER_FIXTURE: directory, PI_DESKTOP_HOST_BIN: resolveHostBinary() };
for (const key of ["DISPLAY", "XAUTHORITY"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const child = spawn(resolveElectronBinary(root).electronBinary, [join(directory, "main.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
let code;
try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
finally { clearTimeout(timer); }
await writeFile(join(directory, "run.log"), output);
assert.equal(code, 0, output);
const result = output.split(/\r?\n/).find((line) => line.startsWith("CHANNEL_TRANSFER_E2E "));
assert.ok(result, output);
console.log(result);
console.log(`Artifacts: ${directory}`);
