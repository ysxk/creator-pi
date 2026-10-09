import { describe, expect, it } from "vitest";
import { convertMessages as convertOpenAiMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { convertMessages as convertGoogleContents } from "@earendil-works/pi-ai/api/google-shared";
import { estimateTextAndImageContentTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Model, UserMessage } from "@earendil-works/pi-ai";

/**
 * Contract tests for the pi-ai video-content patch
 * (patches/@earendil-works__pi-ai@1.0.1.patch).
 *
 * A `VideoContent` user part must serialize per protocol — an OpenAI Files
 * content part on chat-completions, an `inlineData` part on the native Gemini
 * API — instead of being mis-encoded as an `image_url` data URL, and context
 * estimation must not reject the block.
 */

const model = {
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.test",
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<"google-generative-ai">;

function userMessage(content: UserMessage["content"]): UserMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

const videoBase64 = Buffer.from("fake-mp4-bytes").toString("base64");

describe("pi-ai video content serialization", () => {
  it("serializes a video part as an OpenAI Files content part on chat-completions", () => {
    const params = convertOpenAiMessages(
      model as never,
      {
        messages: [
          userMessage([
            { type: "text", text: "what happens here" },
            { type: "video", data: videoBase64, mimeType: "video/mp4" },
          ]),
        ],
      } as never,
      {} as never,
      {},
    );
    const parts = params[0]!.content!;
    expect(parts[0]).toEqual({ type: "text", text: "what happens here" });
    expect(parts[1]).toEqual({
      type: "file",
      file: {
        file_data: `data:video/mp4;base64,${videoBase64}`,
      },
    });
  });

  it("keeps image parts as image_url data URLs alongside video parts", () => {
    const params = convertOpenAiMessages(
      model as never,
      {
        messages: [
          userMessage([
            { type: "image", data: "aW1n", mimeType: "image/png" },
            { type: "video", data: videoBase64, mimeType: "video/mp4" },
          ]),
        ],
      } as never,
      {} as never,
      {},
    );
    const parts = params[0]!.content!;
    expect(parts[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aW1n" },
    });
    expect((parts[1] as { type: string }).type).toBe("file");
  });

  it("serializes a video part as inlineData on the native Gemini API", () => {
    const contents = convertGoogleContents(model as never, {
      messages: [
        userMessage([
          { type: "text", text: "describe this clip" },
          { type: "video", data: videoBase64, mimeType: "video/mp4" },
        ]),
      ],
    } as never);
    expect(contents[0]?.parts as unknown[]).toEqual([
      { text: "describe this clip" },
      { inlineData: { mimeType: "video/mp4", data: videoBase64 } },
    ]);
  });

  it("estimates tokens for video parts instead of rejecting them", () => {
    expect(() =>
      estimateTextAndImageContentTokens([
        { type: "text", text: "hi" },
        { type: "video", data: videoBase64, mimeType: "video/mp4" },
      ] as never),
    ).not.toThrow();
  });
});
