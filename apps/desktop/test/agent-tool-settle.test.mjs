import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { sameFsRead, subscribeToolSettled, TOOL_SETTLE_DELAY_MS } = await import(
  "../src/lib/agent-tool-settle.ts"
);

function fakeEvents() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(type) {
      for (const listener of listeners) {
        listener({ sessionId: "s", ts: 0, event: { type, toolCallId: "c" } });
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

test("a burst of finished tool calls settles once after the delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = fakeEvents();
  let settled = 0;
  subscribeToolSettled(events.subscribe, () => settled++);
  events.emit("tool_end");
  t.mock.timers.tick(TOOL_SETTLE_DELAY_MS - 1);
  events.emit("tool_end");
  events.emit("tool_end");
  assert.equal(settled, 0);
  t.mock.timers.tick(1);
  assert.equal(settled, 1);
  t.mock.timers.tick(TOOL_SETTLE_DELAY_MS * 3);
  assert.equal(settled, 1);
});

test("a steady stream of tool calls still settles every delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = fakeEvents();
  let settled = 0;
  subscribeToolSettled(events.subscribe, () => settled++, 100);
  for (let step = 0; step < 10; step++) {
    events.emit("tool_end");
    t.mock.timers.tick(50);
  }
  assert.equal(settled, 5);
});

test("only tool_end schedules a settle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = fakeEvents();
  let settled = 0;
  subscribeToolSettled(events.subscribe, () => settled++);
  for (const type of ["tool_start", "tool_update", "message_update", "agent_end"]) {
    events.emit(type);
  }
  t.mock.timers.tick(TOOL_SETTLE_DELAY_MS * 2);
  assert.equal(settled, 0);
});

test("unsubscribing drops the listener and a pending settle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = fakeEvents();
  let settled = 0;
  const off = subscribeToolSettled(events.subscribe, () => settled++);
  events.emit("tool_end");
  off();
  assert.equal(events.size, 0);
  t.mock.timers.tick(TOOL_SETTLE_DELAY_MS * 2);
  assert.equal(settled, 0);
});

test("sameFsRead compares what the viewer renders", () => {
  const text = { kind: "text", content: "a", size: 1 };
  assert.equal(sameFsRead(text, { ...text }), true);
  assert.equal(sameFsRead(text, { ...text, content: "b" }), false);
  assert.equal(sameFsRead(text, { ...text, size: 2 }), false);
  const image = { kind: "image", dataUrl: "data:x", size: 4 };
  assert.equal(sameFsRead(image, { ...image }), true);
  assert.equal(sameFsRead(image, { ...image, dataUrl: "data:y" }), false);
  assert.equal(sameFsRead(text, { kind: "binary", size: 1 }), false);
});
