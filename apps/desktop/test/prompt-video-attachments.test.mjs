import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

const mp4 = Buffer.from("fake-mp4-payload");
const sessionId = "video-attachments";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-video-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const pasted = join(data, "scratch", sessionId, "pasted");
  await mkdir(pasted, { recursive: true });
  const path = join(pasted, "pasted-clip.mp4");
  await writeFile(path, mp4);
  return { data, path };
}

test("a video inlines as base64 when the model supports video", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-clip.mp4", kind: "video", mimeType: "video/mp4" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    true,
    `what happens in @${path}`,
    true,
  );
  assert.equal(prepared.message.kind, "video");
  assert.equal(prepared.message.mimeType, "video/mp4");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.equal(prepared.inlineData, mp4.toString("base64"));
  // The prompt already names the clip where the user placed it.
  assert.equal(appendPromptFallbackPaths(`what happens in @${path}`, [prepared]), `what happens in @${path}`);
});

test("a video stays a durable video reference without inline bytes when unsupported", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-clip.mp4", kind: "video", mimeType: "video/mp4" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    "look at this clip",
    false,
  );
  assert.equal(prepared.message.kind, "video");
  assert.equal(prepared.inlineData, undefined);
  // The agent still receives a readable path for the clip.
  const text = appendPromptFallbackPaths("look at this clip", [prepared]);
  assert.ok(text.includes(path));
});

test("a file-kind video attachment is reclassified by MIME and extension", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-clip.mp4", kind: "file" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    "describe",
    true,
  );
  assert.equal(prepared.message.kind, "video");
  assert.equal(prepared.message.mimeType, "video/mp4");
  assert.ok(prepared.inlineData);
});

test("a video over the inline limit falls back to a path reference", async (t) => {
  const { data, path } = await fixture(t);
  // Sparse file one byte past the limit: stat reports the size without
  // consuming disk.
  const { truncate } = await import("node:fs/promises");
  const { MAX_INLINE_VIDEO_BYTES } = await import("@pi-desktop/shared");
  const oversize = MAX_INLINE_VIDEO_BYTES + 1;
  await truncate(path, oversize);
  const attachment = { path, name: "pasted-clip.mp4", kind: "video", mimeType: "video/mp4" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    "describe",
    true,
  );
  assert.equal(prepared.inlineData, undefined);
  assert.equal(prepared.message.size, oversize);
  assert.equal(prepared.message.kind, "video");
});
