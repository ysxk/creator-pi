import assert from "node:assert/strict";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import { Host } from "./host.mjs";
import { registerProviderTransferIpc } from "../../apps/desktop/electron/main/ipc/provider-transfer-ipc";

const directory = process.env.PI_TRANSFER_FIXTURE;
app.setPath("userData", join(directory, "profile"));
const host = new Host(process.env.PI_DESKTOP_HOST_BIN, join(directory, "data"));
let win;
const responses = [];
let cancelOpen = false;
let cancelSave = false;
const path = join(directory, "channels.json");
const secret = "synthetic-transfer-key";
const extra = (id, fields) => ({ id, name: id, vendorKey: "custom", type: "custom", protocol: "openai", enabled: true, authKind: "oauth", hasSecret: true, models: [], createdAt: "fixture", updatedAt: "fixture", ...fields });
let extras = [extra("OAuth fixture", {}), extra("Plugin fixture", { authKind: "api_key", ownerPluginId: "fixture.plugin" })];
app.whenReady().then(async () => {
try {
  await host.start();
  const created = await host.call("providers.create", { name: "Channel fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", authKind: "api_key_and_base_url", baseUrl: "https://example.invalid/v1", apiStyle: "chat_completions", secretValue: secret, headers: { "X-Custom": "synthetic-header" },
    models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off", "high"], defaultThinkingLevel: "off", settings: { baseline: { contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off", "high"], defaultThinkingLevel: "off" }, defaults: {}, overrides: { supportsImages: false, systemPrompt: "Channel instructions", defaultThinkingLevel: "omit" } } }],
  });
  const originalId = created.provider.id;
  await host.call("providers.update", { id: originalId, enabled: false });
  await host.call("modelSettings.update", { modelId: "fixture-model", set: { maxTokens: 16000 } });
  const settings = await host.call("settings.get");
  assert.equal((await host.call("providers.list")).providers[0].models[0].settings.overrides.defaultThinkingLevel, "omit");
  await host.call("settings.set", { ...settings, defaultProviderId: originalId, defaultModelId: "fixture-model" });
  win = new BrowserWindow({ show: false, width: 1000, height: 740, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(directory, "preload.cjs"), backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(event.message); });
  const handlers = new Map();
  const registrar = {
    ipcMain,
    assertMainWindowSender(event) { assert.equal(event.sender, win.webContents); },
    handleWithEvent(channel, fn) {
      handlers.set(channel, fn);
      ipcMain.handle(channel, async (event, ...args) => {
        try { const data = await fn(event, ...args); responses.push({ channel, data }); return { ok: true, data }; }
        catch (error) { return { ok: false, error: { code: "TRANSFER_FAILED", message: error.message } }; }
      });
    },
  };
  dialog.showOpenDialog = async () => ({ canceled: cancelOpen, filePaths: cancelOpen ? [] : [path] });
  dialog.showSaveDialog = async () => ({ canceled: cancelSave, filePath: cancelSave ? undefined : path });
  registerProviderTransferIpc({ registrar, getHost: () => host });
  await assert.rejects(handlers.get(IPC.invoke.providersImportPreview)({ sender: win.webContents, senderFrame: null }), /CHANNEL_TRANSFER_FORBIDDEN/);
  const handle = (channel, fn) => registrar.handleWithEvent(channel, async () => fn());
  handle(IPC.invoke.providersList, async () => { const data = await host.call("providers.list"); return { providers: [...data.providers, ...extras] }; });
  handle(IPC.invoke.settingsGet, () => host.call("settings.get"));
  handle(IPC.invoke.sessionList, () => ({ sessions: [] }));
  handle(IPC.invoke.appGetOnboarding, () => ({}));
  handle(IPC.invoke.providersOauthVendors, () => ({ vendors: [] }));
  handle(IPC.invoke.providersModelCatalogStatus, () => ({ status: { loaded: false, source: "empty", providerCount: 0, modelCount: 0 } }));
  handle(IPC.invoke.secretsHas, () => ({ has: false }));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = (key, inDialog = false) => js(`transferProbe.click(${JSON.stringify(key)}, ${inDialog})`);
  await win.loadFile(join(directory, "index.html"));
  await js(`new Promise((resolve, reject) => {
    if (window.transferProbe) return resolve();
    const timer = setTimeout(() => reject(new Error("Renderer initialization timed out")), 15000);
    window.addEventListener("transfer-probe-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
  })`);

  await click("channelTransfer.exportFile"); await js("transferProbe.waitDialog()");
  let state = await js("transferProbe.state()");
  assert.equal(state.checked, false); assert.equal(state.disabled, 2); assert.ok(state.viewportFits);
  assert.equal(await js("transferProbe.tabBack()"), true);
  await click("channelTransfer.exportFile", true); await js("transferProbe.waitClosed()");
  const publicRaw = await readFile(path, "utf8");
  assert.ok(!publicRaw.includes(secret) && !publicRaw.includes("synthetic-header"));
  assert.equal(JSON.parse(publicRaw).channels[0].models[0].overrides.defaultThinkingLevel, "omit");
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  for (const headers of [{ "-X": "value" }, { "X-Test": "é".repeat(2049) }]) {
    const file = JSON.parse(publicRaw);
    file.channels.push({ ...file.channels[0], headers });
    const before = (await host.call("providers.list")).providers.map((provider) => provider.id).sort();
    await writeFile(path, JSON.stringify(file));
    await assert.rejects(handlers.get(IPC.invoke.providersImportPreview)(event), /CHANNEL_FILE_INVALID/);
    await assert.rejects(handlers.get(IPC.invoke.providersImportConfirm)(event, { token: "invalid", indices: [0, 1] }), /CHANNEL_PREVIEW_INVALID/);
    assert.deepEqual((await host.call("providers.list")).providers.map((provider) => provider.id).sort(), before);
  }
  await writeFile(path, publicRaw);
  await click("channelTransfer.importFile"); await js("transferProbe.waitDialog()");
  await js("transferProbe.waitText('channelTransfer.sameName')");
  await click("channelTransfer.confirmImport", true); await js("transferProbe.waitText('channelTransfer.imported')");
  await js("transferProbe.waitCount(4)");
  assert.equal(await js("transferProbe.tabBack()"), true, "import result retains keyboard focus in its dialog");
  await click("channelTransfer.close", true); await js("transferProbe.waitClosed()");
  let providers = (await host.call("providers.list")).providers;
  assert.equal(providers.length, 2);
  const publicImported = providers.find((provider) => provider.id !== originalId);
  assert.equal(publicImported.enabled, false); assert.equal(publicImported.hasSecret, false);
  assert.equal(publicImported.models[0].settings.defaults.maxTokens, 16000);
  assert.deepEqual(publicImported.models[0].settings.overrides, { supportsImages: false, systemPrompt: "Channel instructions", defaultThinkingLevel: "omit" });
  await host.call("providers.delete", { id: publicImported.id });
  await js("transferProbe.refresh()");

  await click("channelTransfer.exportFile"); await js("transferProbe.waitDialog()");
  await js("transferProbe.toggle('channelTransfer.includeSecrets')");
  assert.ok((await js("transferProbe.state()")).text.includes("plaintext"));
  await writeFile(join(directory, "export-warning.png"), (await win.webContents.capturePage()).toPNG());
  await click("channelTransfer.exportFile", true); await js("transferProbe.waitClosed()");
  assert.ok((await readFile(path, "utf8")).includes(secret));
  await click("channelTransfer.importFile"); await js("transferProbe.waitDialog()");
  await click("channelTransfer.confirmImport", true); await js("transferProbe.waitText('channelTransfer.imported')");
  await js("transferProbe.waitCount(4)");
  await click("channelTransfer.close", true); await js("transferProbe.waitClosed()");
  providers = (await host.call("providers.list")).providers;
  const privateImported = providers.find((provider) => provider.id !== originalId);
  assert.equal((await host.call("providers.getSecret", { id: privateImported.id })).value, secret);
  assert.equal(privateImported.headers["X-Custom"], "synthetic-header");
  assert.equal((await host.call("settings.get")).defaultProviderId, originalId);
  assert.ok(!JSON.stringify(responses).includes(secret));
  const transferChannels = [IPC.invoke.providersImportPreview, IPC.invoke.providersImportConfirm, IPC.invoke.providersImportCancel, IPC.invoke.providersExportFile];
  assert.ok(!JSON.stringify(responses.filter((entry) => transferChannels.includes(entry.channel))).includes("synthetic-header"));

  cancelOpen = true; await click("channelTransfer.importFile"); assert.equal((await js("transferProbe.state()")).text, ""); cancelOpen = false;
  await click("channelTransfer.exportFile"); await js("transferProbe.waitDialog()"); assert.equal((await js("transferProbe.state()")).checked, false);
  cancelSave = true; await click("channelTransfer.exportFile", true); assert.ok((await js("transferProbe.state()")).text); cancelSave = false;
  await js("transferProbe.escape()"); await js("transferProbe.waitClosed()");
  assert.equal((await js("transferProbe.state()")).focus, "Export channels");
  await writeFile(path, '{"version":2,"format":"pi-desktop-channels","channels":[]}');
  await click("channelTransfer.importFile"); await js("transferProbe.waitText('channelTransfer.version')");
  assert.equal((await host.call("providers.list")).providers.length, 2);
  await js("transferProbe.locale('zh-CN')"); win.setSize(720, 640);
  await click("channelTransfer.exportFile"); await js("transferProbe.waitDialog()");
  state = await js("transferProbe.state()"); assert.ok(state.text.includes("默认不含 API Key")); assert.ok(state.viewportFits);
  await writeFile(join(directory, "channels-zh.png"), (await win.webContents.capturePage()).toPNG());
  await click("channelTransfer.close", true); await js("transferProbe.waitClosed()");
  await click("settings.importTitle");
  assert.equal(await js("document.getElementById('model-config-import-panel').hidden"), false);
  extras = [];
  for (const provider of (await host.call("providers.list")).providers) await host.call("providers.delete", { id: provider.id });
  await js("transferProbe.refresh()"); await click("channelTransfer.exportFile"); await js("transferProbe.waitText('channelTransfer.empty')");
  console.log("CHANNEL_TRANSFER_E2E " + JSON.stringify({ ok: true, publicImport: true, privateImport: true, inheritance: true, unchangedDefaults: true, empty: true, locale: "zh-CN", noSecretsInIpc: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  win?.destroy();
  await host.stop();
  app.exit(process.exitCode ?? 0);
}
}).catch((error) => { console.error(error); app.exit(1); });
