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

/**
 * Audio container extensions a provider request can carry as inline base64.
 * Mirrors the Gemini audio input table (WAV, MP3, AIFF, AAC, OGG, FLAC) plus
 * the `m4a` a phone's voice memo comes as; unmatched extensions stay file
 * references so the agent can still read them with tools.
 */
export const AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "aiff",
  "aif",
  "aac",
  "ogg",
  "oga",
  "flac",
  "m4a",
] as const;

export const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};

/**
 * Spellings an OS or a browser gives the same audio type, folded onto the one
 * the provider tables name. Anything else is kept as given.
 */
const AUDIO_MIME_ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-aiff": "audio/aiff",
  "audio/x-flac": "audio/flac",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp4a-latm": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/vorbis": "audio/ogg",
};

/** The canonical audio MIME type for one the system reported, parameters dropped. */
export function normalizeAudioMimeType(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return AUDIO_MIME_ALIASES[base] ?? base;
}

/** Whether a prompt attachment is an audio file the model can receive inline. */
export function isAudioAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  const base = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (base?.startsWith("audio/")) return true;
  return AUDIO_EXTENSIONS.includes(
    attachmentExtension(...names) as (typeof AUDIO_EXTENSIONS)[number],
  );
}
