import {
  capabilitiesFromModelConfig,
  capabilitiesFromModelInfo,
  clampThinkingLevel,
  audioFromModelConfig,
  genericModelConfig,
  modelConfigWithBinding,
  videoFromModelConfig,
  visionFromModelConfig,
  type ModelCapabilities,
} from "./model-capabilities.js";
import { describe, expect, it } from "vitest";
import type { ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import type { ModelConfig } from "./thinking-level.js";

function knownModel(): ModelConfig {
  return {
    ...genericModelConfig("claude-opus-4.6", "https://api.anthropic.com"),
    source: "models.dev" as const,
    name: "Claude 4.6 Opus",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
  };
}

describe("main-supplied model capabilities", () => {
  it("uses models.dev modalities for visual transport", () => {
    expect(visionFromModelConfig(knownModel())).toBe(true);
    expect(
      visionFromModelConfig({
        ...genericModelConfig("text-only"),
        modalities: { input: ["text"], output: ["text"] },
      }),
    ).toBe(false);
  });

  it("uses the published reasoning levels without consulting a model catalog", () => {
    expect(capabilitiesFromModelConfig(knownModel())).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(capabilitiesFromModelConfig(genericModelConfig("unknown"))).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });
  });

  it("projects a public models.dev row to the same capability shape", () => {
    const info: ModelInfo = {
      modelId: "model",
      displayName: "Model",
      providerId: "provider",
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      supportedThinkingLevels: ["off", "high"],
      capabilities: ["text", "reasoning"],
      source: "discovered",
      catalogSource: "models.dev",
    };
    expect(capabilitiesFromModelInfo(info)).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "high"],
    });
  });

  it("keeps unknown models on the generic non-reasoning shape", () => {
    const config = genericModelConfig("unknown-model", "https://gateway.example/v1");
    expect(config).toMatchObject({
      source: "generic",
      name: "unknown-model",
      reasoning: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128_000, input: 128_000, output: 8_192 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it("uses the published long-context window when a binding marks its seed as catalog-owned", () => {
    const model = {
      ...knownModel(),
      contextWindow: 1_050_000,
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    };
    const configured = modelConfigWithBinding(model, {
      contextWindow: 128_000,
      contextWindowSource: "catalog",
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(1_050_000);
    expect(configured.limit?.context).toBe(1_050_000);
  });

  it("does not use a generic fallback to replace a catalog snapshot", () => {
    const configured = modelConfigWithBinding(genericModelConfig("gateway-model"), {
      contextWindow: 1_000_000,
      contextWindowSource: "catalog",
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(1_000_000);
  });

  it("preserves a legacy stored context window without provenance", () => {
    const configured = modelConfigWithBinding(knownModel(), {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(128_000);
  });

  it("applies binding limits and preserves explicit thinking levels", () => {
    const configured = modelConfigWithBinding(
      {
        ...knownModel(),
        thinkingLevelMap: { xhigh: null, max: null },
      },
      {
        contextWindow: 64_000,
        maxTokens: 4_000,
        thinkingLevels: ["off", "minimal", "low", "max"],
      },
    );
    expect(configured.contextWindow).toBe(64_000);
    expect(configured.maxTokens).toBe(4_000);
    expect(configured.reasoning).toBe(true);
    expect(configured.supportedThinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "max",
    ]);
    expect(configured.thinkingLevelMap).toMatchObject({ max: "max" });

    const enlarged = modelConfigWithBinding(knownModel(), {
      contextWindow: 256_000,
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(enlarged.contextWindow).toBe(256_000);
    expect(enlarged.catalogContextWindow).toBe(128_000);

    const unknown = modelConfigWithBinding(genericModelConfig("unknown"), {
      contextWindow: 16_000,
      maxTokens: 2_000,
      thinkingLevels: ["high"],
    });
    expect(unknown.reasoning).toBe(true);
    expect(unknown.supportedThinkingLevels).toEqual(["high"]);

    // An endpoint-listed window is followed by a catalog-sourced binding and
    // is no ceiling for the user's own number.
    const listed = { ...genericModelConfig("relay-model"), contextWindow: 32_000, endpointContextWindow: 32_000 };
    const seed = { contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: [] };
    const followed = modelConfigWithBinding(listed, { ...seed, contextWindowSource: "catalog" });
    expect(followed.contextWindow).toBe(32_000);
    expect(followed.limit?.context).toBe(32_000);
    const pinned = modelConfigWithBinding(listed, { ...seed, contextWindow: 200_000, contextWindowSource: "user" });
    expect(pinned.contextWindow).toBe(200_000);
    expect(pinned.catalogContextWindow).toBeUndefined();
    expect(modelConfigWithBinding(listed, seed).contextWindow).toBe(128_000);

    const cataloguedNonReasoning = modelConfigWithBinding(
      {
        ...genericModelConfig("catalogued-chat"),
        source: "models.dev" as const,
        reasoning: false,
        supportedThinkingLevels: [],
      },
      {
        contextWindow: 16_000,
        maxTokens: 2_000,
        thinkingLevels: ["medium"],
      },
    );
    expect(cataloguedNonReasoning.reasoning).toBe(true);
    expect(cataloguedNonReasoning.supportedThinkingLevels).toEqual(["medium"]);
  });

  it("clamps sparse catalog capability lists using the nearest supported level", () => {
    const capabilities: ModelCapabilities = {
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
    };
    expect(clampThinkingLevel(capabilities, "minimal")).toBe("low");
    expect(clampThinkingLevel(capabilities, "max")).toBe("high");
  });
});

describe("binding attachment capability overrides", () => {
  const baseBinding = {
    contextWindow: 200_000,
    maxTokens: 32_000,
    thinkingLevels: ["medium"] as ThinkingLevel[],
  };

  it("follows the published modalities when no override is stored", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: null,
      supportsDocuments: null,
    });
    expect(config.modalities?.input).toEqual(["text", "image", "pdf"]);
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("turns image transport off for a vision model the user opted out of", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
    });
    expect(config.modalities?.input).not.toContain("image");
    expect(config.input).not.toContain("image");
    expect(visionFromModelConfig(config)).toBe(false);
  });

  it("grants image transport to a model the catalog calls text-only", () => {
    // A proxied endpoint routinely accepts input its catalog entry omits, so the
    // override is applied rather than narrowed to the published capability.
    const textOnly = {
      ...genericModelConfig("proxy-model", "https://proxy.test/v1"),
      modalities: { input: ["text"] as const, output: ["text"] as const },
    };
    const config = modelConfigWithBinding(textOnly, {
      ...baseBinding,
      supportsImages: true,
    });
    expect(config.modalities?.input).toContain("image");
    expect(config.input).toContain("image");
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("records a document override without adding an untransportable modality to the adapter subset", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).not.toContain("pdf");
    // pi-ai has no PDF content block, so the adapter subset never carried it.
    expect(config.input).toEqual(["text", "image"]);
  });

  it("keeps text input even when every override is off", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).toEqual(["text"]);
    expect(config.input).toEqual(["text"]);
  });

  it("resolves video transport from the published modality array", () => {
    expect(videoFromModelConfig(knownModel())).toBe(false);
    expect(
      videoFromModelConfig({
        ...genericModelConfig("gemini-2.5-flash"),
        modalities: { input: ["text", "image", "video"], output: ["text"] },
      }),
    ).toBe(true);
    // The adapter subset cannot carry "video"; it must never report it alone.
    expect(videoFromModelConfig({ input: ["text", "image"] })).toBe(false);
  });

  it("grants and revokes video transport through the binding override", () => {
    const proxied = {
      ...genericModelConfig("proxy-model", "https://proxy.test/v1"),
      modalities: { input: ["text", "image"] as const, output: ["text"] as const },
    };
    const enabled = modelConfigWithBinding(proxied, {
      ...baseBinding,
      supportsVideos: true,
    });
    expect(enabled.modalities?.input).toContain("video");
    expect(videoFromModelConfig(enabled)).toBe(true);

    const native = {
      ...genericModelConfig("gemini-2.5-flash"),
      modalities: {
        input: ["text", "image", "video"] as const,
        output: ["text"] as const,
      },
    };
    const disabled = modelConfigWithBinding(native, {
      ...baseBinding,
      supportsVideos: false,
    });
    expect(disabled.modalities?.input).not.toContain("video");
    expect(videoFromModelConfig(disabled)).toBe(false);
  });

  it("resolves audio transport from the published modality array", () => {
    expect(audioFromModelConfig(knownModel())).toBe(false);
    expect(
      audioFromModelConfig({
        ...genericModelConfig("gemini-2.5-flash"),
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
      }),
    ).toBe(true);
    // The adapter subset cannot carry "audio"; it must never report it alone.
    expect(audioFromModelConfig({ input: ["text", "image"] })).toBe(false);
    // Video and audio are separate gates.
    expect(
      audioFromModelConfig({
        ...genericModelConfig("gemini-2.5-flash"),
        modalities: { input: ["text", "image", "video"], output: ["text"] },
      }),
    ).toBe(false);
  });

  it("grants and revokes audio transport through the binding override", () => {
    const proxied = {
      ...genericModelConfig("proxy-model", "https://proxy.test/v1"),
      modalities: { input: ["text", "image"] as const, output: ["text"] as const },
    };
    const enabled = modelConfigWithBinding(proxied, {
      ...baseBinding,
      supportsAudio: true,
    });
    expect(enabled.modalities?.input).toContain("audio");
    expect(audioFromModelConfig(enabled)).toBe(true);
    // The adapter subset still carries only what pi-ai encodes as a block.
    expect(enabled.input).toEqual(["text", "image"]);

    const native = {
      ...genericModelConfig("gemini-2.5-flash"),
      modalities: {
        input: ["text", "image", "audio"] as const,
        output: ["text"] as const,
      },
    };
    const disabled = modelConfigWithBinding(native, {
      ...baseBinding,
      supportsAudio: false,
    });
    expect(disabled.modalities?.input).not.toContain("audio");
    expect(audioFromModelConfig(disabled)).toBe(false);
  });

  it("leaves limits and explicit thinking levels untouched by a capability override", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      thinkingLevels: ["medium", "off"] as ThinkingLevel[],
      supportsImages: true,
    });
    expect(config.contextWindow).toBe(200_000);
    expect(config.maxTokens).toBe(32_000);
    expect(config.supportedThinkingLevels).toEqual(["off", "medium"]);
  });
});

describe("unmatched model effective thinking policy", () => {
  it("keeps every manually selected level without inventing published metadata", () => {
    const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const published = genericModelConfig("route/unknown");
    for (const binding of [undefined, { contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: [] }]) {
      const effective = modelConfigWithBinding(published, binding);
      const capabilities = capabilitiesFromModelConfig(effective);
      expect(capabilities.supportedThinkingLevels).toEqual(levels);
      for (const level of levels) expect(clampThinkingLevel(capabilities, level)).toBe(level);
      expect(effective.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
    }
    expect(published.reasoning).toBe(false);
    expect(published.supportedThinkingLevels).toEqual([]);
  });

  it("preserves explicit restrictions and trusted non-reasoning records", () => {
    const generic = genericModelConfig("route/unknown");
    const binding = { contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"] as ThinkingLevel[] };
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(generic, binding)).supportsReasoning).toBe(false);
    const trusted = { ...generic, source: "models.dev" as const };
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(trusted)).supportsReasoning).toBe(false);
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(trusted, { ...binding, thinkingLevels: [] })).supportsReasoning).toBe(false);
  });
});

it("keeps native Pi null and absent extended mappings unavailable", () => {
  const configured = modelConfigWithBinding({ ...knownModel(), source: "pi",
    supportedThinkingLevels: ["low", "high"], thinkingLevelMap: { off: null, xhigh: null } }, {
    contextWindow: 64_000, maxTokens: 4_000, thinkingLevels: ["low", "xhigh", "max"],
  });
  expect(configured.supportedThinkingLevels).toEqual(["low"]);
  expect(configured.thinkingLevelMap?.xhigh).toBeNull();
  expect(configured.thinkingLevelMap?.max).toBeUndefined();
});


it.each([true, false])("applies explicit native search=%s over a catalog setting", (enabled) => {
  const model = { ...knownModel(), webSearch: !enabled };
  expect(modelConfigWithBinding(model, {
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevels: ["high"], nativeWebSearch: enabled,
  }).webSearch).toBe(enabled);
  expect(modelConfigWithBinding(model, {
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevels: ["high"],
  }).webSearch).toBe(!enabled);
});
