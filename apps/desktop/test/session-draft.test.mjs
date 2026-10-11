import i18n from "i18next";
import { en } from "@pi-desktop/i18n";
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");

const provider = { id: "p", enabled: true, authKind: "none", models: [{ id: "a" }] };
const settings = { defaultProviderId: "p", defaultModelId: "a", defaultMode: "agent" };

// A send records the recent model in the browser's storage; give the store one.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};

function resetStore(overrides = {}) {
  useAppStore.setState({
    providers: [provider],
    settings,
    workspace: null,
    activeProjectPath: null,
    sessions: [],
    sessionMeta: {},
    activeSessionId: null,
    messages: [],
    runningSessions: {},
    isRunning: false,
    draftConfiguration: null,
    page: "chat",
    ...overrides,
  });
}

test("new task creates nothing on the host until the first message is sent", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  resetStore();
  let nextId = 0;
  const createSession = t.mock.method(api, "createSession", async (config) => ({
    session: { ...config, id: `s${++nextId}`, title: config.title, messages: [], messageCount: 0 },
  }));
  t.mock.method(api, "prompt", async () => ({ accepted: true, turnId: "t1" }));

  await useAppStore.getState().newSession({ projectPath: null });
  assert.equal(createSession.mock.callCount(), 0, "New Task must not call session.create");
  assert.ok(!useAppStore.getState().activeSessionId, "the draft has no session id");
  assert.equal(useAppStore.getState().page, "chat");
  assert.deepEqual(useAppStore.getState().sessions, [], "no sidebar row before the first message");

  // Repeated clicks on the empty home stay free of host calls too.
  await useAppStore.getState().newSession({ projectPath: null });
  assert.equal(createSession.mock.callCount(), 0);

  // The first message is what materializes the conversation.
  assert.equal(await useAppStore.getState().sendPrompt("hello there"), true);
  assert.equal(createSession.mock.callCount(), 1);
  assert.equal(useAppStore.getState().activeSessionId, "s1");
  assert.equal(useAppStore.getState().sessions.length, 1);
});

test("new task from a conversation leaves it for a fresh draft with default toolbar choices", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const open = {
    id: "open",
    title: "An open conversation",
    mode: "agent",
    messageCount: 3,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  resetStore({
    sessions: [open],
    activeSessionId: "open",
    messages: [{ id: "m1", role: "user", content: "earlier", status: "complete", createdAt: open.updatedAt }],
    draftConfiguration: { mode: "plan", thinkingLevel: "high" },
  });
  const createSession = t.mock.method(api, "createSession", async () => {
    throw new Error("must not be called");
  });

  await useAppStore.getState().newSession({ projectPath: null });
  assert.equal(createSession.mock.callCount(), 0);
  const state = useAppStore.getState();
  assert.ok(!state.activeSessionId, "the draft has no session id");
  assert.deepEqual(state.messages, []);
  assert.equal(state.draftConfiguration, null);
  // The conversation itself is untouched in the sidebar.
  assert.deepEqual(state.sessions.map((session) => session.id), ["open"]);
});

test("new task still reuses the scope's latest empty session instead of stacking drafts", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const empty = {
    id: "empty",
    title: "New task",
    mode: "agent",
    messageCount: 0,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T01:00:00.000Z",
  };
  resetStore({ sessions: [empty] });
  const createSession = t.mock.method(api, "createSession", async () => {
    throw new Error("must not be called");
  });
  // Selecting a session also restores its pending plan and interactive state
  // and may pin its model; none of that is under test here.
  t.mock.method(api, "getSession", async (id) => ({ session: { ...empty, id, messages: [] } }));
  t.mock.method(api, "pendingPlans", async () => ({ plans: [] }));
  t.mock.method(api, "pendingInteractive", async () => ({ asks: [], permissions: [] }));
  t.mock.method(api, "configureSession", async (id, config) => ({ session: { ...empty, ...config, id } }));

  await useAppStore.getState().newSession({ projectPath: null });
  assert.equal(createSession.mock.callCount(), 0);
  assert.equal(useAppStore.getState().activeSessionId, "empty");
  // Let the selection's follow-up restores settle inside the test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});
