import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { readMainSource } from "./helpers/main-source.mjs";

const silent = () => undefined;

test("session delete drops the outbox for that session (D318)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.dropSession\(id\)/);
});

test("handshake drains the outbox before the renderer can hydrate (D327)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.flush\(\(\) => host\)/);
  assert.doesNotMatch(main, /void persistenceOutbox\.flush\(\(\) => host\)/);
  assert.match(main, /session\.recoverInflightMessages/);
});

test("message_end checkpoints the finished snapshot before settling (D327)", async () => {
  const main = await readMainSource();
  assert.match(
    main,
    /event\.type === "message_end"[\s\S]*inflightCheckpointer\.observe\([\s\S]*settleIf\(sessionId, finalId\)/,
  );
});

test("deleting a session drops its queued outbox entries (D318)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(
    {
      key: "message:keep:a",
      sessionId: "keep",
      message: { id: "a" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:gone:b",
      sessionId: "gone",
      message: { id: "b" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  await outbox.dropSession("gone");
  assert.equal(outbox.size(), 1);
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["keep"],
  );
});

function mockHost(handler) {
  return {
    isAvailable: () => true,
    call: async (method, params) => handler(method, params),
  };
}

test("duplicate message id does not stall later outbox entries (D444)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "call_421522") {
      throw new Error("UNIQUE constraint failed: messages.id");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:call_421522",
      sessionId: "s1",
      message: { id: "call_421522" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush skipped duplicate message id"),
  );
});

test("a full outbox rejects an entry instead of reporting it enqueued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-full-"));
  const path = join(dir, "session-message-outbox.json");
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    key: `message:s${index}:m${index}`,
    sessionId: `s${index}`,
    message: { id: `m${index}` },
  }));
  await writeFile(path, JSON.stringify(entries), "utf8");
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });

  await assert.rejects(
    outbox.enqueue(
      { key: "message:last:missing", sessionId: "last", message: { id: "missing" } },
      () => null,
    ),
    /outbox is full/i,
  );
  assert.equal(outbox.size(), 1024);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 1024);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message === "session persistence outbox is full" &&
        entry.data?.key === "message:last:missing",
    ),
  );
});

test("non-unique flush errors still pause the outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("session not found");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


test("poisoned provenance message does not stall later outbox entries (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "steering-poison") {
      throw new Error("PERMISSION_DENIED: transcript input does not match its session delivery");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:steering-poison",
      sessionId: "s1",
      message: { id: "steering-poison", role: "user", steering: true },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1", role: "assistant" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped poisoned message"),
  );
});

test("PLUGIN_PERMISSION_DENIED is not poison and still pauses the outbox (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("PLUGIN_PERMISSION_DENIED: missing grant for fs.write");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


test("FOREIGN KEY constraint failed drops the orphaned entry and keeps draining (#996)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "orphaned-child") {
      throw new Error("Error: FOREIGN KEY constraint failed");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:orphaned-child",
      sessionId: "s1",
      message: { id: "orphaned-child" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:healthy",
      sessionId: "s2",
      message: { id: "healthy" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0, "both entries should be drained");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "healthy");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped orphaned message"),
  );
});

// The host process refuses a request line above its fixed size before sending
// it, so the same entry fails identically on every retry.
function sizeLimitedHost(limitBytes, calls) {
  return mockHost(async (_method, params) => {
    if (JSON.stringify(params).length > limitBytes) {
      throw Object.assign(new Error("request line exceeds 64 MiB"), {
        errorCode: "LIMIT_EXCEEDED",
        code: 1002,
      });
    }
    calls.push(params);
  });
}

test("an oversized tool result is stored without its payload and does not stall other sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = sizeLimitedHost(2_000, calls);
  const getHost = () => host;
  const payload = "QUJD".repeat(2_000);
  const result = { content: [{ type: "text", text: "Read memo.wav" }, { type: "image", data: payload, mimeType: "audio/wav" }] };
  await outbox.enqueue(
    {
      key: "message:s1:read-1",
      sessionId: "s1",
      turnId: "turn-1",
      // The shape the main process builds for a finished tool call.
      message: {
        id: "read-1",
        role: "tool",
        content: JSON.stringify(result),
        toolCallId: "read-1",
        toolName: "Read",
        toolArgs: { path: "memo.wav" },
        toolStatus: "success",
        toolResult: result,
        status: "complete",
      },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1", role: "assistant", content: "from another session" },
    },
    () => null,
  );

  await outbox.flush(getHost);

  assert.equal(outbox.size(), 0, "nothing is left waiting behind the oversized row");
  assert.deepEqual(calls.map((call) => call.message.id), ["read-1", "assistant-1"]);
  const stored = calls[0];
  assert.equal(stored.sessionId, "s1");
  assert.equal(stored.turnId, "turn-1");
  assert.doesNotMatch(JSON.stringify(stored), /QUJDQUJD/);
  assert.equal(stored.message.content, "[This tool result was too large to store.]");
  // The call still reads as finished, with its name and arguments.
  assert.equal(stored.message.toolStatus, "success");
  assert.equal(stored.message.toolName, "Read");
  assert.deepEqual(stored.message.toolArgs, { path: "memo.wav" });
  assert.ok(logs.some((row) => row.level === "error" && /without its payload/.test(row.message)));
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")),
    [],
    "the oversized row is gone from the file a restart reloads",
  );
});

test("an oversized row that cannot be reduced is dropped so later rows drain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = sizeLimitedHost(2_000, calls);
  const getHost = () => host;
  const huge = "x".repeat(8_000);
  for (const entry of [
    // Not a tool row: there is no payload to set aside.
    { key: "message:s1:assistant-big", sessionId: "s1", message: { id: "assistant-big", role: "assistant", content: huge } },
    // A tool row that is too large even without its result.
    { key: "message:s1:write-1", sessionId: "s1", message: { id: "write-1", role: "tool", content: "ok", toolArgs: { content: huge } } },
    { key: "message:s2:assistant-1", sessionId: "s2", message: { id: "assistant-1", role: "assistant", content: "kept" } },
  ]) {
    await outbox.enqueue(entry, () => null);
  }

  await outbox.flush(getHost);

  assert.equal(outbox.size(), 0);
  assert.deepEqual(calls.map((call) => call.message.id), ["assistant-1"]);
  assert.equal(
    logs.filter((row) => row.message === "session persistence flush dropped oversized message").length,
    2,
  );
});
