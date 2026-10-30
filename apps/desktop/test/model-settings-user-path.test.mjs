import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, withInheritedModelSettings } from "@pi-desktop/shared";
import { SettingsPage } from "./apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "./apps/desktop/src/stores/app-store";

Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });

const providerA = {
  id: "provider-a",
  name: "Channel Alpha",
  vendorKey: "custom",
  type: "custom",
  protocol: "openai",
  enabled: true,
  authKind: "api_key",
  hasSecret: true,
  models: [withInheritedModelSettings({
    id: "gpt-4o",
    contextWindow: 128000,
    maxTokens: 4096,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  })],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const providerB = {
  id: "provider-b",
  name: "Channel Beta",
  vendorKey: "custom",
  type: "custom",
  protocol: "openai",
  enabled: true,
  authKind: "api_key",
  hasSecret: true,
  models: [withInheritedModelSettings({
    id: "gpt-4o",
    contextWindow: 128000,
    maxTokens: 4096,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  })],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

let snapshot = {
  version: 1,
  defaults: {},
  channels: {},
};

const calls = [];

window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    let data = {};
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations:
        data = [];
        break;
      case IPC.invoke.settingsGet:
        data = {
          theme: "system",
          language: "en",
          defaultMode: "agent",
          enterToSend: true,
          onboardingDismissed: true,
        };
        break;
      case IPC.invoke.providersList:
        data = { providers: [providerA, providerB] };
        break;
      case IPC.invoke.modelSettingsGet:
        data = snapshot;
        break;
      case IPC.invoke.modelSettingsUpdate: {
        const { modelId, providerId, set = {}, unset = [] } = input;
        const key = modelId.toLowerCase();
        if (providerId) {
          snapshot.channels[providerId] = snapshot.channels[providerId] || {};
          const current = { ...(snapshot.channels[providerId][key] || {}), ...set };
          for (const f of unset) delete current[f];
          snapshot.channels[providerId][key] = current;
        } else {
          const current = { ...(snapshot.defaults[key] || {}), ...set };
          for (const f of unset) delete current[f];
          snapshot.defaults[key] = current;
        }
        data = snapshot;
        break;
      }
      default:
        data = {};
    }
    return { ok: true, data };
  },
};

void (async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: Object.fromEntries(
      Object.entries(catalogs).map(([locale, entries]) => [
        locale,
        { translation: flattenCatalog(entries) },
      ]),
    ),
    interpolation: { escapeValue: false },
  });

  useAppStore.setState({
    page: "settings",
    settingsTab: "agent",
    settings: {
      theme: "system",
      language: "en",
      defaultMode: "agent",
      enterToSend: true,
      onboardingDismissed: true,
    },
    providers: [providerA, providerB],
  });

  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  const reactRoot = createRoot(rootEl);
  flushSync(() => {
    reactRoot.render(<SettingsPage />);
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  const waitFor = async (predicate) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error("Timed out waiting for model settings UI");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  const choose = async (label, value) => {
    const trigger = Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
      .find((button) => button.getAttribute("aria-label") === label);
    if (!trigger) throw new Error("Missing menu: " + label);
    flushSync(() => trigger.click());
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((button) => button.textContent.trim() === value);
    if (!option) throw new Error("Missing option: " + value);
    flushSync(() => option.click());
  };
  const chooseChannel = async (providerId) => {
    const provider = [providerA, providerB].find((item) => item.id === providerId);
    await choose(i18n.t("settings.modelPrefs.scope"), i18n.t("settings.modelPrefs.channelScope", { name: provider.name }));
  };
  const editPrompt = async (text) => {
    await choose(i18n.t("settings.modelPrefs.promptMode"), i18n.t("settings.modelPrefs.customPrompt"));
    const textarea = document.querySelector('[data-model-field="systemPrompt"] textarea');
    if (!textarea) throw new Error("Custom prompt editor must be visible");
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const save = async () => {
    const button = Array.from(document.querySelectorAll(".model-pref-actions button"))
      .find((item) => item.textContent === i18n.t("common.save"));
    if (!button || button.disabled) throw new Error("Save must be enabled for edited settings");
    flushSync(() => button.click());
    await waitFor(() => document.querySelector('.model-pref-actions [role="status"]')?.textContent === i18n.t("settings.modelPrefs.saved"));
    await waitFor(() => !document.querySelector(".model-pref-actions button:disabled") ||
      Array.from(document.querySelectorAll(".model-pref-actions button")).every((item) => item.textContent !== i18n.t("common.saving")));
  };

  window.__probe = {
    getModelCountText() {
      return document.querySelector(".model-pref-list-count")?.textContent || "";
    },
    getModelItems() {
      return Array.from(document.querySelectorAll(".model-pref-list-item")).map(
        (el) => el.querySelector(".model-pref-list-id")?.textContent || "",
      );
    },
    async setGlobalPrompt(text) {
      await choose(i18n.t("settings.modelPrefs.scope"), i18n.t("settings.modelPrefs.defaults"));
      await editPrompt(text);
      await save();
    },
    async setChannelOverride(providerId, text) {
      await chooseChannel(providerId);
      await editPrompt(text);
      await save();
    },
    async resetChannelOverride(providerId, field) {
      await chooseChannel(providerId);
      const reset = document.querySelector('[data-model-field="' + field + '"] button');
      if (!reset || reset.disabled) throw new Error("Reset must be enabled for an explicit override");
      flushSync(() => reset.click());
      await save();
    },
    async effectivePrompt(providerId) {
      await chooseChannel(providerId);
      const field = document.querySelector('[data-model-field="systemPrompt"]');
      return field.querySelector("textarea")?.value || field.querySelector(".model-pref-prompt")?.textContent || "";
    },
    getSnapshot() {
      return snapshot;
    },
    getCalls() {
      return calls;
    },
  };
})();
`;

test("Model settings page displays aggregated models and integrates IPC", {
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async (t) => {
  const electronBinary = resolveElectronBinary(root).electronBinary;
  const temp = await mkdtemp(join(tmpdir(), "pi-model-settings-test-"));

  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: root,
        sourcefile: "fixture.tsx",
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env.DEV": "false",
      },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [urlAssets],
    });

    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="renderer.js"></script></body></html>',
    );

    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(__dirname, "index.html"));
  let result = null;
  for (let i = 0; i < 30; i++) {
    result = await win.webContents.executeJavaScript("window.__probe ? { count: window.__probe.getModelCountText(), items: window.__probe.getModelItems() } : null");
    if (result && result.items && result.items.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  await win.webContents.executeJavaScript("window.__probe.setGlobalPrompt('Global Prompt')");
  await win.webContents.executeJavaScript("window.__probe.setChannelOverride('provider-a', 'Channel A Prompt')");
  const snapshotBeforeReset = await win.webContents.executeJavaScript("window.__probe.getSnapshot()");
  const inheritedPrompt = await win.webContents.executeJavaScript("window.__probe.effectivePrompt('provider-b')");
  const overriddenPrompt = await win.webContents.executeJavaScript("window.__probe.effectivePrompt('provider-a')");
  await win.webContents.executeJavaScript("window.__probe.resetChannelOverride('provider-a', 'systemPrompt')");
  const snapshotAfterReset = await win.webContents.executeJavaScript("window.__probe.getSnapshot()");
  const restoredPrompt = await win.webContents.executeJavaScript("window.__probe.effectivePrompt('provider-a')");

  console.log("PROBE_RESULT " + JSON.stringify({
    result,
    snapshotBeforeReset,
    snapshotAfterReset,
    inheritedPrompt,
    overriddenPrompt,
    restoredPrompt,
  }));
  app.quit();
});
`,
    );

    const child = spawn(electronBinary, [join(temp, "main.cjs")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { output += chunk; });
    }

    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    assert.equal(code, 0, `Exit code should be 0, log: ${output}`);
    const line = output.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
    assert.ok(line, "probe result emitted");
    const parsed = JSON.parse(line.slice("PROBE_RESULT ".length));
    assert.ok(parsed.result, "probe returned result");
    assert.equal(parsed.result.items.length, 1);
    assert.equal(parsed.result.items[0], "gpt-4o");
    assert.equal(parsed.snapshotBeforeReset.defaults["gpt-4o"].systemPrompt, "Global Prompt");
    assert.equal(parsed.snapshotBeforeReset.channels["provider-a"]["gpt-4o"].systemPrompt, "Channel A Prompt");
    assert.equal(parsed.snapshotAfterReset.channels["provider-a"]["gpt-4o"].systemPrompt, undefined);
    assert.equal(parsed.snapshotAfterReset.defaults["gpt-4o"].systemPrompt, "Global Prompt");
    assert.equal(parsed.inheritedPrompt, "Global Prompt");
    assert.equal(parsed.overriddenPrompt, "Channel A Prompt");
    assert.equal(parsed.restoredPrompt, "Global Prompt");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
