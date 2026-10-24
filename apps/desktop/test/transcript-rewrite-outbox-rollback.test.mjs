import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": { ErrorCodes, IPC, IPC_WHITELIST },
  "../importers": {},
  "../services/session-collaboration": {},
  "../services/session-search": {},
});

function sessionIpc(dir, outbox, host) {
  const activeTurns = new Map();
  const coordination = createSessionCoordination({
    activeTurns, getMainWindow: () => null, getViewingSessionId: () => null,
  });
  const handlers = new Map();
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    dataDir: dir,
    activeTurns,
    sessionProjects: new Map(),
    persistenceOutbox: outbox,
    logger: { app: () => undefined },
    plugins: { broadcastEvent: () => undefined },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => session,
    acquireSessionOperation: coordination.acquireSessionOperation,
    beginTranscriptRewrite: coordination.beginTranscriptRewrite,
    forgetTranscriptRewriteHistory: coordination.forgetTranscriptRewriteHistory,
    stripWinLongPrefix: (value) => value,
  });
  return { handlers, coordination };
}

const actions = [
  { channel: IPC.invoke.sessionActivateRevision, method: "session.activateRevision", input: { sessionId: "s1", rootUserId: "u1", revisionIndex: 1, prefix: [] } },
  { channel: IPC.invoke.sessionReplaceMessages, method: "session.replaceMessages", input: { sessionId: "s1", messages: [] } },
];
const queued = {
  key: "message:s1:tool-1", sessionId: "s1",
  message: { id: "tool-1", role: "tool", content: "only copy of this result" },
};

for (const action of actions) {
  test(`${action.method} waits for pending persistence and can retry without losing messages`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-rewrite-drain-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let now = 0;
    const outbox = new PersistenceOutbox(dir, () => undefined, { now: () => now, schedule: () => () => undefined });
    const messages = new Map();
    const calls = [];
    let refuseAppends = true;
    const host = {
      isAvailable: () => true,
      async call(method, params) {
        calls.push(method);
        if (method === "session.appendMessage") {
          if (refuseAppends) throw new Error("host busy");
          messages.set(params.message.id, params.message);
        } else if (method === action.method) {
          assert.deepEqual([...messages.values()], [queued.message]);
          assert.deepEqual(JSON.parse(await readFile(path.join(dir, "session-message-outbox.json"), "utf8")), []);
          messages.clear();
        }
        return {};
      },
    };
    const { handlers, coordination } = sessionIpc(dir, outbox, host);
    coordination.recordTurnStart("s1", "turn-old");
    await outbox.enqueue(queued, () => host);
    await outbox.flush(() => host);
    await assert.rejects(handlers.get(action.channel)(action.input), /pending message persistence/i);
    assert.equal(calls.includes(action.method), false, "the host must not rewrite while recovery still holds old appends");
    assert.equal(outbox.size(), 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "session-message-outbox.json"), "utf8")), [queued]);

    refuseAppends = false;
    now += 60_000;
    await handlers.get(action.channel)(action.input);
    assert.equal(calls.filter((method) => method === action.method).length, 1);
    assert.equal(coordination.isStaleTranscriptEvent({ sessionId: "s1", turnId: "turn-old" }), true);
    const reopened = new PersistenceOutbox(dir, () => undefined);
    await reopened.flush(() => host);
    assert.equal(messages.size, 0, "cold recovery cannot resurrect the discarded branch");
  });
}

for (const outcome of ["success", "failed-before-commit", "response-lost"]) {
  test(`a drained rewrite remains recovery-safe when its outcome is ${outcome}`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-rewrite-recover-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const outbox = new PersistenceOutbox(dir, () => undefined, { schedule: () => () => undefined });
    const messages = new Map();
    const host = {
      isAvailable: () => true,
      async call(method, params) {
        if (method === "session.appendMessage") messages.set(params.message.id, params.message);
        if (method === "session.replaceMessages") {
          if (outcome === "failed-before-commit") throw new Error("rewrite failed");
          messages.clear();
          const recovery = new PersistenceOutbox(dir, () => undefined);
          await recovery.flush(() => host);
          assert.equal(messages.size, 0, "recovery before the rewrite response must find no obsolete append");
          if (outcome === "response-lost") throw new Error("host disconnected after commit");
        }
        return {};
      },
    };
    const { handlers } = sessionIpc(dir, outbox, host);
    await outbox.enqueue(queued, () => null);
    const replacing = handlers.get(IPC.invoke.sessionReplaceMessages)({ sessionId: "s1", messages: [] });
    if (outcome === "success") await replacing;
    else await assert.rejects(replacing, /rewrite failed|host disconnected after commit/);
    const recovery = new PersistenceOutbox(dir, () => undefined);
    await recovery.flush(() => host);
    assert.deepEqual([...messages.values()], outcome === "failed-before-commit" ? [queued.message] : []);
  });
}
