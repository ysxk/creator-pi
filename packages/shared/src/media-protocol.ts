/**
 * The host-owned `pi-media:` scheme plays local media in the renderer.
 *
 * A data URL cannot carry a video clip cheaply, and `file:` is not a renderable
 * origin under the app's CSP. The scheme hands the player a streaming URL
 * instead: the renderer only ever sees an opaque reference, and the main
 * process handler re-resolves and confines the path on every request
 * (Range/206 included, so seeking works).
 */
export const PI_MEDIA_SCHEME = "pi-media";

/** The URL a media element uses for one local path or attachment ref. */
export function mediaViewUrl(path: string): string {
  return `${PI_MEDIA_SCHEME}://local/${encodeURIComponent(path)}`;
}

/** The path a media URL carries, or null when it is not a media URL. */
export function parseMediaViewUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PI_MEDIA_SCHEME}:`) return null;
  if (parsed.hostname !== "local") return null;
  try {
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return path || null;
  } catch {
    return null;
  }
}
