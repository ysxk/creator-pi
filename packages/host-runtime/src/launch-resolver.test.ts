import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelBinding } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";

import { createHeadlessLaunchResolver, type HostProviderRecord } from "./launch-resolver.js";

type Call = { method: string; params: Record<string, unknown> };

function hostWith(providers: HostProviderRecord[], secrets: Record<string, string> = {}, subagentPath?: string) {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push({ method, params });
        switch (method) {
          case "commandShells.list":
            return {
              configuredId: null,
              effective: { id: "bash", label: "bash", available: true, dialect: "posix", isDefault: true },
              fallback: true,
              choices: [{ id: "bash", label: "bash", available: true, dialect: "posix", isDefault: true }],
            } as T;
          case "providers.list":
            return { providers } as T;
          case "providers.getSecret":
            return { value: secrets[String(params.id)] } as T;
          case "skills.active":
            return { skills: [{ id: "review", name: "Review", enabled: true, description: "Review code" }] } as T;
          case "agents.active":
            return { subagents: subagentPath ? [{ id: "worker", path: subagentPath }] : [] } as T;
          case "agents.disabledBuiltins":
            return { disabled: [] } as T;
          case "project.group.context":
            return { context: null } as T;
          case "project.memory.get":
            return { memory: { content: "remember me" } } as T;
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    },
  };
}

const provider: HostProviderRecord = {
  id: "p1",
  name: "OpenAI",
  vendorKey: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: [
    { id: "gpt-a", contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: null, availableForSubagents: false },
  ],
  authKind: "api_key",
  hasSecret: true,
  enabled: true,
};

describe("createHeadlessLaunchResolver", () => {
  it("resolves the session's provider, its secret, the shell, skills and project memory", async () => {
    const { host, calls } = hostWith([provider], { p1: "sk-test" });
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    const launch = await resolver.resolve(
      "s1",
      { providerId: "p1", modelId: "gpt-a", projectPath: "/work/project" },
      { defaultMode: "agent" },
    );
    expect(launch.providerId).toBe("p1");
    expect(launch.modelId).toBe("gpt-a");
    expect(launch.projectPath).toBe("/work/project");
    expect(launch.sidecarParams.provider.apiKey).toBe("sk-test");
    expect(launch.sidecarParams.provider.modelConfig?.name).toBe("gpt-a");
    expect(launch.sidecarParams.scratchDir).toBe("/data/scratch/s1");
    expect(launch.sidecarParams.pluginSkills).toEqual([{ id: "review", name: "Review", description: "Review code" }]);
    expect(launch.sidecarParams.pluginTools).toEqual([]);
    expect(launch.sidecarParams.projectMemory).toBe("remember me");
    expect(launch.sidecarParams.commandShell).toMatchObject({ id: "bash" });
    expect(launch.sidecarParams.infiniteProviderRetry).toBe(false);
    expect(calls.some((call) => call.method === "providers.getSecret")).toBe(true);
  });

  it("uses only the full wire ID binding for a routed model, retaining its request ID", async () => {
    const routedId = "proxy/model";
    const row: HostProviderRecord = {
      ...provider,
      models: [
        { id: "model", contextWindow: 16_000, contextWindowSource: "user", maxTokens: 2_048, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
        { id: " PROXY/MODEL ", contextWindow: 32_000, contextWindowSource: "user", maxTokens: 4_096, thinkingLevels: ["high"], defaultThinkingLevel: "high" },
      ],
    };
    const { host } = hostWith([row], { p1: "sk-test" });
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    const routed = await resolver.resolve("s1", { providerId: "p1", modelId: routedId }, {});
    expect(routed.modelId).toBe(routedId);
    expect(routed.sidecarParams.provider.modelId).toBe(routedId);
    expect(routed.sidecarParams.provider.modelConfig).toMatchObject({ name: routedId, contextWindow: 32_000, maxTokens: 4_096 });
    expect(routed.sidecarParams.thinkingLevel).toBe("high");

    const plain = await resolver.resolve("s1", { providerId: "p1", modelId: "model" }, {});
    expect(plain.sidecarParams.provider.modelConfig).toMatchObject({ name: "model", contextWindow: 16_000, maxTokens: 2_048 });
    expect(plain.sidecarParams.thinkingLevel).toBe("off");

    row.models = [row.models![0]];
    const unbound = await resolver.resolve("s1", { providerId: "p1", modelId: routedId }, {});
    expect(unbound.sidecarParams.provider.modelConfig).toMatchObject({ name: routedId, contextWindow: 128_000, maxTokens: 8_192 });
    expect(unbound.sidecarParams.thinkingLevel).toBe("off");
    expect(unbound.sidecarParams.provider.modelId).toBe(routedId);
  });

  it("forwards the opt-in infinite provider retry setting", async () => {
    const { host } = hostWith([provider], { p1: "sk-test" });
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    const launch = await resolver.resolve(
      "s1",
      { providerId: "p1", modelId: "gpt-a" },
      { defaultMode: "agent", infiniteProviderRetry: true },
    );
    expect(launch.sidecarParams.infiniteProviderRetry).toBe(true);
  });

  it("falls back to the default provider and refuses a provider without a secret", async () => {
    const { host } = hostWith([provider, { ...provider, id: "p2", name: "Other", hasSecret: false }], { p1: "sk" });
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    const launch = await resolver.resolve("s1", {}, { defaultProviderId: "p1", defaultModelId: "gpt-a" });
    expect(launch.providerId).toBe("p1");
    await expect(resolver.resolve("s1", { providerId: "p2", modelId: "gpt-a" }, {})).rejects.toMatchObject({
      errorCode: "PROVIDER_SECRET_MISSING",
    });
  });

  it("refuses vendor accounts and plugin agents, which need the desktop", async () => {
    const { host } = hostWith([{ ...provider, authKind: "oauth" }]);
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    await expect(resolver.resolve("s1", { providerId: "p1" }, {})).rejects.toMatchObject({ errorCode: "MODEL_NOT_CONFIGURED" });
    await expect(resolver.resolve("s1", { providerId: "extension-agent:plugin.x%2Fagent" }, {})).rejects.toMatchObject({
      errorCode: "MODEL_NOT_CONFIGURED",
    });
  });

  it("fails with a typed error when no provider exists or the host is gone", async () => {
    const { host } = hostWith([]);
    const resolver = createHeadlessLaunchResolver({ getHost: () => host, dataDir: "/data", log: () => undefined });
    await expect(resolver.resolve("s1", {}, {})).rejects.toMatchObject({ errorCode: "MODEL_NOT_CONFIGURED" });
    const offline = createHeadlessLaunchResolver({ getHost: () => null, dataDir: "/data", log: () => undefined });
    await expect(offline.resolve("s1", {}, {})).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
  });
});


it("resolves raw model settings before headless launch, opt-in selection, definition pins and fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-model-settings-"));
  try {
    const path = join(root, "worker.md");
    await writeFile(path, "---\nname: worker\ndescription: Fixture\nmodel: openai/child\nfallbackModels: [openai/backup]\n---\nCustom worker rules.\n");
    const binding = (id: string): ModelBinding => ({
      id, contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: null,
      availableForSubagents: false,
      settings: {
        baseline: { contextWindow: 64_000, maxTokens: 2_000, thinkingLevels: ["low"], supportsImages: true },
        defaults: { maxTokens: 4_096, thinkingLevels: ["high"], defaultThinkingLevel: "high",
          availableForSubagents: true, systemPrompt: `Instructions for ${id}` },
        overrides: id === "main" ? { supportsImages: false, availableForSubagents: false, systemPrompt: "" } : {},
      },
    });
    const row: HostProviderRecord = { ...provider, models: [binding("main"), binding("child"), {
      ...binding("backup"), settings: { baseline: {}, defaults: { systemPrompt: "Backup instructions" }, overrides: {} },
    }] };
    const before = structuredClone(row);
    const { host, calls } = hostWith([row], { p1: "fixture-key" }, path);
    const launch = await createHeadlessLaunchResolver({ getHost: () => host, dataDir: root, log: () => undefined })
      .resolve("s1", { providerId: "p1", modelId: "main" }, {});
    expect(launch.sidecarParams.provider).toMatchObject({
      systemPrompt: "", supportsVision: false, supportedThinkingLevels: ["high"],
      modelConfig: { contextWindow: 64_000, maxTokens: 4_096 },
    });
    expect(launch.sidecarParams.thinkingLevel).toBe("high");
    expect(launch.sidecarParams.subagentModelKeys).toEqual(["openai/child"]);
    expect(launch.sidecarParams.subagentProviders).toMatchObject({
      "openai/child": { systemPrompt: "Instructions for child", modelConfig: { contextWindow: 64_000, maxTokens: 4_096 } },
      "openai/backup": { systemPrompt: "Backup instructions" },
    });
    expect(calls.some((call) => call.method === "modelSettings.get")).toBe(false);
    expect(row).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
