/** SVG can be previewed locally, but must not be sent as a raw model image. */
export const SVG_MIME_TYPE = "image/svg+xml";

/** MIME parameters and legacy filename metadata must not bypass the SVG fallback. */
export function isSvgAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  return (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === SVG_MIME_TYPE ||
    names.some((name) => typeof name === "string" && /\.svg$/i.test(name.trim()))
  );
}

/**
 * Video container extensions a provider request can carry as inline base64.
 * Mirrors the Gemini multimodal input table; unmatched extensions stay file
 * references so the agent can still read them with tools.
 */
export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "webm",
  "mpeg",
  "mpg",
  "avi",
  "wmv",
  "flv",
  "3gp",
] as const;

export const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  "3gp": "video/3gpp",
};

function attachmentExtension(...names: (string | undefined)[]): string {
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    const dot = trimmed.lastIndexOf(".");
    if (dot >= 0) return trimmed.slice(dot + 1).toLowerCase();
  }
  return "";
}

/** Whether a prompt attachment is a video the model can receive inline. */
export function isVideoAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  const base = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (base?.startsWith("video/")) return true;
  return VIDEO_EXTENSIONS.includes(
    attachmentExtension(...names) as (typeof VIDEO_EXTENSIONS)[number],
  );
}
