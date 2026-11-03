#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OfflineSidecar } from "./e2e/hosted-search-sidecar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarPath = join(root, "packages/agent-runtime/dist/sidecar.js");
await readFile(sidecarPath);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-native-search-e2e-"));
let sidecar;

function transcript(id, cwd, text) {
  return [
    { type: "session", version: 3, id, timestamp: "2026-09-14T00:00:00.000Z", cwd },
    { type: "message", id: "user", parentId: null, timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

try {
  const sessions = join(temp, "home/.pi/agent/sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "one.jsonl");
  const original = transcript("one", temp, "alpha 中文 needle");
  await writeFile(file, original);
  const bootstrap = join(temp, "offline.mjs");
  await writeFile(bootstrap, `
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
const deny = () => { throw new Error("Network forbidden in native search E2E"); };
globalThis.fetch = deny;
net.connect = net.createConnection = tls.connect = deny;
http.request = http.get = https.request = https.get = deny;
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(sidecarPath).href)});
`);
  sidecar = await OfflineSidecar.start(bootstrap, temp, (method) => {
    throw new Error(`Unexpected Host RPC: ${method}`);
  }, 15_000);

  const search = (query) => sidecar.call("native.session.search", { query });
  const first = await search("中文");
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].messageCount, 1);
  assert.equal(first.hits[0].matches[0].messageId, "user");
  assert.deepEqual(await search("中文"), first);
  const listed = await sidecar.call("native.session.list");
  assert.equal(listed.sessions[0].id, first.hits[0].session.id);
  const selected = await sidecar.call("native.session.get", {
    id: first.hits[0].session.id, messageAround: "user", messageLimit: 1,
  });
  assert.equal(selected.session.messages[0].content, "alpha 中文 needle");
  assert.equal(await readFile(file, "utf8"), original);

  await appendFile(file, JSON.stringify({
    type: "message", id: "later", parentId: "user", timestamp: "2026-09-14T00:00:02.000Z",
    message: { role: "user", content: "fresh needle", timestamp: 2 },
  }) + "\n");
  const fresh = await search("fresh");
  assert.equal(fresh.hits[0].matches[0].messageId, "later");
  assert.equal((await search("needle")).hits[0].messageCount, 2);

  const replacement = join(sessions, "replacement.tmp");
  await writeFile(replacement, transcript("two", temp, "bravo 中文 needle"));
  await rename(replacement, file);
  assert.equal((await search("alpha")).hits.length, 0);
  const replaced = await search("bravo");
  assert.equal(replaced.hits.length, 1);
  assert.notEqual(replaced.hits[0].session.id, first.hits[0].session.id);

  const duplicate = join(sessions, "z-copy.jsonl");
  await writeFile(duplicate, await readFile(file));
  assert.equal((await search("needle")).hits.length, 1);
  await rm(duplicate);
  await rm(file);
  assert.deepEqual(await search("needle"), { hits: [], nextOffset: null });
  assert.deepEqual((await sidecar.call("native.session.list")).sessions, []);
  assert.equal(sidecar.hostCalls.length, 0);
  sidecar.check();
  console.log("PASS native search RPC: cold/warm queries, selected message, append, replacement, deduplication, deletion, and no Host writes");
} finally {
  await sidecar?.stop();
  await rm(temp, { recursive: true, force: true });
}
