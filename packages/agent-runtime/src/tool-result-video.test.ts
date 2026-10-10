import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { readFile } from "node:fs/promises";
import {
  READ_VIDEO_HINT,
  chatCompletionsVideoParts,
  hostVideoReference,
  withToolResultVideoPayload,
  isToolResultVideoBlock,
  loadToolResultVideo,
  toolResultVideoSupported,
  toolResultWithoutVideoBytes,
} from "./tool-result-video.js";

const videoModel = { modalities: { input: ["text", "image", "video"], output: ["text"] }, input: ["text", "image"] };
const gemini = { apiStyle: "google_generative_ai", modelConfig: videoModel } as never;
const relay = { apiStyle: "chat_completions", modelConfig: videoModel } as never;
const responses = { apiStyle: "responses", modelConfig: videoModel } as never;
const textOnly = {
  apiStyle: "google_generative_ai",
  modelConfig: { modalities: { input: ["text"], output: ["text"] }, input: ["text"] },
} as never;

describe("video in a tool result", () => {
  let dir: string;
  let clip: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tool-video-"));
    clip = join(dir, "clip.mp4");
    await writeFile(clip, Buffer.from("\u0000\u0000\u0000\u0018ftypmp42 payload"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the reference host-core returns and nothing looser", () => {
    expect(
      hostVideoReference({ text: "x", video: { path: clip, mimeType: "video/mp4", size: 24 } }),
    ).toEqual({ path: clip, mimeType: "video/mp4", size: 24 });
    expect(hostVideoReference({ video: { path: clip, mimeType: "image/png", size: 24 } })).toBeNull();
    expect(hostVideoReference({ video: { path: "", mimeType: "video/mp4", size: 24 } })).toBeNull();
    expect(hostVideoReference({ images: [] })).toBeNull();
  });

  it("is carried to a video model over the APIs that can deliver a clip", () => {
    expect(toolResultVideoSupported(gemini)).toBe(true);
    expect(toolResultVideoSupported(relay)).toBe(true);
    expect(toolResultVideoSupported(responses)).toBe(false);
    expect(toolResultVideoSupported(textOnly)).toBe(false);
    expect(toolResultVideoSupported(undefined)).toBe(false);
  });

  it("attaches the clip and tells the model to watch it", async () => {
    const reference = { path: clip, mimeType: "video/mp4", size: 24 };
    const result = await loadToolResultVideo(reference, "Video file clip.mp4.", gemini);
    expect(result.block?.mimeType).toBe("video/mp4");
    expect(Buffer.from(result.block!.data, "base64").subarray(4, 8).toString()).toBe("ftyp");
    expect(result.text).toContain("watch it directly");
    expect(isToolResultVideoBlock(result.block)).toBe(true);
  });

  it("says in words why a clip was not attached", async () => {
    const reference = { path: clip, mimeType: "video/mp4", size: 24 };
    const noVideo = await loadToolResultVideo(reference, "Video file clip.mp4.", textOnly);
    expect(noVideo.block).toBeUndefined();
    expect(noVideo.text).toContain("does not take video input");

    const otherApi = await loadToolResultVideo(reference, "Video file clip.mp4.", responses);
    expect(otherApi.block).toBeUndefined();
    expect(otherApi.text).toContain("attach the file to their message");

    // A delegate's model is not this provider's; it never receives the clip.
    const delegate = await loadToolResultVideo(reference, "Video file clip.mp4.", gemini, { delegate: true });
    expect(delegate.block).toBeUndefined();
    expect(delegate.text).toContain("subagent");

    await truncate(clip, MAX_INLINE_VIDEO_BYTES + 1);
    const tooLarge = await loadToolResultVideo(reference, "Video file clip.mp4.", gemini);
    expect(tooLarge.block).toBeUndefined();
    expect(tooLarge.text).toContain("cannot be attached");

    const missing = await loadToolResultVideo(
      { ...reference, path: join(dir, "gone.mp4") },
      "Video file gone.mp4.",
      gemini,
    );
    expect(missing.block).toBeUndefined();
    expect(missing.text).toContain("could not be read");
  });

  it("leaves the runtime without the bytes", () => {
    const result = {
      content: [
        { type: "text", text: "Video file clip.mp4." },
        { type: "image", data: "AAAA", mimeType: "video/mp4" },
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ],
      details: { videoAttached: true },
    };
    const stripped = toolResultWithoutVideoBytes(result);
    expect(JSON.stringify(stripped)).not.toContain("AAAA");
    // A picture is small and still replays as a picture.
    expect(stripped.content[2]).toEqual({ type: "image", data: "BBBB", mimeType: "image/png" });
    expect(stripped.content[1]).toMatchObject({ type: "text" });
    expect(stripped.details).toEqual({ videoAttached: true });
    // Nothing to strip: the same object goes through untouched.
    const plain = { content: [{ type: "text", text: "ok" }] };
    expect(toolResultWithoutVideoBytes(plain)).toBe(plain);
  });

  it("tells only a model that will receive the clip that Read attaches it", async () => {
    const runtime = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    // The main agent hears it only when its own provider can take the clip.
    expect(runtime).toContain(
      "const videoHint = toolResultVideoSupported(this.provider) ? READ_VIDEO_HINT : \"\";",
    );
    // A delegate never receives one, so the sentence is taken back out.
    expect(runtime).toContain("description: tool.description.replace(READ_VIDEO_HINT, \"\"),");
    expect(READ_VIDEO_HINT).toContain("attaches the video itself");
  });

  it("delivers the clip on Chat Completions as a file part, not a picture", async () => {
    const clipUrl = "data:video/mp4;base64,AAAA";
    const payload = {
      model: "m",
      messages: [
        { role: "tool", tool_call_id: "c1", content: "Video file clip.mp4." },
        {
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            { type: "image_url", image_url: { url: clipUrl } },
          ],
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }],
        },
      ],
    };
    const rewritten = chatCompletionsVideoParts(payload) as typeof payload;
    expect(rewritten.messages[1].content).toEqual([
      { type: "text", text: "Attached video from tool result:" },
      { type: "file", file: { file_data: clipUrl } },
    ]);
    // A picture stays a picture, and the message that held it is not copied.
    expect(rewritten.messages[2]).toBe(payload.messages[2]);
    // Nothing to rewrite means no new payload at all.
    expect(chatCompletionsVideoParts({ messages: [payload.messages[2]] })).toBeUndefined();

    // The hook runs after the caller's own and only on this wire API.
    const options = { onPayload: async (value: unknown, _model: never): Promise<unknown> => value };
    expect(withToolResultVideoPayload(options, "google-generative-ai")).toBe(options);
    const hooked = withToolResultVideoPayload(options, "openai-completions");
    const sent = (await hooked.onPayload(payload, undefined as never)) as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(sent.messages[1].content[1]).toEqual({ type: "file", file: { file_data: clipUrl } });
  });
});
