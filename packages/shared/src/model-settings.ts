import type { ModelBinding, ModelLimitSource } from "./types/models.js";

export const MODEL_SETTING_FIELDS = [
  "alias", "contextWindow", "maxTokens", "thinkingLevels", "defaultThinkingLevel",
  "thinkingProtocol", "supportsImages", "supportsVideos", "supportsAudio",
  "supportsDocuments", "availableForSubagents", "nativeWebSearch", "systemPrompt",
] as const;
export type ModelSettingField = (typeof MODEL_SETTING_FIELDS)[number];
export type ModelSettingsValues = Partial<Pick<ModelBinding, ModelSettingField>>;
export type ModelSettingsLayers = {
  baseline: ModelSettingsValues;
  defaults: ModelSettingsValues;
  overrides: ModelSettingsValues;
};
export type ModelSettingsSnapshot = {
  version: 1;
  defaults: Record<string, ModelSettingsValues>;
  channels: Record<string, Record<string, ModelSettingsValues>>;
};
export type ModelSettingsUpdate = {
  modelId: string;
  providerId?: string;
  set?: ModelSettingsValues;
  unset?: ModelSettingField[];
};

export function modelSettingsKey(id: string): string {
  return id.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function modelSettingsValues(binding: ModelSettingsValues): ModelSettingsValues {
  return Object.fromEntries(MODEL_SETTING_FIELDS.flatMap((field) =>
    binding[field] === undefined ? [] : [[field, binding[field]]],
  ));
}

export function modelSettingSource(layers: ModelSettingsLayers, field: ModelSettingField) {
  return Object.hasOwn(layers.overrides, field) ? "channel"
    : Object.hasOwn(layers.defaults, field) ? "model" : "catalog";
}

function resolveLimitSource(
  layers: ModelSettingsLayers,
  field: "contextWindow" | "maxTokens",
  explicitSource: ModelLimitSource | undefined,
  seed: number,
): ModelLimitSource {
  const source = modelSettingSource(layers, field);
  if (source === "channel" || source === "model") return "user";
  if (explicitSource === "catalog") return "catalog";
  if (explicitSource === "user") return "user";
  const baselineValue = layers.baseline[field];
  if (baselineValue === undefined || baselineValue === seed) return "catalog";
  return "user";
}

export function resolveModelBinding(binding: ModelBinding): ModelBinding {
  if (!binding.settings) return binding;
  const { baseline, defaults, overrides } = binding.settings;
  const resolved = { ...binding };
  // A projection can be resolved again after refresh; never use its effective
  // fields as the next baseline or a cleared override would remain pinned.
  for (const field of MODEL_SETTING_FIELDS) Reflect.deleteProperty(resolved, field);
  Object.assign(resolved, baseline, defaults, overrides);
  resolved.contextWindow = resolved.contextWindow ?? 128_000;
  resolved.maxTokens = resolved.maxTokens ?? 8_192;
  resolved.thinkingLevels = resolved.thinkingLevels ?? [];
  resolved.defaultThinkingLevel = resolved.defaultThinkingLevel ?? null;
  resolved.contextWindowSource = resolveLimitSource(
    binding.settings,
    "contextWindow",
    binding.contextWindowSource,
    128_000,
  );
  resolved.maxTokensSource = resolveLimitSource(
    binding.settings,
    "maxTokens",
    binding.maxTokensSource,
    8_192,
  );
  return resolved;
}

export function withInheritedModelSettings(binding: ModelBinding): ModelBinding {
  if (binding.settings) return binding;
  return { ...binding, settings: { baseline: modelSettingsValues(binding), defaults: {}, overrides: {} } };
}

export function updateModelBindingSettings(
  binding: ModelBinding,
  set: ModelSettingsValues,
  unset: readonly ModelSettingField[] = [],
): ModelBinding {
  const layers = withInheritedModelSettings(binding).settings!;
  const overrides = { ...layers.overrides, ...modelSettingsValues(set) };
  for (const field of unset) delete overrides[field];
  const nextBinding: ModelBinding = { ...binding, settings: { ...layers, overrides } };
  if (unset.includes("contextWindow")) {
    nextBinding.contextWindowSource =
      layers.baseline.contextWindow === undefined || layers.baseline.contextWindow === 128_000
        ? "catalog"
        : undefined;
  }
  if (unset.includes("maxTokens")) {
    nextBinding.maxTokensSource =
      layers.baseline.maxTokens === undefined || layers.baseline.maxTokens === 8_192
        ? "catalog"
        : undefined;
  }
  return resolveModelBinding(nextBinding);
}

export function modelSettingsPatch(before: ModelSettingsValues, after: ModelSettingsValues) {
  const set: ModelSettingsValues = {};
  const unset: ModelSettingField[] = [];
  for (const field of MODEL_SETTING_FIELDS) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    if (after[field] === undefined) unset.push(field);
    else Object.assign(set, { [field]: after[field] });
  }
  return { set, unset };
}
