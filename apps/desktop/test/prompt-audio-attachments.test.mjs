import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_INLINE_AUDIO_BYTES } from "@pi-desktop/shared";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

const mp3 = Buffer.from("ID3 fake-mp3-payload");
const sessionId = "audio-attachments";

async function fixture(t, name = "memo.mp3") {
  const root = await mkdtemp(join(tmpdir(), "pi-audio-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const pasted = join(data, "scratch", sessionId, "pasted");
  await mkdir(pasted, { recursive: true });
  const path = join(pasted, name);
  await writeFile(path, mp3);
  return { data, path };
}

/** The main-process call for one pasted file, with every medium's gate named. */
function prepare(data, attachment, gates, prompt) {
  return preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    gates.vision ?? false,
    prompt,
    gates.video ?? false,
    gates.audio ?? false,
  );
}

test("a recording inlines as base64 when the model supports audio", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "memo.mp3", kind: "audio", mimeType: "audio/mpeg" };
  const [prepared] = await prepare(data, attachment, { audio: true }, `what is said in @${path}`);
  assert.equal(prepared.message.kind, "audio");
  assert.equal(prepared.message.mimeType, "audio/mpeg");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.equal(prepared.inlineData, mp3.toString("base64"));
  // The prompt already names the recording where the user placed it.
  assert.equal(appendPromptFallbackPaths(`what is said in @${path}`, [prepared]), `what is said in @${path}`);
});

test("a recording stays a durable audio reference without inline bytes when unsupported", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "memo.mp3", kind: "audio", mimeType: "audio/mpeg" };
  // A model that takes pictures and clips but not audio still gets the path.
  const [prepared] = await prepare(data, attachment, { vision: true, video: true }, "listen to this");
  assert.equal(prepared.message.kind, "audio");
  assert.equal(prepared.inlineData, undefined);
  const text = appendPromptFallbackPaths("listen to this", [prepared]);
  assert.ok(text.includes(path));
});

test("the system's spelling of an audio type is folded onto the provider's", async (t) => {
  const { data, path } = await fixture(t, "memo.m4a");
  const attachment = { path, name: "memo.m4a", kind: "file", mimeType: "audio/x-m4a" };
  const [prepared] = await prepare(data, attachment, { audio: true }, "describe");
  assert.equal(prepared.message.kind, "audio");
  assert.equal(prepared.message.mimeType, "audio/mp4");
  assert.ok(prepared.inlineData);
});

test("a generic type with an audio extension is still a recording", async (t) => {
  const { data, path } = await fixture(t, "take-one.wav");
  const attachment = { path, name: "take-one.wav", kind: "file", mimeType: "application/octet-stream" };
  const [prepared] = await prepare(data, attachment, { audio: true }, "describe");
  assert.equal(prepared.message.kind, "audio");
  // The extension names the type the request carries.
  assert.equal(prepared.message.mimeType, "audio/wav");
  assert.ok(prepared.inlineData);
});

test("a recording over the inline limit falls back to a path reference", async (t) => {
  const { data, path } = await fixture(t);
  // Sparse file one byte past the limit: stat reports the size without
  // consuming disk.
  const oversize = MAX_INLINE_AUDIO_BYTES + 1;
  await truncate(path, oversize);
  const attachment = { path, name: "memo.mp3", kind: "audio", mimeType: "audio/mpeg" };
  const [prepared] = await prepare(data, attachment, { audio: true }, "describe");
  assert.equal(prepared.inlineData, undefined);
  assert.equal(prepared.message.size, oversize);
  assert.equal(prepared.message.kind, "audio");
});

test("a clip keeps its own kind and gate beside a recording", async (t) => {
  const { data, path } = await fixture(t, "clip.webm");
  const attachment = { path, name: "clip.webm", kind: "file" };
  const [prepared] = await prepare(data, attachment, { audio: true }, "describe");
  assert.equal(prepared.message.kind, "video");
  assert.equal(prepared.message.mimeType, "video/webm");
  // Audio support does not inline a clip.
  assert.equal(prepared.inlineData, undefined);
});
