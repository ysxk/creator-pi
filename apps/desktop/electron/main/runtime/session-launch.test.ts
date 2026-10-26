import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelBinding } from "@pi-desktop/shared";
import { ModelsDevCatalog } from "../models-dev-catalog";
import { createProviderCatalogRuntime, type RuntimeProvider } from "./provider-catalog";
import { createSessionLaunchRuntime, type SessionLaunchRuntimeDependencies } from "./session-launch";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function binding(id: string): ModelBinding {
  return {
    id, contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: null,
    availableForSubagents: false,
    settings: {
      baseline: { contextWindow: 64_000, maxTokens: 2_000, thinkingLevels: ["low"], supportsImages: true },
      defaults: { alias: "Shared alias", maxTokens: 4_096, thinkingLevels: ["high"], defaultThinkingLevel: "high",
        availableForSubagents: true, systemPrompt: `Instructions for ${id}` },
      overrides: id === "main" ? { supportsImages: false, availableForSubagents: false, systemPrompt: "" } : {},
    },
  };
}

async function fixture(authKind = "none") {
  const root = await mkdtemp(join(tmpdir(), "desktop-model-settings-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "worker.md");
  await writeFile(path, "---\nname: worker\ndescription: Fixture\nmodel: fixture/child\nfallbackModels: [fixture/backup]\n---\nCustom worker rules.\n");
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ fixture: {
    name: "Fixture", api: "https://fixture.invalid/v1", models: Object.fromEntries(["main", "child", "backup"].map((id) => [id, {
      id, name: id, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200_000, output: 16_000 },
    }])),
  } }));
  const catalog = new ModelsDevCatalog({ catalogPath });
  await catalog.ensureLoaded();
  const row: RuntimeProvider = {
    id: "account", vendorKey: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", enabled: true, authKind,
    models: [binding("main"), binding("child"), {
      ...binding("backup"), settings: { baseline: {}, defaults: { systemPrompt: "Backup instructions" }, overrides: {} },
    }],
  };
  const calls: string[] = [];
  const host = {
    isAvailable: () => true,
    call: async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "commandShells.list") {
        const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
        return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] } as T;
      }
      if (method === "providers.list") return { providers: [row] } as T;
      if (method === "providers.getSecret") return {} as T;
      if (method === "agents.active") return { subagents: [{ id: "worker", path }] } as T;
      if (method === "skills.disabledBuiltins" || method === "agents.disabledBuiltins") return { disabled: [] } as T;
      if (method === "skills.active") return { skills: [] } as T;
      if (method === "mcp.active") return { servers: [] } as T;
      if (method === "settings.get") return {} as T;
      throw new Error(`Unexpected host call ${method}`);
    },
  };
  const providerCatalog = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: catalog });
  const dependencies = {
    runtimeState: { host }, logger: { app() {} },
    userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: root,
    vendorOAuth: { bindingFor: async () => ({ supportsReasoning: true, supportedThinkingLevels: ["low", "high"],
      apiStyle: "chat_completions", baseUrl: row.baseUrl }) },
    modelsDevCatalog: catalog, getWorkspacePath: () => undefined, pluginActiveInProject: () => true,
    bindingForModel: providerCatalog.bindingForModel, effectiveSubagentModelConfig: providerCatalog.effectiveSubagentModelConfig,
    normalizeThinkingLevel: providerCatalog.normalizeThinkingLevel,
  } as unknown as SessionLaunchRuntimeDependencies;
  return { row, calls, providerCatalog, runtime: createSessionLaunchRuntime(dependencies) };
}

it("provider enrichment and exact binding lookup expose effective settings without altering the raw row", async () => {
  const { row, providerCatalog } = await fixture();
  const before = structuredClone(row);
  expect(providerCatalog.bindingForModel(row, " MAIN ")).toMatchObject({
    alias: "Shared alias", contextWindow: 64_000, maxTokens: 4_096, thinkingLevels: ["high"],
    supportsImages: false, availableForSubagents: false, systemPrompt: "",
  });
  const enriched = providerCatalog.enrichProvider(row, "main");
  expect(enriched).toMatchObject({ supportsVision: false, supportedThinkingLevels: ["high"] });
  expect(enriched.models?.[0]).toMatchObject({ alias: "Shared alias", maxTokens: 4_096, systemPrompt: "" });
  expect(row).toEqual(before);
});

it.each(["none", "oauth"])("desktop %s launch uses effective main, opt-in, definition and fallback model settings", async (authKind) => {
  const { row, calls, runtime } = await fixture(authKind);
  const before = structuredClone(row);
  const { sidecarParams } = await runtime.resolveAgentRuntimeLaunch("session", { providerId: "account", modelId: "main" }, {});
  expect(sidecarParams.provider).toMatchObject({
    systemPrompt: "", supportsVision: false, supportedThinkingLevels: ["high"], modelConfig: { contextWindow: 64_000, maxTokens: 4_096 },
  });
  expect(sidecarParams.thinkingLevel).toBe("high");
  expect(sidecarParams.subagentModelKeys).toEqual(["fixture/child"]);
  expect(sidecarParams.subagentProviders).toMatchObject({
    "fixture/child": { systemPrompt: "Instructions for child", supportedThinkingLevels: ["high"],
      modelConfig: { contextWindow: 64_000, maxTokens: 4_096 } },
    "fixture/backup": { systemPrompt: "Backup instructions" },
  });
  expect(calls).not.toContain("modelSettings.get");
  expect(row).toEqual(before);
});
