import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceOutbox } from "../apps/desktop/electron/main/persistence-outbox.ts";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

if (process.platform === "win32") throw new Error("This fixture requires HOME-isolated host configuration");
const root = await mkdtemp(join(tmpdir(), "pi-outbox-recovery-e2e-"));
const dataDir = join(root, "data");
const workspace = join(root, "workspace");
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
await Promise.all([workspace, process.env.HOME, process.env.XDG_CONFIG_HOME].map((path) => mkdir(path, { recursive: true })));
const host = new Host(resolveHostBinary(), dataDir);
const hostFacade = { isAvailable: () => !host.exited, call: (method, params) => host.call(method, params) };
const options = { schedule: () => () => undefined };
let outbox = new PersistenceOutbox(dataDir, () => undefined, options);
const message = (role, content) => ({ id: randomUUID(), role, content, status: "complete", createdAt: new Date().toISOString() });

try {
  await host.start();
  const { session } = await host.call("session.create", { title: "Outbox recovery fixture", mode: "agent", projectPath: workspace });
  const prompt = message("user", "Fixture prompt");
  const oldReply = message("assistant", "Discarded branch reply");
  await host.call("session.appendMessage", { sessionId: session.id, message: prompt });
  await outbox.enqueue({ key: `message:${session.id}:${oldReply.id}`, sessionId: session.id, message: oldReply }, () => null);
  await assert.rejects(outbox.prepareSessionReplacement(session.id, () => null), /pending message persistence/i);
  assert.equal(outbox.size(), 1);
  console.log("PASS undrained rewrite preserves its only recovery copy");

  await outbox.prepareSessionReplacement(session.id, () => hostFacade);
  const before = (await host.call("session.get", { id: session.id })).session;
  assert.ok(before.messages.some((entry) => entry.id === oldReply.id));
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "session-message-outbox.json"), "utf8")), []);
  console.log("PASS old reply is durable and absent from outbox before rewrite");

  await host.call("session.replaceMessages", { sessionId: session.id, messages: [prompt] });
  // Recreate both owners without any post-rewrite outbox cleanup.
  outbox.close();
  await host.restart();
  outbox = new PersistenceOutbox(dataDir, () => undefined, options);
  await outbox.flush(() => hostFacade);
  const after = (await host.call("session.get", { id: session.id })).session;
  assert.deepEqual(after.messages.map((entry) => entry.id), [prompt.id]);
  console.log("PASS cold recovery does not resurrect the deleted reply");

  const nextReply = message("assistant", "Replacement branch reply");
  await outbox.enqueue({ key: `message:${session.id}:${nextReply.id}`, sessionId: session.id, message: nextReply }, () => hostFacade);
  await outbox.flush(() => hostFacade);
  const continued = (await host.call("session.get", { id: session.id })).session;
  assert.deepEqual(continued.messages.map((entry) => entry.id), [prompt.id, nextReply.id]);
  console.log("PASS subsequent appends still persist normally");
} finally {
  outbox.close();
  await host.stop();
  await rm(root, { recursive: true, force: true });
}
