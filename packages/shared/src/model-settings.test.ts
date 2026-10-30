import { describe, expect, it } from "vitest";
import { bindingForCustomModel } from "./model-catalog.js";
import { modelSettingsKey, modelSettingsPatch, resolveModelBinding, updateModelBindingSettings } from "./model-settings.js";

describe("model settings inheritance", () => {
  it("new models inherit without pinning seed values", () => {
    expect(bindingForCustomModel("model").settings?.overrides).toEqual({});
  });
  it("uses field presence, including empty, false and null", () => {
    const binding = bindingForCustomModel("vendor/model");
    binding.settings!.defaults = { contextWindow: 200000, maxTokens: 10000, systemPrompt: "global model", supportsImages: true, thinkingLevels: ["high"] };
    const result = updateModelBindingSettings(binding, { maxTokens: 2000, systemPrompt: "", supportsImages: false, thinkingLevels: [], defaultThinkingLevel: null });
    expect(result).toMatchObject({ contextWindow: 200000, maxTokens: 2000, systemPrompt: "", supportsImages: false, thinkingLevels: [], defaultThinkingLevel: null });
    expect(resolveModelBinding(result)).toEqual(result);
    const inherited = updateModelBindingSettings(result, {}, ["systemPrompt", "maxTokens", "supportsImages"]);
    expect(inherited).toMatchObject({ maxTokens: 10000, systemPrompt: "global model", supportsImages: true });
    expect(binding.settings!.overrides).toEqual({});
  });
  it("an explicit off beats an inherited on and is a real change to save", () => {
    const binding = bindingForCustomModel("model");
    binding.settings!.baseline = { ...binding.settings!.baseline, availableForSubagents: true, nativeWebSearch: true };
    const off = updateModelBindingSettings(binding, { availableForSubagents: false, nativeWebSearch: false });
    expect(off).toMatchObject({ availableForSubagents: false, nativeWebSearch: false });
    expect(modelSettingsPatch({}, { availableForSubagents: false })).toEqual({
      set: { availableForSubagents: false }, unset: [],
    });
    const inherited = updateModelBindingSettings(off, {}, ["availableForSubagents", "nativeWebSearch"]);
    expect(inherited).toMatchObject({ availableForSubagents: true, nativeWebSearch: true });
  });
  it("resetting the final layer restores catalog provenance", () => {
    const binding = updateModelBindingSettings(bindingForCustomModel("model"), { contextWindow: 321000 });
    const reset = updateModelBindingSettings(binding, {}, ["contextWindow"]);
    expect(reset.contextWindowSource).toBe("catalog");
    expect(reset.contextWindow).toBe(128000);
  });
  it("null input capabilities override model defaults to follow the catalog", () => {
    const binding = bindingForCustomModel("model");
    binding.settings!.defaults = { supportsImages: true };
    expect(updateModelBindingSettings(binding, { supportsImages: null }).supportsImages).toBeNull();
  });
  it("keeps full route identity and wire spelling", () => {
    expect(modelSettingsKey("  VENDOR/Model ")).toBe("vendor/model");
    expect(modelSettingsKey("vendor/model")).not.toBe(modelSettingsKey("model"));
    const binding = bindingForCustomModel("VENDOR/Model");
    expect(resolveModelBinding(binding).id).toBe("VENDOR/Model");
  });
  it("patches only edited fields", () => {
    expect(modelSettingsPatch({ alias: "A", systemPrompt: "x", supportsImages: true }, { alias: "A", supportsImages: false })).toEqual({ set: { supportsImages: false }, unset: ["systemPrompt"] });
  });
});
