import { describe, expect, it, vi } from "vitest";
import {
  normalizeMessagePictures,
  normalizeToolResultPictures,
} from "./tool-result-pictures.js";

const picture = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const text = (value: string) => ({ type: "text" as const, text: value });

describe("tool result pictures", () => {
  it("replaces a picture the normalizer rejects and leaves media and text alone", async () => {
    const normalize = vi.fn(async () => [text("Image omitted: could not be decoded.")]);
    const clip = { type: "image" as const, data: "AAAA", mimeType: "video/mp4" };
    const voice = { type: "image" as const, data: "BBBB", mimeType: "audio/wav" };
    const content = [text("shot"), picture("bad-png"), clip, voice];

    const out = await normalizeToolResultPictures(content, normalize);

    expect(out).toEqual([text("shot"), text("Image omitted: could not be decoded."), clip, voice]);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledWith([picture("bad-png")]);
  });

  it("returns the same array when nothing changed, and processes a block once", async () => {
    const normalize = vi.fn(async (blocks: unknown[]) => blocks as never);
    const block = picture("ok-png");
    const content = [block];
    expect(await normalizeToolResultPictures(content, normalize)).toBe(content);
    expect(await normalizeToolResultPictures([block], normalize)).toEqual([block]);
    expect(normalize).toHaveBeenCalledTimes(1);
  });

  it("omits a picture when the normalizer itself fails", async () => {
    const normalize = vi.fn(async () => {
      throw new Error("worker crashed");
    });
    const out = await normalizeToolResultPictures([picture("x")], normalize);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "text" });
  });

  it("sanitizes restored tool results in a request context, not user or assistant rows", async () => {
    const normalize = vi.fn(async () => [text("omitted")]);
    const user = { role: "user", content: [picture("user-png")], timestamp: 1 };
    const tool = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "mcp__shot",
      content: [picture("restored-bad")],
      isError: false,
      timestamp: 2,
    };
    const messages = [user, tool] as never[];
    const out = (await normalizeMessagePictures(messages, normalize)) as any[];
    expect(out[0]).toBe(user);
    expect(out[1]).not.toBe(tool);
    expect(out[1].content).toEqual([text("omitted")]);
    expect(tool.content).toEqual([picture("restored-bad")]);
  });
});
