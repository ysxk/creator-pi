import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { ProviderTransferService, writeProviderTransfer } = await import("../electron/main/services/provider-transfer.ts");
const { portableProvider } = await import("@pi-desktop/shared");
const { MCP_CONTROL_BLOCKED_CHANNEL_KEYS } = await import("../electron/main/mcp-control.ts");

const provider = (id, extra = {}) => ({
  id, name: "Fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", authKind: "api_key_and_base_url",
  enabled: false, baseUrl: "https://example.invalid", apiStyle: "chat_completions", hasSecret: true,
  headers: { "X-Custom": "synthetic-header-secret" }, models: [{ id: "m", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null,
    settings: { baseline: { contextWindow: 128000, maxTokens: 8192 }, defaults: { maxTokens: 9999 }, overrides: { supportsImages: false } } }], ...extra,
});
const serialized = (channels) => JSON.stringify({ format: "pi-desktop-channels", version: 1, channels });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-channel-transfer-"));
  const file = join(dir, "channels.json");
  const records = [provider("existing")];
  const secrets = new Map([["existing", "synthetic-api-secret"]]);
  const calls = [];
  const host = { async call(method, input) {
    calls.push({ method, input });
    if (method === "providers.list") return { providers: records };
    if (method === "providers.getSecret") return { value: secrets.get(input.id) };
    if (method === "providers.create") {
      const row = provider(`new-${records.length}`, { ...input, hasSecret: false }); records.push(row); return { provider: row };
    }
    if (method === "providers.update") { Object.assign(records.find((r) => r.id === input.id), input); return {}; }
    if (method === "providers.setSecret") { secrets.set(input.id, input.secretValue); return {}; }
    if (method === "providers.delete") { records.splice(records.findIndex((r) => r.id === input.id), 1); secrets.delete(input.id); return {}; }
    throw new Error("Unexpected RPC");
  } };
  const service = new ProviderTransferService(host, { open: async () => file, save: async () => file });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, file, records, secrets, calls, host, service };
}

test("public export/import path omits secrets, preserves sparse layers and creates new identities", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.export({ providerIds: ["existing"], includeSecrets: false }), { exported: 1 });
  const raw = await readFile(f.file, "utf8");
  assert.ok(!raw.includes("synthetic-api-secret") && !raw.includes("synthetic-header-secret"));
  assert.ok(!f.calls.some((call) => call.method === "providers.getSecret"));
  if (process.platform !== "win32") assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const preview = await f.service.prepare();
  assert.equal(preview.channels[0].sameName, true);
  assert.equal(preview.channels[0].hasApiKey, false);
  assert.deepEqual(await f.service.confirm({ token: preview.token, indices: [0] }), { items: [{ index: 0, status: "imported", providerId: "new-1" }] });
  assert.equal(f.records[0].id, "existing");
  assert.equal(f.records[1].enabled, false);
  assert.deepEqual(f.records[1].models[0].settings, { baseline: { contextWindow: 128000, maxTokens: 8192 }, defaults: {}, overrides: { supportsImages: false } });
  assert.ok(!f.calls.some((call) => /settings|testConnection|discover/i.test(call.method)));
});

test("opt-in credentials stay in main, file replacement after preview cannot change the imported snapshot", async (t) => {
  const f = await fixture(t);
  await f.service.export({ providerIds: ["existing"], includeSecrets: true });
  const raw = await readFile(f.file, "utf8");
  assert.ok(raw.includes("synthetic-api-secret") && raw.includes("synthetic-header-secret"));
  const preview = await f.service.prepare();
  assert.equal(preview.channels[0].hasApiKey, true);
  assert.ok(!JSON.stringify(preview).includes("synthetic-"));
  await writeFile(f.file, "invalid replacement");
  const result = await f.service.confirm({ token: preview.token, indices: [0] });
  assert.equal(f.secrets.get(result.items[0].providerId), "synthetic-api-secret");
  assert.ok(!JSON.stringify(result).includes("synthetic-"));
  await assert.rejects(f.service.confirm({ token: preview.token, indices: [0] }), /CHANNEL_PREVIEW_INVALID/);
});

test("cancelled native pickers never read secrets or mutate channels", async (t) => {
  const f = await fixture(t);
  const service = new ProviderTransferService(f.host, { open: async () => undefined, save: async () => undefined });
  t.after(() => service.close());
  assert.equal(await service.prepare(), null);
  assert.equal(await service.export({ providerIds: ["existing"], includeSecrets: true }), null);
  assert.equal(f.calls.length, 0);
});

test("invalid files and missing secrets leave existing export files untouched", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, '{"apiKey":"synthetic-api-secret",bad}');
  await assert.rejects(f.service.prepare(), /^Error: CHANNEL_FILE_INVALID$/);
  assert.equal(f.calls.length, 0);
  f.secrets.clear();
  await assert.rejects(f.service.export({ providerIds: ["existing"], includeSecrets: true }), /CHANNEL_SECRET_UNAVAILABLE/);
  assert.equal(await readFile(f.file, "utf8"), '{"apiKey":"synthetic-api-secret",bad}');
  assert.deepEqual(await readdir(f.dir), ["channels.json"]);
});

test("tokens are owner-bound, cancelled, expired and disposed without writes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, serialized([portableProvider(f.records[0], false)]));
  const other = new ProviderTransferService(f.host, { open: async () => f.file, save: async () => f.file });
  t.after(() => other.close());
  const preview = await f.service.prepare();
  await assert.rejects(other.confirm({ token: preview.token, indices: [0] }), /CHANNEL_PREVIEW_INVALID/);
  f.service.cancel({ token: preview.token });
  await assert.rejects(f.service.confirm({ token: preview.token, indices: [0] }), /CHANNEL_PREVIEW_INVALID/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expires = await f.service.prepare();
  t.mock.timers.tick(5 * 60 * 1000);
  await assert.rejects(f.service.confirm({ token: expires.token, indices: [0] }), /CHANNEL_PREVIEW_INVALID/);
  const disposed = await f.service.prepare(); f.service.close();
  await assert.rejects(f.service.confirm({ token: disposed.token, indices: [0] }), /CHANNEL_TRANSFER_CLOSED/);
  assert.ok(f.calls.every((call) => call.method === "providers.list"));
});

test("overlapping submissions are refused and only newly-created channels are rolled back", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, serialized([portableProvider(f.records[0], true, "synthetic-api-secret")]));
  const original = f.host.call;
  let release; const barrier = new Promise((resolve) => { release = resolve; });
  f.host.call = async (method, input) => {
    if (method === "providers.setSecret") { await barrier; throw new Error("synthetic-api-secret"); }
    return original(method, input);
  };
  const preview = await f.service.prepare();
  const run = f.service.confirm({ token: preview.token, indices: [0] });
  await assert.rejects(f.service.confirm({ token: preview.token, indices: [0] }), /CHANNEL_TRANSFER_BUSY/);
  release();
  assert.deepEqual(await run, { items: [{ index: 0, status: "failed" }] });
  assert.deepEqual(f.records.map((row) => row.id), ["existing"]);
});

test("partial failure reports an orphan identifier when cleanup fails, and continues later items", async (t) => {
  const f = await fixture(t);
  const channel = portableProvider(f.records[0], true, "synthetic-api-secret");
  await writeFile(f.file, serialized([channel, { ...channel, name: "Second" }]));
  const original = f.host.call;
  f.host.call = async (method, input) => {
    if ((method === "providers.setSecret" || method === "providers.delete") && input.id === "new-1") throw new Error("synthetic-api-secret");
    return original(method, input);
  };
  const preview = await f.service.prepare();
  const result = await f.service.confirm({ token: preview.token, indices: [1, 0] });
  assert.deepEqual(result.items.map((item) => item.status), ["cleanupFailed", "imported"]);
  assert.equal(result.items[0].providerId, "new-1");
  assert.ok(!JSON.stringify(result).includes("synthetic-"));
});

test("a window closed while the native picker is open cannot retain a preview", async (t) => {
  const f = await fixture(t);
  let release;
  const service = new ProviderTransferService(f.host, { open: () => new Promise((resolve) => { release = resolve; }), save: async () => undefined });
  const pending = service.prepare(); service.close(); release(f.file);
  await assert.rejects(pending, /CHANNEL_TRANSFER_CLOSED/);
  assert.equal(f.calls.length, 0);
});

test("atomic export cleans temporary files on write/rename failure", async (t) => {
  const f = await fixture(t);
  await assert.rejects(writeProviderTransfer(f.dir, "synthetic-api-secret"));
  assert.deepEqual(await readdir(f.dir), []);
});

test("transfer IPC is excluded from MCP/plugin control and enforces main-window ownership", async () => {
  const keys = ["providersImportPreview", "providersImportConfirm", "providersImportCancel", "providersExportFile"];
  for (const key of keys) assert.ok(MCP_CONTROL_BLOCKED_CHANNEL_KEYS.includes(key));
  const source = await readFile(new URL("../electron/main/ipc/provider-transfer-ipc.ts", import.meta.url), "utf8");
  assert.match(source, /registrar\.assertMainWindowSender\(event\)/);
  assert.match(source, /sender\.once\("destroyed", clear\)/);
  assert.match(source, /isMainFrame && !isInPlace/);
  for (const key of keys) assert.ok(source.includes(`handleWithEvent(IPC.invoke.${key}`));
});
