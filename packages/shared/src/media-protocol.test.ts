import { describe, expect, it } from "vitest";
import { mediaViewUrl, parseMediaViewUrl, PI_MEDIA_SCHEME } from "./media-protocol.js";

describe("mediaViewUrl", () => {
  it("round-trips a path through the scheme", () => {
    const path = "/srv/clips/大厅 demo (1).mp4";
    const url = mediaViewUrl(path);
    expect(url.startsWith(`${PI_MEDIA_SCHEME}://local/`)).toBe(true);
    expect(parseMediaViewUrl(url)).toBe(path);
  });

  it("round-trips a workspace-relative ref and an attachment blob ref", () => {
    expect(parseMediaViewUrl(mediaViewUrl("videos/out.mp4"))).toBe("videos/out.mp4");
    expect(parseMediaViewUrl(mediaViewUrl("attachments/abc123"))).toBe("attachments/abc123");
  });

  it("round-trips a Windows path without its separators being mangled", () => {
    expect(parseMediaViewUrl(mediaViewUrl("C:\\Users\\skl\\clip.mp4"))).toBe(
      "C:\\Users\\skl\\clip.mp4",
    );
  });

  it("rejects other schemes, hosts, and empty paths", () => {
    expect(parseMediaViewUrl("https://example.test/v.mp4")).toBeNull();
    expect(parseMediaViewUrl(`${PI_MEDIA_SCHEME}://elsewhere/x`)).toBeNull();
    expect(parseMediaViewUrl(`${PI_MEDIA_SCHEME}://local/`)).toBeNull();
    expect(parseMediaViewUrl("not a url")).toBeNull();
  });
});
