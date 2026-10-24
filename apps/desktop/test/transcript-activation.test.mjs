import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { transcriptViewMessages } = await import("../src/lib/transcript-reading.ts");

const message = (id) => ({ id, role: "user", content: id, createdAt: "2026-10-20T00:00:00Z" });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
let sequence = 0;
function setup(t, read) {
  const a = `activation-a-${++sequence}`;
  const b = `activation-b-${sequence}`;
  const sessions = [a, b].map((id) => ({
    id, title: id, mode: "agent", providerId: "p", modelId: "m", messageCount: 200,
    createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
  }));
  const detail = (id, messages = [message(`${id}-latest`)], extra = {}) => ({
    session: { ...sessions.find((s) => s.id === id), messages, messageStart: 100, hasMoreBefore: true, ...extra },
  });
  globalThis.window = { piDesktop: { invoke: async (channel, input) => {
    assert.equal(channel, IPC.invoke.sessionGet);
    return { ok: true, data: await (read?.(input.id, input, detail) ?? detail(input.id)) };
  } } };
  t.mock.method(api, "pendingPlans", async () => ({ plans: [], state: "inactive" }));
  t.mock.method(api, "pendingInteractive", async () => ({ asks: [], permissions: [] }));
  useAppStore.setState({
    sessions, activeSessionId: a, messages: [message(`${a}-latest`)],
    workspace: null, activeProjectPath: null, page: "chat", selectingSessionId: undefined,
    retainedSessionIds: [a, b], retainedTranscripts: { [b]: [message(`${b}-latest`)] },
    transcriptViews: {}, sessionHistory: { [a]: { messageStart: 100, hasMoreBefore: true } },
    runningSessions: { [a]: true }, isRunning: true,
  });
  return { a, b, detail, state: useAppStore.getState, visible: () => {
    const state = useAppStore.getState();
    return transcriptViewMessages(state.messages, state.transcriptViews[state.activeSessionId]);
  } };
}

test("completed search -> sidebar B -> ordinary A reveals live latest and keeps paging/run state", async (t) => {
  const r = setup(t, (id, options, detail) => options?.messageAround
    ? detail(id, [message(options.messageAround)], { messageStart: 20, messageEnd: 80, hasMoreAfter: true })
    : options?.messageBefore ? detail(id, [message("older")], { messageStart: 0, hasMoreBefore: false }) : undefined);
  await r.state().navigateTranscript({ sessionId: r.a, messageId: "historical-hit", query: "hit" });
  assert.equal(r.visible()[0].id, "historical-hit");
  await r.state().selectSession(r.b);
  await r.state().selectSession(r.a);
  assert.equal(r.state().transcriptViews[r.a], undefined);
  assert.equal(r.visible().at(-1).id, `${r.a}-latest`);
  assert.equal(r.state().isRunning, true);
  assert.equal(r.state().sessionHistory[r.a].hasMoreBefore, true);
  await r.state().loadTranscriptPage(r.a, "before");
  assert.deepEqual(r.visible().map((m) => m.id), ["older", `${r.a}-latest`]);
  const ordinary = r.state().transcriptViews[r.a];
  await r.state().selectSession(r.b);
  await r.state().selectSession(r.a);
  assert.equal(r.state().transcriptViews[r.a], ordinary, "ordinary history remains retained");
});

test("return invalidates pending old search but preserves fresh navigation during revalidation", async (t) => {
  const old = deferred();
  const fresh = deferred();
  const tail = deferred();
  let holdTail = false;
  const r = setup(t, (id, options) => {
    if (options?.messageAround === "old") return old.promise;
    if (options?.messageAround === "fresh") return fresh.promise;
    if (holdTail && id === r.a) return tail.promise;
  });
  const oldNavigation = r.state().navigateTranscript({ sessionId: r.a, messageId: "old", query: "old" });
  await r.state().selectSession(r.b);
  holdTail = true;
  const activation = r.state().selectSession(r.a);
  assert.equal(r.state().activeSessionId, r.a, "retained activation is immediate");
  const freshNavigation = r.state().navigateTranscript({ sessionId: r.a, messageId: "fresh", query: "fresh" });
  fresh.resolve(r.detail(r.a, [message("fresh")]));
  await freshNavigation;
  old.resolve(r.detail(r.a, [message("old")]));
  await oldNavigation;
  tail.resolve(r.detail(r.a));
  await activation;
  assert.equal(r.state().transcriptViews[r.a].focus.messageId, "fresh");
  assert.deepEqual(r.visible().map((m) => m.id), ["fresh"]);
});

test("an old search resolving after ordinary return cannot restore its historical window", async (t) => {
  const old = deferred();
  const r = setup(t, (_id, options) => options?.messageAround ? old.promise : undefined);
  const navigation = r.state().navigateTranscript({ sessionId: r.a, messageId: "old", query: "old" });
  await r.state().selectSession(r.b);
  await r.state().selectSession(r.a);
  old.resolve(r.detail(r.a, [message("old")]));
  await navigation;
  assert.equal(r.state().transcriptViews[r.a], undefined);
  assert.equal(r.visible().at(-1).id, `${r.a}-latest`);
});
