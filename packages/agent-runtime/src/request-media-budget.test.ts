import type { Message } from "@earendil-works/pi-ai";
import { MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import {
  base64Length,
  createRequestMediaBudget,
  MAX_REQUEST_MEDIA_BASE64_BYTES,
  measureRequestMedia,
  mediaBudgetRefusal,
  undeliveredMediaBase64Bytes,
} from "./request-media-budget.js";

let clock = 0;

function user(content: Message["content"] | string): Message {
  return { role: "user", content, timestamp: ++clock } as Message;
}

function answered(stopReason = "toolUse"): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "google-generative-ai",
    provider: "google",
    model: "gemini",
    usage: {},
    stopReason,
    timestamp: ++clock,
  } as unknown as Message;
}

/** A ViewVideo result whose clip takes `size` characters of base64. */
function viewed(id: string, size: number): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "ViewVideo",
    content: [
      { type: "text", text: `Video file /clips/${id}.mp4. The video is attached to this result.` },
      { type: "image", data: "A".repeat(size), mimeType: "video/mp4" },
    ],
    isError: false,
    timestamp: ++clock,
  } as unknown as Message;
}

function blocks(messages: Message[]): unknown[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as unknown[]) : [],
  );
}

function carriedClips(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .filter((message) =>
      (message.content as Array<{ type: string }>).some((block) => block.type === "image"),
    )
    .map((message) => (message as { toolCallId: string }).toolCallId);
}

describe("request media budget", () => {
  it("is the base64 of the largest clip the per-file bound admits", () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    expect(MAX_REQUEST_MEDIA_BASE64_BYTES).toBe(base64Length(MAX_INLINE_VIDEO_BYTES));
    expect(Buffer.alloc(1_000).toString("base64")).toHaveLength(base64Length(1_000));
  });

  it("counts every inline medium a request carries, tool-result clips included", () => {
    const messages = [
      user([
        { type: "text", text: "look" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "video", data: "BBBBBBBB", mimeType: "video/mp4" },
        { type: "audio", data: "CC", mimeType: "audio/mpeg" },
      ] as Message["content"]),
      answered(),
      viewed("v1", 12),
    ];
    expect(measureRequestMedia(messages)).toEqual({ count: 4, base64Bytes: 26 });
    expect(measureRequestMedia([user("plain text")])).toEqual({ count: 0, base64Bytes: 0 });
  });

  it("counts only media no answered response has seen as undelivered", () => {
    const messages = [user("go"), answered(), viewed("v1", 30), answered(), viewed("v2", 20)];
    expect(undeliveredMediaBase64Bytes(messages)).toBe(20);
    // A failed or aborted response did not see what it was sent.
    expect(undeliveredMediaBase64Bytes([...messages, answered("error")])).toBe(20);
    expect(undeliveredMediaBase64Bytes([...messages, answered("aborted")])).toBe(20);
    expect(undeliveredMediaBase64Bytes([...messages, answered("stop")])).toBe(0);
  });

  it("leaves the request untouched while it fits", () => {
    const budget = createRequestMediaBudget(100);
    const messages = [user("go"), answered(), viewed("v1", 40), answered(), viewed("v2", 40)];
    const result = budget.apply(messages);
    expect(result.messages).toBe(messages);
    expect(result).toMatchObject({ omitted: 0, newlyOmitted: 0, base64Bytes: 80, overBudget: false });
  });

  it("keeps six clips viewed one after another under the bound, newest first", () => {
    // The incident: six clips read one per step, every one staying in context.
    const budget = createRequestMediaBudget(100);
    const messages: Message[] = [user("watch all six"), answered()];
    const sizes = [30, 26, 35, 22, 28, 40];
    sizes.forEach((size, index) => {
      messages.push(viewed(`v${index + 1}`, size));
      const result = budget.apply(messages);
      // Every request fits, and the clip the model has not seen is always in it.
      expect(result.base64Bytes).toBeLessThanOrEqual(100);
      expect(carriedClips(result.messages)).toContain(`v${index + 1}`);
      expect(result.overBudget).toBe(false);
      messages.push(answered());
    });
    const last = budget.apply(messages);
    expect(carriedClips(last.messages)).toEqual(["v4", "v5", "v6"]);
    expect(last.omitted).toBe(3);
  });

  it("holds the incident's six large clips under the real bound", () => {
    // One string shared by every block keeps the test's memory to one clip.
    const clip = "A".repeat(40_000_000);
    const budget = createRequestMediaBudget();
    const messages: Message[] = [user("watch all six"), answered()];
    for (let index = 1; index <= 6; index += 1) {
      messages.push({
        ...viewed(`v${index}`, 0),
        content: [{ type: "image", data: clip, mimeType: "video/mp4" }],
      } as unknown as Message);
      const result = budget.apply(messages);
      expect(result.base64Bytes).toBeLessThanOrEqual(MAX_REQUEST_MEDIA_BASE64_BYTES);
      expect(carriedClips(result.messages)).toContain(`v${index}`);
      messages.push(answered());
    }
    // Without the budget the last request would have carried all six.
    expect(measureRequestMedia(messages).base64Bytes).toBe(240_000_000);
    expect(carriedClips(budget.apply(messages).messages)).toEqual(["v4", "v5", "v6"]);
  });

  it("puts a note naming the medium and the way back in a left-out block's place", () => {
    const budget = createRequestMediaBudget(50);
    const attached = user([
      { type: "text", text: "here" },
      { type: "video", data: "V".repeat(30), mimeType: "video/quicktime" },
    ] as Message["content"]);
    const messages = [attached, answered(), viewed("v1", 30), answered(), viewed("v2", 30)];
    const result = budget.apply(messages);
    const notes = blocks(result.messages).filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type: string }).type === "text" &&
        (block as { text: string }).text.includes("left out of this request"),
    );
    expect(notes.map((note) => note.text)).toEqual([
      expect.stringContaining("video/quicktime video the user attached here"),
      expect.stringContaining("call ViewVideo on the same file"),
    ]);
    expect(notes[0]!.text).toContain("ask the user to attach it again");
    expect(carriedClips(result.messages)).toEqual(["v2"]);
    // The caller's messages keep their bytes; only the request copy changes.
    expect((attached.content as Array<{ type: string }>)[1]!.type).toBe("video");
    expect((messages[2]!.content as Array<{ type: string }>)[1]!.type).toBe("image");
  });

  it("never leaves out media no answered response has seen, and says so when that alone is over", () => {
    const budget = createRequestMediaBudget(50);
    const messages = [user("go"), answered(), viewed("v1", 40), viewed("v2", 40)];
    const result = budget.apply(messages);
    expect(carriedClips(result.messages)).toEqual(["v1", "v2"]);
    expect(result).toMatchObject({ omitted: 0, base64Bytes: 80, overBudget: true });
  });

  it("keeps a left-out block out after the history shrinks back under the bound", () => {
    const budget = createRequestMediaBudget(50);
    const messages = [user("go"), answered(), viewed("v1", 30), answered(), viewed("v2", 30)];
    expect(carriedClips(budget.apply(messages).messages)).toEqual(["v2"]);
    // The newer clip leaves the context (as compaction or a refused call would
    // leave it): the older one fits again, but does not come back.
    const shrunk = messages.slice(0, 4);
    const result = budget.apply(shrunk);
    expect(carriedClips(result.messages)).toEqual([]);
    expect(result).toMatchObject({ omitted: 1, newlyOmitted: 0, base64Bytes: 0 });
    // The same request keeps the same shape on a retry.
    expect(budget.apply(messages).messages).toEqual(budget.apply(messages).messages);
  });

  it("refuses a file that would push unanswered media past the bound, and only then", () => {
    const limit = 100;
    const messages = [user("go"), answered(), viewed("v1", 90), answered(), viewed("v2", 40)];
    // v1 has been answered, so only v2 (40) must ride beside the new file.
    expect(mediaBudgetRefusal("video", 45, messages, limit)).toBeNull();
    const refusal = mediaBudgetRefusal("video", 60, messages, limit);
    expect(refusal).toContain("The video is not attached");
    expect(refusal).toContain("call ViewVideo for this file again in a later step");
    expect(mediaBudgetRefusal("audio", 60, messages, limit)).toContain("call ViewAudio");
    // Once the model has answered v2, the same file fits.
    expect(mediaBudgetRefusal("video", 60, [...messages, answered()], limit)).toBeNull();
    // A clip the per-file bound admits always fits on its own.
    expect(mediaBudgetRefusal("video", MAX_INLINE_VIDEO_BYTES, [user("go")])).toBeNull();
  });
});
