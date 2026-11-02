import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseProviderTransfer, portableProvider, providerTransferCreateInput, providerTransferEligible,
  PROVIDER_TRANSFER_MAX_BYTES, PROVIDER_TRANSFER_MAX_CHANNELS, transferError,
  type ProviderPublic, type ProviderTransferFile, type ProviderTransferPreview, type ProviderTransferResult,
} from "@pi-desktop/shared";

type Host = { call<T>(method: string, input?: unknown): Promise<T> };
type Pickers = { open: () => Promise<string | undefined>; save: () => Promise<string | undefined> };
const PREVIEW_TTL = 5 * 60 * 1000;

export async function readProviderTransfer(path: string): Promise<ProviderTransferFile> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > PROVIDER_TRANSFER_MAX_BYTES) throw transferError("CHANNEL_FILE_TOO_LARGE");
    const buffer = Buffer.alloc(PROVIDER_TRANSFER_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > PROVIDER_TRANSFER_MAX_BYTES) throw transferError("CHANNEL_FILE_TOO_LARGE");
    return parseProviderTransfer(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await file.close(); }
}

export async function writeProviderTransfer(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.pi-channels-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export class ProviderTransferService {
  private preview?: { token: string; file: ProviderTransferFile };
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private closed = false;

  private readonly host: Host;
  private readonly pickers: Pickers;
  constructor(host: Host, pickers: Pickers) { this.host = host; this.pickers = pickers; }

  close(): void { this.closed = true; this.clear(); }
  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.preview = undefined;
  }
  private active(): void { if (this.closed) throw transferError("CHANNEL_TRANSFER_CLOSED"); }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    this.active();
    if (this.busy) throw transferError("CHANNEL_TRANSFER_BUSY");
    this.busy = true;
    try { return await run(); }
    catch (error) {
      const safeCodes = ["CHANNEL_FILE_INVALID", "CHANNEL_FILE_VERSION", "CHANNEL_FILE_TOO_LARGE", "CHANNEL_NOT_PORTABLE", "CHANNEL_SECRET_UNAVAILABLE", "CHANNEL_TRANSFER_CLOSED", "CHANNEL_PREVIEW_INVALID", "CHANNEL_EXPORT_INVALID"];
      const code = error instanceof Error && safeCodes.includes(error.message) ? error.message : "CHANNEL_TRANSFER_FAILED";
      throw transferError(code);
    } finally { this.busy = false; }
  }

  prepare(): Promise<ProviderTransferPreview | null> {
    return this.operation(async () => {
      this.clear();
      const path = await this.pickers.open();
      this.active();
      if (!path) return null;
      const file = await readProviderTransfer(path);
      this.active();
      const { providers } = await this.host.call<{ providers: ProviderPublic[] }>("providers.list", { includeDisabled: true });
      this.active();
      const token = randomUUID();
      this.preview = { token, file };
      this.timer = setTimeout(() => this.clear(), PREVIEW_TTL);
      this.timer.unref();
      return {
        token,
        channels: file.channels.map((channel, index) => ({
          index, name: channel.name, protocol: channel.apiStyle ?? channel.protocol,
          modelCount: channel.models.length, enabled: channel.enabled,
          hasApiKey: Boolean(channel.apiKey), hasHeaders: Boolean(Object.keys(channel.headers ?? {}).length),
          sameName: providers.some((provider) => provider.name === channel.name),
        })),
      };
    });
  }

  cancel(input: unknown): void {
    if (!input || typeof input !== "object" || Reflect.get(input, "token") !== this.preview?.token) return;
    this.clear();
  }

  confirm(input: unknown): Promise<ProviderTransferResult> {
    return this.operation(async () => {
      if (!input || typeof input !== "object") throw transferError("CHANNEL_PREVIEW_INVALID");
      const token = Reflect.get(input, "token");
      const indices: unknown = Reflect.get(input, "indices");
      const preview = this.preview;
      if (!preview || token !== preview.token || !Array.isArray(indices) || !indices.length || indices.length > preview.file.channels.length ||
        new Set(indices).size !== indices.length || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= preview.file.channels.length)) throw transferError("CHANNEL_PREVIEW_INVALID");
      this.clear();
      const result: ProviderTransferResult = { items: [] };
      for (const index of [...indices as number[]].sort((a, b) => a - b)) {
        const channel = preview.file.channels[index];
        let providerId: string | undefined;
        try {
          this.active();
          const { secretValue, ...input } = providerTransferCreateInput(channel);
          const created = await this.host.call<{ provider: ProviderPublic }>("providers.create", input);
          providerId = created.provider.id;
          this.active();
          if (!channel.enabled) await this.host.call("providers.update", { id: providerId, enabled: false });
          this.active();
          if (secretValue) await this.host.call("providers.setSecret", { id: providerId, secretValue });
          result.items.push({ index, status: "imported", providerId });
        } catch {
          if (providerId) {
            try { await this.host.call("providers.delete", { id: providerId }); }
            catch { result.items.push({ index, status: "cleanupFailed", providerId }); continue; }
          }
          result.items.push({ index, status: "failed" });
        }
      }
      return result;
    });
  }

  export(input: unknown): Promise<{ exported: number } | null> {
    return this.operation(async () => {
      if (!input || typeof input !== "object") throw transferError("CHANNEL_EXPORT_INVALID");
      const ids: unknown = Reflect.get(input, "providerIds");
      const includeSecrets: unknown = Reflect.get(input, "includeSecrets");
      if (typeof includeSecrets !== "boolean" || !Array.isArray(ids) || !ids.length || ids.length > PROVIDER_TRANSFER_MAX_CHANNELS ||
        ids.some((id) => typeof id !== "string" || id.length > 256) || new Set(ids).size !== ids.length) throw transferError("CHANNEL_EXPORT_INVALID");
      const path = await this.pickers.save();
      this.active();
      if (!path) return null;
      const { providers } = await this.host.call<{ providers: ProviderPublic[] }>("providers.list", { includeDisabled: true });
      this.active();
      const selected = providers.filter((provider) => ids.includes(provider.id));
      if (selected.length !== ids.length || selected.some((provider) => !providerTransferEligible(provider))) throw transferError("CHANNEL_NOT_PORTABLE");
      const channels = [];
      for (const provider of selected) {
        this.active();
        let apiKey: string | undefined;
        if (includeSecrets && provider.hasSecret) {
          const secret = await this.host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
          if (!secret.value) throw transferError("CHANNEL_SECRET_UNAVAILABLE");
          apiKey = secret.value;
        }
        channels.push(portableProvider(provider, includeSecrets, apiKey));
      }
      this.active();
      const raw = JSON.stringify({ format: "pi-desktop-channels", version: 1, channels }, null, 2) + "\n";
      parseProviderTransfer(raw);
      await writeProviderTransfer(path, raw);
      return { exported: channels.length };
    });
  }
}
