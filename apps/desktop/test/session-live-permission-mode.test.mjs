import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");

const toolbar = { mode: "agent", providerId: "p", modelId: "a", thinkingLevel: "off" };

function runningSession(id, overrides = {}) {
  const session = {
    id,
    title: "A running conversation",
    ...toolbar,
    permissionMode: "ask",
    messageCount: 2,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
  useAppStore.setState({
    sessions: [session],
    sessionMeta: {},
    activeSessionId: id,
    runningSessions: { [id]: true },
    isRunning: true,
    pendingPlans: {},
    draftConfiguration: null,
  });
  return session;
}

const permissionOf = (id) =>
  useAppStore.getState().sessions.find((session) => session.id === id)?.permissionMode;

test("a permission mode changed while a turn runs is sent to the host at once", async (t) => {
  runningSession("live");
  let release;
  const setPermissionMode = t.mock.method(api, "setSessionPermissionMode", (id, permissionMode) =>
    new Promise((resolve) => {
      release = () => resolve({ session: { id, permissionMode } });
    }),
  );
  const configureSession = t.mock.method(api, "configureSession", async (id, config) => ({
    session: { id, title: "A running conversation", messageCount: 2, permissionMode: "auto", ...config },
  }));

  const change = useAppStore.getState().configureActiveSession({ ...toolbar, permissionMode: "auto" });
  await Promise.resolve();
  assert.deepEqual(setPermissionMode.mock.calls[0].arguments, ["live", "auto"]);
  assert.equal(configureSession.mock.callCount(), 0, "the rest of the toolbar still waits for idle");
  // The toolbar shows the mode the turn is really running under.
  assert.equal(permissionOf("live"), "ask");
  release();
  await change;
  assert.equal(permissionOf("live"), "auto");

  // The next idle write carries the staged toolbar without an older permission mode.
  useAppStore.setState({ runningSessions: { live: false }, isRunning: false });
  await useAppStore.getState().configureActiveSession({ ...toolbar, mode: "plan" });
  assert.equal(configureSession.mock.callCount(), 1);
  const payload = configureSession.mock.calls[0].arguments[1];
  assert.equal(payload.mode, "plan");
  assert.equal(payload.permissionMode, undefined);
});

test("each live change is written, and the last one is what the toolbar shows", async (t) => {
  // Each change is its own host write, and the last one is what stays.
  runningSession("live");
  const setPermissionMode = t.mock.method(api, "setSessionPermissionMode", async (id, permissionMode) => ({
    session: { id, permissionMode },
  }));
  await useAppStore.getState().configureActiveSession({ ...toolbar, permissionMode: "auto" });
  await useAppStore.getState().configureActiveSession({ ...toolbar, permissionMode: "ask" });
  assert.deepEqual(
    setPermissionMode.mock.calls.map((call) => call.arguments[1]),
    ["auto", "ask"],
  );
  assert.equal(permissionOf("live"), "ask");
});

test("a refused live change leaves the toolbar on the mode still in force", async (t) => {
  runningSession("refused", { permissionMode: "auto" });
  t.mock.method(api, "setSessionPermissionMode", async () => {
    throw new Error("PLAN_CONFIGURATION_BLOCKED");
  });
  await assert.rejects(
    useAppStore.getState().configureActiveSession({ ...toolbar, permissionMode: "ask" }),
    /PLAN_CONFIGURATION_BLOCKED/,
  );
  assert.equal(permissionOf("refused"), "auto");
});

for (const source of ["remote", "pi-native"]) {
  test(`a ${source} conversation keeps staging the permission mode for its next turn`, async (t) => {
    runningSession(`${source}-session`, { source });
    const setPermissionMode = t.mock.method(api, "setSessionPermissionMode", async () => {
      throw new Error("must not be called");
    });
    await useAppStore.getState().configureActiveSession({ ...toolbar, permissionMode: "auto" });
    assert.equal(setPermissionMode.mock.callCount(), 0);
    assert.equal(permissionOf(`${source}-session`), "auto");
  });
}
