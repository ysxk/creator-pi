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

// The host never accepts a permission mode on session.create (ADR 0237), so a
// realistic double drops it and answers with the `inherit` default.
function hostLikeCreateSession() {
  let nextId = 0;
  return async ({ permissionMode: _ignored, ...config }) => ({
    session: {
      ...config,
      id: `s${++nextId}`,
      permissionMode: "inherit",
      messages: [],
      messageCount: 0,
    },
  });
}

test("the permission mode chosen on a draft survives the first message", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  resetStore({ settings: { ...settings, defaultPermissionMode: "ask" } });
  const calls = [];
  t.mock.method(api, "createSession", hostLikeCreateSession());
  const configureSession = t.mock.method(api, "configureSession", async (id, config) => {
    calls.push("configure");
    return {
      session: { id, title: "New task", messages: [], messageCount: 0, ...config },
    };
  });
  t.mock.method(api, "prompt", async () => {
    calls.push("prompt");
    return { accepted: true, turnId: "t1" };
  });

  await useAppStore.getState().newSession({ projectPath: null });
  await useAppStore.getState().configureActiveSession({
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "auto",
  });
  assert.equal(configureSession.mock.callCount(), 0, "a draft has no session to configure");

  assert.equal(await useAppStore.getState().sendPrompt("hello there"), true);
  assert.equal(configureSession.mock.callCount(), 1);
  assert.equal(configureSession.mock.calls[0].arguments[0], "s1");
  assert.equal(configureSession.mock.calls[0].arguments[1].permissionMode, "auto");
  assert.deepEqual(calls, ["configure", "prompt"], "the mode is stored before the turn starts");
  const state = useAppStore.getState();
  assert.equal(state.activeSessionId, "s1");
  assert.equal(state.sessions.find((session) => session.id === "s1")?.permissionMode, "auto");
});

test("a draft left on the default permission mode needs no extra configure call", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  resetStore();
  t.mock.method(api, "createSession", hostLikeCreateSession());
  const configureSession = t.mock.method(api, "configureSession", async () => {
    throw new Error("must not be called");
  });
  t.mock.method(api, "prompt", async () => ({ accepted: true, turnId: "t1" }));

  await useAppStore.getState().newSession({ projectPath: null });
  assert.equal(await useAppStore.getState().sendPrompt("hello there"), true);
  assert.equal(configureSession.mock.callCount(), 0);
});

test("a first message is not sent when the draft's permission mode cannot be stored", async (t) => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  // Falling back to the global default here would run the turn unattended
  // although the draft asked for confirmation.
  resetStore({ settings: { ...settings, defaultPermissionMode: "auto" } });
  const createSession = t.mock.method(api, "createSession", hostLikeCreateSession());
  t.mock.method(api, "configureSession", async () => {
    throw new Error("host unavailable");
  });
  const prompt = t.mock.method(api, "prompt", async () => ({ accepted: true, turnId: "t1" }));

  await useAppStore.getState().newSession({ projectPath: null });
  await useAppStore.getState().configureActiveSession({
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "ask",
  });
  assert.equal(await useAppStore.getState().sendPrompt("hello there"), false);
  assert.equal(prompt.mock.callCount(), 0);
  // The created session is kept and selected, so a retry reuses it instead of
  // stacking empty rows.
  assert.equal(createSession.mock.callCount(), 1);
  assert.equal(useAppStore.getState().activeSessionId, "s1");
});
