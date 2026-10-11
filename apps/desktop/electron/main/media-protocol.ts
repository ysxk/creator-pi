import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol, type CustomScheme } from "electron";
import {
  AUDIO_MIME_BY_EXTENSION,
  PI_MEDIA_SCHEME,
  parseMediaViewUrl,
  VIDEO_MIME_BY_EXTENSION,
} from "@pi-desktop/shared";

/**
 * Stream local media to the renderer over the host-owned `pi-media:` scheme.
 *
 * A transcript video cannot travel as a data URL (megabytes of base64 per
 * clip) and `file:` is not renderable under the app's CSP, so the player gets
 * this scheme instead. The renderer never names a filesystem path it was not
 * already shown: every request re-resolves the reference against the same
 * confined roots the chat's open/read IPC uses, and only a regular file inside
 * one of them is served. Range requests answer 206 with a sliced stream, which
 * is what makes seeking and progressive playback work.
 */

/** Resolved target for one media request, or null when it must not be served. */
export type MediaResolver = (ref: string) => Promise<string | null>;

const MIME_BY_EXTENSION: Record<string, string> = {
  ...VIDEO_MIME_BY_EXTENSION,
  ...AUDIO_MIME_BY_EXTENSION,
};

function mimeTypeFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/** Range request a media element asked for, as byte offsets into the file. */
export function parseMediaRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Privileges the scheme is reserved with, before the app is ready, by
 * `registerPluginSchemes`. `stream: true` keeps large media responses from
 * buffering whole files in memory; `standard`/`secure` let a media element in
 * the app origin load it without mixed-content objections.
 */
export const PI_MEDIA_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: PI_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/** Install the request handler. Idempotent; call once, after the app is ready. */
export function installMediaProtocol(resolve: MediaResolver): void {
  if (installed) return;
  installed = true;
  protocol.handle(PI_MEDIA_SCHEME, async (request) => {
    const ref = parseMediaViewUrl(request.url);
    if (!ref) return errorResponse(404, "not found");
    let path: string | null = null;
    try {
      path = await resolve(ref);
    } catch {
      return errorResponse(404, "not found");
    }
    if (!path) return errorResponse(404, "not found");
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return errorResponse(404, "not found");
      size = info.size;
    } catch {
      return errorResponse(404, "not found");
    }
    const mime = mimeTypeFor(path);
    const range = parseMediaRange(request.headers.get("range"), size);
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const body = Readable.toWeb(
      createReadStream(path, { start, end }),
    ) as unknown as ReadableStream;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": mime,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${size}` }
          : {}),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

let installed = false;
