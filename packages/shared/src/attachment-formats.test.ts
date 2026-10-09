import { describe, expect, it } from "vitest";
import {
  isVideoAttachment,
  VIDEO_MIME_BY_EXTENSION,
} from "./attachment-formats.js";

describe("isVideoAttachment", () => {
  it("detects video by MIME type", () => {
    expect(isVideoAttachment("video/mp4")).toBe(true);
    expect(isVideoAttachment("video/quicktime; charset=binary")).toBe(true);
    expect(isVideoAttachment("image/png")).toBe(false);
    expect(isVideoAttachment(undefined)).toBe(false);
  });

  it("detects video by path or name extension", () => {
    expect(isVideoAttachment(undefined, "clip.mp4")).toBe(true);
    expect(isVideoAttachment(undefined, "/tmp/IMG_0001.MOV")).toBe(true);
    expect(isVideoAttachment(undefined, undefined, "a/b/webm clip.webm")).toBe(true);
    expect(isVideoAttachment(undefined, "notes.txt")).toBe(false);
    expect(isVideoAttachment(undefined, "archive.mp4.bak")).toBe(false);
  });

  it("prefers an explicit non-video MIME over a video-looking name", () => {
    expect(isVideoAttachment("application/octet-stream", "clip.mp4")).toBe(true);
    expect(isVideoAttachment("text/plain", "clip.mp4")).toBe(true);
  });

  it("maps every video extension to a concrete MIME type", () => {
    for (const extension of Object.keys(VIDEO_MIME_BY_EXTENSION)) {
      expect(VIDEO_MIME_BY_EXTENSION[extension]).toMatch(/^video\//);
      expect(isVideoAttachment(undefined, `x.${extension}`)).toBe(true);
    }
  });
});
