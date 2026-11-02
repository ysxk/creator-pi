import { foldFullwidthHeaderValue, HEADER_VALUE_ALLOWED } from "./header-value.js";
import { API_STYLES } from "./model-catalog.js";
import { MODEL_SETTING_FIELDS, modelSettingsValues, type ModelSettingsValues } from "./model-settings.js";
import { isSessionThinkingLevel } from "./thinking-levels.js";
import { THINKING_LEVELS, type ModelBinding } from "./types/models.js";
import type { ProviderCreateInput, ProviderPublic } from "./types/providers.js";

export const PROVIDER_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
export const PROVIDER_TRANSFER_MAX_CHANNELS = 200;
export type PortableModel = {
  id: string;
  baseline: ModelSettingsValues;
  overrides: ModelSettingsValues;
  contextWindowSource?: "catalog" | "user";
  maxTokensSource?: "catalog" | "user";
};
export type PortableProvider = {
  name: string;
  vendorKey: string;
  type: ProviderPublic["type"];
  protocol: string;
  authKind: string;
  enabled: boolean;
  baseUrl?: string;
  apiStyle?: string;
  models: PortableModel[];
  headers?: Record<string, string>;
  apiKey?: string;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
};
export type ProviderTransferFile = { format: "pi-desktop-channels"; version: 1; channels: PortableProvider[] };
export type ProviderTransferExportInput = { providerIds: string[]; includeSecrets: boolean };
export type ProviderTransferPreview = {
  token: string;
  channels: Array<{ index: number; name: string; protocol: string; modelCount: number; enabled: boolean; hasApiKey: boolean; hasHeaders: boolean; sameName: boolean }>;
};
export type ProviderTransferImportInput = { token: string; indices: number[] };
export type ProviderTransferResult = {
  items: Array<{ index: number; status: "imported" | "failed" | "cleanupFailed"; providerId?: string }>;
};

export function transferError(code = "CHANNEL_FILE_INVALID"): Error {
  return new Error(code);
}
function invalid(): never { throw transferError(); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => ["__proto__", "constructor", "prototype"].includes(key) || (keys && !keys.includes(key)))) invalid();
  return record;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim().length > 0) && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function integer(value: unknown): boolean { return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff; }
function thinking(value: unknown): boolean { return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value); }
function settings(value: unknown): void {
  const fields = object(value, MODEL_SETTING_FIELDS);
  for (const [key, item] of Object.entries(fields)) {
    const valid = key === "alias" ? typeof item === "string" && [...item].length <= 60 && !/[\r\n\0]/.test(item)
      : key === "systemPrompt" ? typeof item === "string" && new TextEncoder().encode(item).length <= 128 * 1024 && !item.includes("\0")
      : key === "contextWindow" || key === "maxTokens" ? integer(item)
      : key === "thinkingLevels" ? Array.isArray(item) && item.length <= 32 && item.every(thinking)
      : key === "defaultThinkingLevel" ? item === null || isSessionThinkingLevel(item)
      : key === "thinkingProtocol" ? item === "legacy" || item === "adaptive"
      : key.startsWith("supports") ? item === null || typeof item === "boolean"
      : typeof item === "boolean";
    if (!valid) invalid();
  }
}
const providerFields = ["name", "vendorKey", "type", "protocol", "authKind", "enabled", "baseUrl", "apiStyle", "models", "headers", "apiKey", "supportsReasoning", "supportedThinkingLevels", "contextWindow", "maxOutputTokens", "temperature"];
const reservedHeaders = new Set(["authorization", "proxy-authorization", "host", "content-type", "content-length", "cookie", "set-cookie", "connection", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "x-api-key", "api-key", "chatgpt-account-id", "x-opencode-session"]);

export function parseProviderTransfer(raw: string): ProviderTransferFile {
  if (new TextEncoder().encode(raw).length > PROVIDER_TRANSFER_MAX_BYTES) throw transferError("CHANNEL_FILE_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  const file = object(value, ["format", "version", "channels"]);
  if (file.format !== "pi-desktop-channels" || file.version !== 1) throw transferError("CHANNEL_FILE_VERSION");
  if (!Array.isArray(file.channels) || file.channels.length === 0 || file.channels.length > PROVIDER_TRANSFER_MAX_CHANNELS) invalid();
  for (const entry of file.channels) {
    const channel = object(entry, providerFields);
    if (typeof channel.type !== "string" || typeof channel.protocol !== "string" || typeof channel.authKind !== "string") invalid();
    if (!text(channel.name, 256) || !text(channel.vendorKey, 256) || !["native", "openai_compatible", "custom"].includes(String(channel.type)) ||
      !["openai_compatible", "openai", "anthropic", "google", "bedrock", "custom_http"].includes(String(channel.protocol)) ||
      !["none", "api_key", "api_key_and_base_url", "bearer", "azure_api_key", "aws_sdk_default", "custom_headers"].includes(String(channel.authKind)) || typeof channel.enabled !== "boolean") invalid();
    if (channel.baseUrl !== undefined) {
      if (!text(channel.baseUrl, 4096)) invalid();
      try {
        const url = new URL(channel.baseUrl as string);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
      } catch { invalid(); }
    }
    if (channel.apiStyle !== undefined && !API_STYLES.some((style) => style === channel.apiStyle)) invalid();
    if (channel.apiKey !== undefined && !text(channel.apiKey, 65536)) invalid();
    if (channel.headers !== undefined) {
      const headers = object(channel.headers);
      const seen = new Set<string>();
      if (Object.keys(headers).length > 32) invalid();
      for (const [key, item] of Object.entries(headers)) {
        if (typeof item !== "string") invalid();
        const normalized = foldFullwidthHeaderValue((item as string).trim());
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,255}$/.test(key) || reservedHeaders.has(key.toLowerCase()) || seen.has(key.toLowerCase()) ||
          new TextEncoder().encode(normalized).length > 4096 || !HEADER_VALUE_ALLOWED.test(normalized)) invalid();
        seen.add(key.toLowerCase());
      }
    }
    if (channel.supportsReasoning !== undefined && typeof channel.supportsReasoning !== "boolean") invalid();
    if (channel.supportedThinkingLevels !== undefined && (!Array.isArray(channel.supportedThinkingLevels) || channel.supportedThinkingLevels.length > 32 || !channel.supportedThinkingLevels.every(thinking))) invalid();
    for (const key of ["contextWindow", "maxOutputTokens"]) if (channel[key] !== undefined && !integer(channel[key])) invalid();
    if (channel.temperature !== undefined && (typeof channel.temperature !== "number" || !Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2)) invalid();
    if (!Array.isArray(channel.models) || channel.models.length > 1000) invalid();
    const modelIds = new Set<string>();
    for (const item of channel.models) {
      const model = object(item, ["id", "baseline", "overrides", "contextWindowSource", "maxTokensSource"]);
      if (!text(model.id, 512)) invalid();
      const id = (model.id as string).trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (modelIds.has(id)) invalid();
      modelIds.add(id);
      settings(model.baseline);
      settings(model.overrides);
      for (const key of ["contextWindowSource", "maxTokensSource"]) if (model[key] !== undefined && model[key] !== "catalog" && model[key] !== "user") invalid();
    }
  }
  return value as ProviderTransferFile;
}

export function providerTransferEligible(provider: Pick<ProviderPublic, "authKind" | "ownerPluginId">): boolean {
  return provider.authKind !== "oauth" && !provider.ownerPluginId;
}

export function portableProvider(provider: ProviderPublic, includeSecrets: boolean, apiKey?: string): PortableProvider {
  if (!providerTransferEligible(provider)) throw transferError("CHANNEL_NOT_PORTABLE");
  const result: PortableProvider = {
    name: provider.name, vendorKey: provider.vendorKey, type: provider.type, protocol: provider.protocol,
    authKind: provider.authKind, enabled: provider.enabled,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
    models: provider.models.map((model) => ({
      id: model.id,
      baseline: modelSettingsValues(model.settings?.baseline ?? model),
      overrides: modelSettingsValues(model.settings?.overrides ?? {}),
      ...(model.contextWindowSource ? { contextWindowSource: model.contextWindowSource } : {}),
      ...(model.maxTokensSource ? { maxTokensSource: model.maxTokensSource } : {}),
    })),
    ...(includeSecrets && provider.headers ? { headers: provider.headers } : {}),
    ...(includeSecrets && apiKey ? { apiKey } : {}),
  };
  for (const key of ["supportsReasoning", "supportedThinkingLevels", "contextWindow", "maxOutputTokens", "temperature"] as const) {
    if (provider[key] != null) Object.assign(result, { [key]: provider[key] });
  }
  return result;
}

export function providerTransferCreateInput(provider: PortableProvider): ProviderCreateInput {
  const { apiKey, models } = provider;
  return {
    name: provider.name, vendorKey: provider.vendorKey, type: provider.type,
    protocol: provider.protocol, authKind: provider.authKind, baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle, headers: provider.headers,
    supportsReasoning: provider.supportsReasoning, contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens, temperature: provider.temperature,
    ...(apiKey ? { secretValue: apiKey } : {}),
    models: models.map((model): ModelBinding => ({
      ...model.baseline, id: model.id,
      contextWindow: model.baseline.contextWindow ?? 128000,
      maxTokens: model.baseline.maxTokens ?? 8192,
      thinkingLevels: model.baseline.thinkingLevels ?? [],
      defaultThinkingLevel: model.baseline.defaultThinkingLevel ?? null,
      ...(model.contextWindowSource ? { contextWindowSource: model.contextWindowSource } : {}),
      ...(model.maxTokensSource ? { maxTokensSource: model.maxTokensSource } : {}),
      settings: { baseline: model.baseline, defaults: {}, overrides: model.overrides },
    })),
    supportedThinkingLevels: provider.supportedThinkingLevels as ProviderCreateInput["supportedThinkingLevels"],
  };
}
