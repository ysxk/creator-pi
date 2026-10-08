import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateImageBatch } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import { resolveImageGenerationEndpoint } from "./image-generation-service";

/**
 * AI-generated PNG avatars for user subagents.
 *
 * The deterministic SVG is the default identity, but a subagent whose Markdown
 * describes a persona can carry a drawn mark instead. One square PNG is
 * generated per name into `<dataDir>/agent-capabilities/subagent-icons/` and
 * replaces the SVG until deleted; generation overwrites a previous PNG.
 *
 * The configured image-generation model does the drawing — the same endpoint
 * and credential rules the GenerateImages tool uses — so nothing here works
 * before the user configured one, and the refusal says so.
 */

const MAX_ICON_BYTES = 8 * 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function iconPath(dataDir: string, name: string): string | null {
  if (!SAFE_NAME.test(name)) return null;
  return join(dataDir, "agent-capabilities", "subagent-icons", `${name}.png`);
}

function avatarPrompt(name: string, description: string | undefined): string {
  const about = description?.trim().slice(0, 400);
  return [
    "A square app avatar icon for an AI assistant subagent.",
    `The subagent is named "${name}".`,
    about ? `It is described as: ${about}.` : "",
    "Flat vector style, simple bold shapes, centered subject, plain background,",
    "no text or letters, crisp at small sizes.",
  ]
    .filter(Boolean)
    .join(" ");
}

export type SubagentIconResult =
  | { kind: "png"; dataUrl: string }
  | { kind: "none" };

/** The stored PNG for one subagent, as a bounded data URL, or none. */
export async function readSubagentIcon(
  dataDir: string,
  name: string,
): Promise<SubagentIconResult> {
  const target = iconPath(dataDir, name);
  if (!target) return { kind: "none" };
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ICON_BYTES) {
      return { kind: "none" };
    }
    const bytes = await readFile(target);
    return { kind: "png", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch {
    return { kind: "none" };
  }
}

export type GenerateSubagentIconResult =
  | { ok: true; dataUrl: string }
  | { ok: false; errorCode: string; message: string };

/** Generate and store one subagent's avatar PNG with the configured model. */
export async function generateSubagentIcon(options: {
  dataDir: string;
  name: string;
  description?: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  allowFakeIp?: () => boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GenerateSubagentIconResult> {
  const target = iconPath(options.dataDir, options.name);
  if (!target) {
    return {
      ok: false,
      errorCode: "INVALID_ARGUMENT",
      message: "The subagent name cannot own an icon.",
    };
  }
  const endpoint = await resolveImageGenerationEndpoint({
    getHost: options.getHost,
    allowFakeIp: options.allowFakeIp,
  });
  if (!endpoint.ok) return endpoint;

  const scratch = join(options.dataDir, "agent-capabilities", "subagent-icons", ".tmp");
  await mkdir(scratch, { recursive: true });
  const staged = join(scratch, `avatar-${randomUUID()}`);
  try {
    const results = await generateImageBatch({
      input: { items: [{ prompt: avatarPrompt(options.name, options.description) }] },
      binding: endpoint.binding,
      signal: options.signal ?? new AbortController().signal,
      fetchImpl: options.fetchImpl,
      save: async (image) => {
        await writeFile(staged, image.bytes, { flag: "wx" });
        return staged;
      },
    });
    const succeeded = results.find((result) => result.status === "succeeded" && result.path);
    if (!succeeded?.path) {
      const failed = results.find((result) => result.status === "failed");
      return {
        ok: false,
        errorCode: failed?.errorCode ? String(failed.errorCode) : "IMAGE_GENERATION_FAILED",
        message: "The image model produced no avatar.",
      };
    }
    const bytes = await readFile(succeeded.path);
    await mkdir(join(options.dataDir, "agent-capabilities", "subagent-icons"), {
      recursive: true,
    });
    await writeFile(target, bytes, { flag: "w" });
    return { ok: true, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

/** Remove a stored PNG; the deterministic SVG takes over again. */
export async function deleteSubagentIcon(dataDir: string, name: string): Promise<void> {
  const target = iconPath(dataDir, name);
  if (target) await rm(target, { force: true }).catch(() => {});
}
