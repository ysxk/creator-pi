import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

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

test("a failed revision switch keeps the only queued copy of a tool result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-rewrite-rollback-"));
  const outbox = new PersistenceOutbox(dir, () => undefined);
  const appended = [];
  let refuseAppends = true;
  const host = {
    isAvailable: () => true,
    call: async (method, params) => {
      if (method === "session.appendMessage") {
        // Unclassified, so the head backs off and the drain returns unwritten.
        if (refuseAppends) throw new Error("host busy");
        appended.push(params.message.id);
        return {};
      }
      if (method === "session.activateRevision") throw new Error("revision switch failed");
      return {};
    },
  };
  const fence = { committed: 0, rolledBack: 0 };
  const handlers = new Map();
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    dataDir: dir,
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: outbox,
    logger: { app: () => undefined },
    plugins: { broadcastEvent: () => undefined },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => session,
    acquireSessionOperation: async () => () => undefined,
    beginTranscriptRewrite: () => ({
      commit: () => { fence.committed += 1; },
      rollback: () => { fence.rolledBack += 1; },
    }),
    forgetTranscriptRewriteHistory: () => undefined,
    stripWinLongPrefix: (value) => value,
  });

  await outbox.enqueue(
    {
      key: "message:s1:tool-1",
      sessionId: "s1",
      message: { id: "tool-1", role: "tool", content: "only copy of this result" },
    },
    () => host,
  );
  await outbox.flush(() => host);
  assert.equal(outbox.size(), 1, "the append is still waiting when the switch starts");

  const activate = handlers.get(IPC.invoke.sessionActivateRevision);
  await assert.rejects(
    activate({ sessionId: "s1", rootUserId: "u1", revisionIndex: 1, prefix: [] }),
    /revision switch failed/,
  );

  assert.deepEqual(fence, { committed: 0, rolledBack: 1 });
  assert.equal(outbox.size(), 1, "the failed switch gives the queued append back");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, "session-message-outbox.json"), "utf8")).map((entry) => entry.key),
    ["message:s1:tool-1"],
  );

  refuseAppends = false;
  const restarted = { ...host };
  await outbox.flush(() => restarted);
  assert.deepEqual(appended, ["tool-1"], "a later drain still writes it");
});
