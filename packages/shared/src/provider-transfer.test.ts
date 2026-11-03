import { describe, expect, it } from "vitest";
import { parseProviderTransfer, portableProvider, providerTransferCreateInput, PROVIDER_TRANSFER_MAX_BYTES } from "./provider-transfer.js";
import type { ProviderPublic } from "./types/providers.js";

const provider: ProviderPublic = {
  id: "local-id", name: "Fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
  authKind: "api_key_and_base_url", enabled: false, baseUrl: "https://example.invalid/v1", apiStyle: "chat_completions",
  hasSecret: true, headers: { "X-Custom": "private-header" }, supportsReasoning: true, supportedThinkingLevels: ["off", "max"],
  createdAt: "local", updatedAt: "local",
  models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off"], defaultThinkingLevel: "off",
    contextWindowSource: "catalog", settings: { baseline: { contextWindow: 128000, maxTokens: 8192 }, defaults: { maxTokens: 16000, systemPrompt: "global prompt" }, overrides: { systemPrompt: "channel prompt", supportsImages: false } } }],
};
const wrap = (channels: unknown[]) => JSON.stringify({ format: "pi-desktop-channels", version: 1, channels });
const good = () => portableProvider(provider, false);

describe("channel transfer format", () => {
  it("round-trips channel intent without local identity, global defaults or credentials", () => {
    const channel = parseProviderTransfer(wrap([good()])).channels[0];
    const raw = JSON.stringify(channel);
    for (const value of ["local-id", "private-header", "global prompt", "createdAt", "hasSecret", "secretRef"]) expect(raw).not.toContain(value);
    expect(channel.enabled).toBe(false);
    const input = providerTransferCreateInput(channel);
    expect(input.models?.[0].settings).toEqual({ baseline: { contextWindow: 128000, maxTokens: 8192 }, defaults: {}, overrides: { systemPrompt: "channel prompt", supportsImages: false } });
    expect(input.secretValue).toBeUndefined();
    expect(input).not.toHaveProperty("enabled");
  });
  it("includes API key and headers only after explicit opt-in", () => {
    const privateChannel = portableProvider(provider, true, "synthetic-key");
    expect(parseProviderTransfer(wrap([privateChannel])).channels[0]).toMatchObject({ apiKey: "synthetic-key", headers: { "X-Custom": "private-header" } });
    expect(portableProvider(provider, false, "synthetic-key")).not.toHaveProperty("apiKey");
    expect(portableProvider(provider, false)).not.toHaveProperty("headers");
  });
  it("rejects OAuth and plugin records instead of converting them", () => {
    expect(() => portableProvider({ ...provider, authKind: "oauth" }, true)).toThrow("CHANNEL_NOT_PORTABLE");
    expect(() => portableProvider({ ...provider, ownerPluginId: "plugin" }, true)).toThrow("CHANNEL_NOT_PORTABLE");
  });
  it.each([null, "off", "omit"] as const)("preserves default thinking level %s", (level) => {
    const channel = good();
    channel.models[0].baseline.defaultThinkingLevel = level;
    channel.models[0].overrides.defaultThinkingLevel = level;
    const parsed = parseProviderTransfer(wrap([channel])).channels[0];
    expect(parsed.models[0].baseline.defaultThinkingLevel).toBe(level);
    expect(providerTransferCreateInput(parsed).models?.[0].settings?.overrides.defaultThinkingLevel).toBe(level);
  });
  it("keeps capability levels canonical", () => {
    const channel = { ...good(), models: [{ id: "m", baseline: { thinkingLevels: ["omit"] }, overrides: {} }] };
    expect(() => parseProviderTransfer(wrap([channel]))).toThrow("CHANNEL_FILE_INVALID");
  });
  it.each([{ "-X": "value" }, { "X-Test": "é".repeat(2049) }])("rejects invalid later headers before accepting a file", (headers) => {
    expect(() => parseProviderTransfer(wrap([good(), { ...good(), headers }]))).toThrow("CHANNEL_FILE_INVALID");
  });
  it("accepts valid header boundaries and Host folding", () => {
    const headers = { [`A${"-".repeat(255)}`]: "é".repeat(2048), "X-Fold": "ａ\u0085" };
    expect(parseProviderTransfer(wrap([{ ...good(), headers }])).channels[0].headers).toEqual(headers);
  });
  it.each([
    { authKind: "oauth" }, { ownerPluginId: "plugin" }, { id: "local" }, { secretRef: "secret" },
    { authKind: ["none"] }, { protocol: ["openai"] }, { type: ["custom"] },
    { models: [{ id: "m", baseline: {}, overrides: {}, contextWindowSource: ["user"] }] },
    { protocol: "unknown" }, { baseUrl: "file:///etc/passwd" }, { baseUrl: "https://u:p@example.invalid" },
    { baseUrl: "https://example.invalid/?token=private" }, { baseUrl: "https://example.invalid/#private" },
    { headers: { Authorization: "private" } }, { headers: { "X-Test": "private\r\nInjected: true" } },
    { headers: { "X-Test": "one", "x-test": "two" } }, { apiKey: "private\nkey" },
    { models: [{ id: "m", baseline: {}, overrides: { systemPrompt: 1 } }] },
    { models: [{ id: "m", baseline: {}, overrides: { contextWindow: -1 } }] },
    { models: [{ id: "m", baseline: {}, overrides: {}, defaults: {} }] },
    { models: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}`, baseline: {}, overrides: {} })) },
  ])("refuses malformed or privileged fields without echoing values", (change) => {
    expect(() => parseProviderTransfer(wrap([{ ...good(), ...change }]))).toThrow(/^CHANNEL_FILE_INVALID$/);
  });
  it("rejects nested pollution, duplicate models and oversized files", () => {
    const polluted = wrap([good()]).replace('"overrides":{', '"overrides":{"__proto__":{"polluted":true},');
    expect(() => parseProviderTransfer(polluted)).toThrow("CHANNEL_FILE_INVALID");
    expect({}).not.toHaveProperty("polluted");
    const channel = good(); channel.models.push({ ...channel.models[0], id: "FIXTURE-MODEL" });
    expect(() => parseProviderTransfer(wrap([channel]))).toThrow("CHANNEL_FILE_INVALID");
    expect(() => parseProviderTransfer(" ".repeat(PROVIDER_TRANSFER_MAX_BYTES + 1))).toThrow("CHANNEL_FILE_TOO_LARGE");
    expect(() => parseProviderTransfer(wrap(Array.from({ length: 201 }, good)))).toThrow("CHANNEL_FILE_INVALID");
  });
  it("rejects unknown versions and malformed JSON without echoing source", () => {
    expect(() => parseProviderTransfer('{"private-key":')).toThrow(/^CHANNEL_FILE_INVALID$/);
    expect(() => parseProviderTransfer('{"format":"pi-desktop-channels","version":2,"channels":[]}')).toThrow("CHANNEL_FILE_VERSION");
  });
});
