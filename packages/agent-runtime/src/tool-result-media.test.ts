import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_INLINE_AUDIO_BYTES, MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { readFile } from "node:fs/promises";
import {
  READ_AUDIO_HINT,
  READ_VIDEO_HINT,
  chatCompletionsAudioPart,
  chatCompletionsMediaParts,
  hostMediaReference,
  withToolResultMediaPayload,
  isToolResultMediaBlock,
  loadToolResultMedia,
  readMediaHint,
  toolResultMediaSupported,
  toolResultWithoutMediaBytes,
  VIEW_MEDIA_TOOL_DESCRIPTIONS,
  viewMediaPrompt,
  viewMediaToolNames,
  withoutReadMediaHints,
} from "./tool-result-media.js";

const mediaModel = {
  modalities: { input: ["text", "image", "video", "audio"], output: ["text"] },
  input: ["text", "image"],
};
const videoOnlyModel = { modalities: { input: ["text", "image", "video"], output: ["text"] }, input: ["text", "image"] };
const gemini = { apiStyle: "google_generative_ai", modelConfig: mediaModel } as never;
const relay = { apiStyle: "chat_completions", modelConfig: mediaModel } as never;
const responses = { apiStyle: "responses", modelConfig: mediaModel } as never;
/** Takes audio and video but has image input switched off. */
const audioWithoutImages = {
  apiStyle: "google_generative_ai",
  modelConfig: { modalities: { input: ["text", "video", "audio"], output: ["text"] }, input: ["text"] },
} as never;
const videoOnly = { apiStyle: "google_generative_ai", modelConfig: videoOnlyModel } as never;
const textOnly = {
  apiStyle: "google_generative_ai",
  modelConfig: { modalities: { input: ["text"], output: ["text"] }, input: ["text"] },
} as never;

describe("media in a tool result", () => {
  let dir: string;
  let clip: string;
  let memo: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tool-media-"));
    clip = join(dir, "clip.mp4");
    memo = join(dir, "memo.mp3");
    await writeFile(clip, Buffer.from("\u0000\u0000\u0000\u0018ftypmp42 payload"));
    await writeFile(memo, Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000 payload"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the reference host-core returns and nothing looser", () => {
    expect(
      hostMediaReference({ text: "x", video: { path: clip, mimeType: "video/mp4", size: 24 } }),
    ).toEqual({ kind: "video", path: clip, mimeType: "video/mp4", size: 24 });
    expect(
      hostMediaReference({ text: "x", audio: { path: memo, mimeType: "audio/mpeg", size: 18 } }),
    ).toEqual({ kind: "audio", path: memo, mimeType: "audio/mpeg", size: 18 });
    // Each key must name its own medium.
    expect(hostMediaReference({ video: { path: clip, mimeType: "image/png", size: 24 } })).toBeNull();
    expect(hostMediaReference({ audio: { path: memo, mimeType: "video/mp4", size: 18 } })).toBeNull();
    expect(hostMediaReference({ video: { path: "", mimeType: "video/mp4", size: 24 } })).toBeNull();
    expect(hostMediaReference({ images: [] })).toBeNull();
  });

  it("is carried to a capable model over the APIs that can deliver media", () => {
    for (const kind of ["video", "audio"] as const) {
      expect(toolResultMediaSupported(gemini, kind)).toBe(true);
      expect(toolResultMediaSupported(relay, kind)).toBe(true);
      expect(toolResultMediaSupported(responses, kind)).toBe(false);
      expect(toolResultMediaSupported(textOnly, kind)).toBe(false);
      expect(toolResultMediaSupported(undefined, kind)).toBe(false);
    }
    // Each medium has its own gate.
    expect(toolResultMediaSupported(videoOnly, "video")).toBe(true);
    expect(toolResultMediaSupported(videoOnly, "audio")).toBe(false);
  });

  it("attaches the clip and tells the model to watch it", async () => {
    const reference = { kind: "video" as const, path: clip, mimeType: "video/mp4", size: 24 };
    const result = await loadToolResultMedia(reference, "Video file clip.mp4.", gemini);
    expect(result.block?.mimeType).toBe("video/mp4");
    expect(Buffer.from(result.block!.data, "base64").subarray(4, 8).toString()).toBe("ftyp");
    expect(result.text).toContain("watch it directly");
    expect(isToolResultMediaBlock(result.block)).toBe(true);
  });

  it("attaches the recording and tells the model to listen to it", async () => {
    const reference = { kind: "audio" as const, path: memo, mimeType: "audio/mpeg", size: 18 };
    const result = await loadToolResultMedia(reference, "Audio file memo.mp3.", gemini);
    expect(result.block?.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.block!.data, "base64").subarray(0, 3).toString()).toBe("ID3");
    expect(result.text).toContain("listen to it directly");
    expect(result.text).toContain("do not transcribe");
    expect(isToolResultMediaBlock(result.block)).toBe(true);
  });

  it("says in words why media was not attached", async () => {
    const reference = { kind: "audio" as const, path: memo, mimeType: "audio/mpeg", size: 18 };
    const noAudio = await loadToolResultMedia(reference, "Audio file memo.mp3.", videoOnly);
    expect(noAudio.block).toBeUndefined();
    expect(noAudio.text).toContain("does not take audio input");

    const otherApi = await loadToolResultMedia(reference, "Audio file memo.mp3.", responses);
    expect(otherApi.block).toBeUndefined();
    expect(otherApi.text).toContain("attach the file to their message");
    expect(otherApi.text).toContain("listen to it directly");

    // Audio on, images off: pi-ai would drop the image-typed block the
    // recording rides in, so nothing may be attached or claimed.
    const noImages = await loadToolResultMedia(reference, "Audio file memo.mp3.", audioWithoutImages);
    expect(noImages.block).toBeUndefined();
    expect(noImages.text).toContain("only while its image input is on");
    expect(noImages.text).toContain("the audio is not attached");
    expect(noImages.text).not.toContain("is attached to this result");
    expect(noImages.text).toContain("attach the file to their message");

    // A delegate's model is not this provider's; it never receives the file.
    const delegate = await loadToolResultMedia(reference, "Audio file memo.mp3.", gemini, { delegate: true });
    expect(delegate.block).toBeUndefined();
    expect(delegate.text).toContain("subagent");
    expect(delegate.text).toContain("does not carry audio");

    await truncate(memo, MAX_INLINE_AUDIO_BYTES + 1);
    const tooLarge = await loadToolResultMedia(reference, "Audio file memo.mp3.", gemini);
    expect(tooLarge.block).toBeUndefined();
    expect(tooLarge.text).toContain("Audio files above");
    expect(tooLarge.text).toContain("cannot be attached");

    const missing = await loadToolResultMedia(
      { ...reference, path: join(dir, "gone.mp3") },
      "Audio file gone.mp3.",
      gemini,
    );
    expect(missing.block).toBeUndefined();
    expect(missing.text).toContain("could not be read");

    // The video wording is unchanged.
    const video = { kind: "video" as const, path: clip, mimeType: "video/mp4", size: 24 };
    const noVideo = await loadToolResultMedia(video, "Video file clip.mp4.", textOnly);
    expect(noVideo.text).toContain("does not take video input");
    await truncate(clip, MAX_INLINE_VIDEO_BYTES + 1);
    const clipTooLarge = await loadToolResultMedia(video, "Video file clip.mp4.", gemini);
    expect(clipTooLarge.text).toContain("Videos above");
  });

  it("leaves the runtime without the bytes", () => {
    const result = {
      content: [
        { type: "text", text: "Video file clip.mp4." },
        { type: "image", data: "AAAA", mimeType: "video/mp4" },
        { type: "image", data: "CCCC", mimeType: "audio/mpeg" },
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ],
      details: { videoAttached: true },
    };
    const stripped = toolResultWithoutMediaBytes(result);
    expect(JSON.stringify(stripped)).not.toContain("AAAA");
    expect(JSON.stringify(stripped)).not.toContain("CCCC");
    // A picture is small and still replays as a picture.
    expect(stripped.content[3]).toEqual({ type: "image", data: "BBBB", mimeType: "image/png" });
    expect(stripped.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("call ViewVideo again to watch it") });
    expect(stripped.content[2]).toMatchObject({ type: "text", text: expect.stringContaining("call ViewAudio again to listen to it") });
    expect(stripped.details).toEqual({ videoAttached: true });
    // Nothing to strip: the same object goes through untouched.
    const plain = { content: [{ type: "text", text: "ok" }] };
    expect(toolResultWithoutMediaBytes(plain)).toBe(plain);
  });

  it("declares a media tool only for a model the medium can reach", () => {
    expect(viewMediaToolNames(gemini)).toEqual(["ViewVideo", "ViewAudio"]);
    expect(viewMediaToolNames(relay)).toEqual(["ViewVideo", "ViewAudio"]);
    expect(viewMediaToolNames(videoOnly)).toEqual(["ViewVideo"]);
    // The model takes the media, but the result could not carry it.
    expect(viewMediaToolNames(responses)).toEqual([]);
    expect(viewMediaToolNames(audioWithoutImages)).toEqual([]);
    expect(viewMediaToolNames(textOnly)).toEqual([]);
    expect(viewMediaToolNames(undefined)).toEqual([]);
    expect(VIEW_MEDIA_TOOL_DESCRIPTIONS.ViewVideo).toContain("instead of extracting frames");
    expect(VIEW_MEDIA_TOOL_DESCRIPTIONS.ViewAudio).toContain("instead of transcribing");
  });

  it("prompts only for the media tools that are declared", () => {
    expect(viewMediaPrompt(new Set(["Read", "Bash"]))).toBe("");
    const both = viewMediaPrompt(new Set(["ViewVideo", "ViewAudio"]));
    expect(both).toMatch(/^# Watching and listening\n/);
    expect(both).toContain("call ViewVideo with its path");
    expect(both).toContain("call ViewAudio with its path");
    const video = viewMediaPrompt(new Set(["ViewVideo"]));
    expect(video).toContain("ViewVideo");
    expect(video).not.toContain("ViewAudio");
  });

  it("points Read at a media tool only where that tool is declared", async () => {
    expect(readMediaHint(gemini)).toBe(`${READ_VIDEO_HINT}${READ_AUDIO_HINT}`);
    expect(readMediaHint(videoOnly)).toBe(READ_VIDEO_HINT);
    expect(readMediaHint(responses)).toBe("");
    // No promise is made to a model the block would never reach.
    expect(readMediaHint(audioWithoutImages)).toBe("");
    expect(readMediaHint(undefined)).toBe("");
    expect(withoutReadMediaHints(`Read a file.${READ_VIDEO_HINT}${READ_AUDIO_HINT} More.`)).toBe(
      "Read a file. More.",
    );
    expect(READ_VIDEO_HINT).toContain("call ViewVideo to watch it");
    expect(READ_AUDIO_HINT).toContain("call ViewAudio to listen to it");

    const runtime = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    // The main agent hears it only when its own provider can take the media.
    expect(runtime).toContain("const mediaHint = readMediaHint(this.provider);");
    // A delegate never gets the tools, so the sentences are taken back out.
    expect(runtime).toContain("description: withoutReadMediaHints(tool.description),");
    expect(runtime).toContain(").filter((name) => !VIEW_MEDIA_TOOL_NAMES.has(name));");
  });

  it("names the Chat Completions part that carries a recording", () => {
    expect(chatCompletionsAudioPart("data:audio/mpeg;base64,AAAA")).toEqual({
      type: "input_audio",
      input_audio: { data: "AAAA", format: "mp3" },
    });
    expect(chatCompletionsAudioPart("data:audio/wav;base64,BBBB")).toEqual({
      type: "input_audio",
      input_audio: { data: "BBBB", format: "wav" },
    });
    // A container `input_audio` cannot name travels as the Files part a clip uses.
    expect(chatCompletionsAudioPart("data:audio/flac;base64,CCCC")).toEqual({
      type: "file",
      file: { file_data: "data:audio/flac;base64,CCCC" },
    });
  });

  it("delivers media on Chat Completions as file and audio parts, not pictures", async () => {
    const clipUrl = "data:video/mp4;base64,AAAA";
    const memoUrl = "data:audio/mpeg;base64,CCCC";
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
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            { type: "image_url", image_url: { url: memoUrl } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            { type: "image_url", image_url: { url: clipUrl } },
            { type: "image_url", image_url: { url: memoUrl } },
          ],
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }],
        },
      ],
    };
    const rewritten = chatCompletionsMediaParts(payload) as typeof payload;
    expect(rewritten.messages[1].content).toEqual([
      { type: "text", text: "Attached video from tool result:" },
      { type: "file", file: { file_data: clipUrl } },
    ]);
    expect(rewritten.messages[2].content).toEqual([
      { type: "text", text: "Attached audio from tool result:" },
      { type: "input_audio", input_audio: { data: "CCCC", format: "mp3" } },
    ]);
    expect(rewritten.messages[3].content[0]).toEqual({ type: "text", text: "Attached media from tool result:" });
    // A picture stays a picture, and the message that held it is not copied.
    expect(rewritten.messages[4]).toBe(payload.messages[4]);
    // Nothing to rewrite means no new payload at all.
    expect(chatCompletionsMediaParts({ messages: [payload.messages[4]] })).toBeUndefined();

    // The hook runs after the caller's own and only on this wire API.
    const options = { onPayload: async (value: unknown, _model: never): Promise<unknown> => value };
    expect(withToolResultMediaPayload(options, "google-generative-ai")).toBe(options);
    const hooked = withToolResultMediaPayload(options, "openai-completions");
    const sent = (await hooked.onPayload(payload, undefined as never)) as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(sent.messages[1].content[1]).toEqual({ type: "file", file: { file_data: clipUrl } });
    expect(sent.messages[2].content[1]).toEqual({ type: "input_audio", input_audio: { data: "CCCC", format: "mp3" } });
  });
});
