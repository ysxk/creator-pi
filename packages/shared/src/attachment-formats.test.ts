import { describe, expect, it } from "vitest";
import {
  AUDIO_MIME_BY_EXTENSION,
  isAudioAttachment,
  isVideoAttachment,
  normalizeAudioMimeType,
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

describe("isAudioAttachment", () => {
  it("detects audio by MIME type", () => {
    expect(isAudioAttachment("audio/mpeg")).toBe(true);
    expect(isAudioAttachment("audio/x-m4a; charset=binary")).toBe(true);
    expect(isAudioAttachment("video/mp4")).toBe(false);
    expect(isAudioAttachment(undefined)).toBe(false);
  });

  it("detects audio by path or name extension", () => {
    expect(isAudioAttachment(undefined, "voice.mp3")).toBe(true);
    expect(isAudioAttachment(undefined, "/tmp/Memo 0001.M4A")).toBe(true);
    expect(isAudioAttachment(undefined, undefined, "a/b/take one.wav")).toBe(true);
    expect(isAudioAttachment(undefined, "notes.txt")).toBe(false);
    expect(isAudioAttachment(undefined, "clip.mp4")).toBe(false);
    expect(isAudioAttachment(undefined, "archive.mp3.bak")).toBe(false);
  });

  it("maps every audio extension to a concrete MIME type", () => {
    for (const extension of Object.keys(AUDIO_MIME_BY_EXTENSION)) {
      expect(AUDIO_MIME_BY_EXTENSION[extension]).toMatch(/^audio\//);
      expect(isAudioAttachment(undefined, `x.${extension}`)).toBe(true);
    }
  });

  it("keeps audio and video extensions apart", () => {
    for (const extension of Object.keys(AUDIO_MIME_BY_EXTENSION)) {
      expect(isVideoAttachment(undefined, `x.${extension}`)).toBe(false);
    }
  });
});

describe("normalizeAudioMimeType", () => {
  it("folds the system's spellings onto the provider tables' names", () => {
    expect(normalizeAudioMimeType("audio/mp3")).toBe("audio/mpeg");
    expect(normalizeAudioMimeType("audio/x-m4a")).toBe("audio/mp4");
    expect(normalizeAudioMimeType("audio/x-wav; rate=44100")).toBe("audio/wav");
    expect(normalizeAudioMimeType("Audio/FLAC")).toBe("audio/flac");
  });

  it("leaves a type it does not know as given", () => {
    expect(normalizeAudioMimeType("audio/opus")).toBe("audio/opus");
  });
});
