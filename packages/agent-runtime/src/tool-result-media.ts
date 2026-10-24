import { readFile, stat } from "node:fs/promises";
import { MAX_INLINE_AUDIO_BYTES, MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { audioFromModelConfig, videoFromModelConfig } from "./model-capabilities.js";
import { apiBindingForProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

/**
 * A clip or a recording the model asked to watch or hear, handed to it as media.
 *
 * `ViewVideo` and `ViewAudio` exist only for a model that takes the medium
 * over a wire API that can carry it in a tool result; for any other model they
 * are not declared and nothing in the prompt mentions them, so it handles the
 * file the way it can. host-core answers either tool with a reference — it has
 * applied the path policy — and the runtime attaches the file itself to the
 * tool result, so the model watches or listens instead of extracting frames or
 * transcribing with shell tools. `Read` refuses both kinds as binary.
 *
 * pi-ai's tool result carries text and image blocks only, so the media travels
 * as a block of that kind with a `video/*` or `audio/*` type, and each adapter
 * that can deliver it is accounted for here:
 *
 * - Gemini forwards the block as `inlineData` with the block's own mime type,
 *   nested in the function response — the exact shape Gemini reads media from.
 * - Chat Completions moves a tool result's media into a user message that
 *   follows it, as `image_url` parts. `withToolResultMediaPayload` rewrites
 *   the video ones into the `file` part a user-attached clip already uses, and
 *   the audio ones into `input_audio` (mp3, wav) or the same `file` part, which
 *   an OpenAI-compatible relay forwards to a multimodal upstream.
 *
 * Any other adapter would present the same bytes as a picture, so it is left
 * out, and the model is told in words that nothing was attached.
 */
export type ToolResultMediaKind = "video" | "audio";

export const VIEW_VIDEO_TOOL_NAME = "ViewVideo";
export const VIEW_AUDIO_TOOL_NAME = "ViewAudio";

const VIEW_TOOL_NAMES: Record<ToolResultMediaKind, string> = {
  video: VIEW_VIDEO_TOOL_NAME,
  audio: VIEW_AUDIO_TOOL_NAME,
};

/** Both media tools; a delegate gets neither, since its model is not this one. */
export const VIEW_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(VIEW_TOOL_NAMES));

export type HostMediaReference = {
  kind: ToolResultMediaKind;
  /** Absolute path host-core resolved and admitted. */
  path: string;
  mimeType: string;
  size: number;
};

/** The block a watched clip or a heard recording rides in; see the module note. */
export type ToolResultMediaBlock = { type: "image"; data: string; mimeType: string };

/** How each medium is spoken of to the model, and how large it may be. */
const MEDIA: Record<
  ToolResultMediaKind,
  { noun: string; plural: string; verb: string; instead: string; bound: number }
> = {
  video: {
    noun: "video",
    plural: "Videos",
    verb: "watch",
    instead: "do not extract frames",
    bound: MAX_INLINE_VIDEO_BYTES,
  },
  audio: {
    noun: "audio",
    plural: "Audio files",
    verb: "listen to",
    instead: "do not transcribe it with tools",
    bound: MAX_INLINE_AUDIO_BYTES,
  },
};

const MEDIA_KINDS: readonly ToolResultMediaKind[] = ["video", "audio"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The medium a mime type belongs to, or null for anything else. */
function mediaKindOfMime(mimeType: string): ToolResultMediaKind | null {
  for (const kind of MEDIA_KINDS) {
    if (mimeType.startsWith(`${kind}/`)) return kind;
  }
  return null;
}

/** The media reference in a host `ViewVideo` / `ViewAudio` result, or null. */
export function hostMediaReference(content: unknown): HostMediaReference | null {
  if (!isRecord(content)) return null;
  for (const kind of MEDIA_KINDS) {
    const reference = content[kind];
    if (!isRecord(reference)) continue;
    const { path, mimeType, size } = reference;
    if (
      typeof path !== "string" ||
      !path ||
      typeof mimeType !== "string" ||
      !mimeType.startsWith(`${kind}/`) ||
      typeof size !== "number" ||
      !Number.isFinite(size)
    ) {
      return null;
    }
    return { kind, path, mimeType, size };
  }
  return null;
}

/**
 * The sentences added to `Read`'s description that point a media file at its
 * own tool. Said only where that tool is declared: a delegate, or a model that
 * does not take the medium, must not be sent to a tool it does not have.
 */
export const READ_VIDEO_HINT =
  ` Read refuses a video file (mp4, mov, webm, …); call ${VIEW_VIDEO_TOOL_NAME} to watch it.`;
export const READ_AUDIO_HINT =
  ` Read refuses an audio file (mp3, wav, m4a, …); call ${VIEW_AUDIO_TOOL_NAME} to listen to it.`;

/** The `Read` description sentences for the media tools this provider's model gets. */
export function readMediaHint(
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
): string {
  return (
    (toolResultMediaSupported(provider, "video") ? READ_VIDEO_HINT : "") +
    (toolResultMediaSupported(provider, "audio") ? READ_AUDIO_HINT : "")
  );
}

/** The media tools declared for this provider's model, in a stable order. */
export function viewMediaToolNames(
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
): string[] {
  return MEDIA_KINDS.filter((kind) => toolResultMediaSupported(provider, kind)).map(
    (kind) => VIEW_TOOL_NAMES[kind],
  );
}

/** What each media tool tells the model it does. */
export const VIEW_MEDIA_TOOL_DESCRIPTIONS: Record<string, string> = {
  [VIEW_VIDEO_TOOL_NAME]:
    "Watch a video file natively: the clip itself (picture and sound) is attached to the result. " +
    "Takes mp4, mov, webm, mpeg, avi, wmv, flv and 3gp files up to the inline size limit. " +
    "Use this instead of extracting frames, screenshots or the audio track with ffmpeg or other shell tools.",
  [VIEW_AUDIO_TOOL_NAME]:
    "Listen to an audio file natively: the recording itself is attached to the result. " +
    "Takes mp3, wav, m4a, aac, flac, ogg and aiff files up to the inline size limit. " +
    "Use this instead of transcribing or converting it with whisper, ffmpeg or other shell tools.",
};

/**
 * The system-prompt block for the media tools that are declared, or "" when
 * none is. The tool descriptions say how; this says when, because a model
 * used to tool-only file access reaches for ffmpeg before it reads a schema.
 */
export function viewMediaPrompt(toolNames: ReadonlySet<string>): string {
  const video = toolNames.has(VIEW_VIDEO_TOOL_NAME);
  const audio = toolNames.has(VIEW_AUDIO_TOOL_NAME);
  if (!video && !audio) return "";
  const lines = ["# Watching and listening"];
  if (video) {
    lines.push(
      `- You take video input natively. To understand a video file, call ${VIEW_VIDEO_TOOL_NAME} with its path and watch it yourself. Do not extract frames or screenshots, split out its audio, or describe it from metadata with shell tools.`,
    );
  }
  if (audio) {
    lines.push(
      `- You take audio input natively. To understand an audio file, call ${VIEW_AUDIO_TOOL_NAME} with its path and listen to it yourself. Do not transcribe or convert it with shell tools.`,
    );
  }
  lines.push(
    "- Use shell tools on media only to produce a new file the user asked for (a cut, a conversion), not to understand one.",
  );
  return lines.join("\n");
}

/** A `Read` description with every media sentence taken back out, for a delegate. */
export function withoutReadMediaHints(description: string): string {
  return description.replace(READ_VIDEO_HINT, "").replace(READ_AUDIO_HINT, "");
}

function mediaFromModelConfig(
  kind: ToolResultMediaKind,
  modelConfig: RuntimeProviderConfig["modelConfig"] | undefined,
): boolean {
  return kind === "video"
    ? videoFromModelConfig(modelConfig)
    : audioFromModelConfig(modelConfig);
}

/**
 * What keeps a tool result from carrying this medium to the provider's model,
 * or null when it can.
 *
 * `image-input` is the block's own disguise catching up with it: the media
 * rides an image-typed block (see the module note), and pi-ai replaces every
 * image-typed block in a tool result with a placeholder for a model that
 * takes no images, before any adapter sees it. Audio and video have their own
 * switches, so a model can take them with images off, and then the bytes
 * would be dropped while the result still said they were attached.
 */
function toolResultMediaBlocker(
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
  kind: ToolResultMediaKind,
): "modality" | "api" | "image-input" | null {
  if (!provider || !mediaFromModelConfig(kind, provider.modelConfig)) return "modality";
  if (
    !TOOL_RESULT_MEDIA_APIS.has(
      apiBindingForProviderModel(provider as RuntimeProviderConfig).api,
    )
  ) {
    return "api";
  }
  return provider.modelConfig?.input?.includes("image") === true ? null : "image-input";
}

/** Whether a tool result can carry this medium to the provider's model. */
export function toolResultMediaSupported(
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
  kind: ToolResultMediaKind,
): boolean {
  return toolResultMediaBlocker(provider, kind) === null;
}

/** The wire APIs media can ride a tool result on; see the module note. */
const TOOL_RESULT_MEDIA_APIS: ReadonlySet<string> = new Set([
  "google-generative-ai",
  "openai-completions",
]);

const CHAT_COMPLETIONS_IMAGE_LEAD = "Attached image(s) from tool result:";
const CHAT_COMPLETIONS_MEDIA_LEAD: Record<ToolResultMediaKind | "mixed", string> = {
  video: "Attached video from tool result:",
  audio: "Attached audio from tool result:",
  mixed: "Attached media from tool result:",
};

/** The containers `input_audio.format` can name; any other audio rides a `file` part. */
const INPUT_AUDIO_FORMATS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

const AUDIO_DATA_URL = /^data:(audio\/[^;,]+)(?:;[^,]*?)?;base64,([\s\S]*)$/;

/**
 * The Chat Completions part that carries one audio data URL: `input_audio`
 * for the containers it names, the Files part a clip uses for the rest.
 */
export function chatCompletionsAudioPart(dataUrl: string): unknown {
  const match = AUDIO_DATA_URL.exec(dataUrl);
  const format = match ? INPUT_AUDIO_FORMATS[match[1].toLowerCase()] : undefined;
  return match && format
    ? { type: "input_audio", input_audio: { data: match[2], format } }
    : { type: "file", file: { file_data: dataUrl } };
}

/**
 * Turn the media parts of a Chat Completions request into the parts that
 * deliver them: `file` for a clip, `input_audio` or `file` for a recording.
 *
 * Returns the rewritten payload, or undefined when there was nothing to
 * rewrite. Only the messages and parts that change are copied; the media's
 * base64 is shared, never duplicated.
 */
export function chatCompletionsMediaParts(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
  let changed = false;
  const mediaPartKind = (part: unknown): ToolResultMediaKind | null => {
    if (
      !isRecord(part) ||
      part.type !== "image_url" ||
      !isRecord(part.image_url) ||
      typeof part.image_url.url !== "string" ||
      !part.image_url.url.startsWith("data:")
    ) {
      return null;
    }
    return mediaKindOfMime(part.image_url.url.slice("data:".length));
  };
  const messages = payload.messages.map((message) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
      return message;
    }
    const kinds = new Set<ToolResultMediaKind>();
    for (const part of message.content) {
      const kind = mediaPartKind(part);
      if (kind) kinds.add(kind);
    }
    if (kinds.size === 0) return message;
    changed = true;
    const onlyMedia = message.content.every(
      (part) => mediaPartKind(part) !== null || (isRecord(part) && part.type === "text"),
    );
    const lead = CHAT_COMPLETIONS_MEDIA_LEAD[kinds.size === 1 ? [...kinds][0]! : "mixed"];
    return {
      ...message,
      content: message.content.map((part) => {
        const kind = mediaPartKind(part);
        if (kind) {
          const url = (part as { image_url: { url: string } }).image_url.url;
          return kind === "audio"
            ? chatCompletionsAudioPart(url)
            : { type: "file", file: { file_data: url } };
        }
        return onlyMedia && isRecord(part) && part.text === CHAT_COMPLETIONS_IMAGE_LEAD
          ? { ...part, text: lead }
          : part;
      }),
    };
  });
  return changed ? { ...payload, messages } : undefined;
}

/**
 * Request options whose payload hook also delivers tool-result media on Chat
 * Completions. Other APIs get their options back untouched.
 */
export function withToolResultMediaPayload<
  T extends { onPayload?: (payload: unknown, model: never) => unknown },
>(options: T, api: string): T {
  if (api !== "openai-completions") return options;
  return {
    ...options,
    onPayload: async (payload: unknown, model: never) => {
      const base = await options.onPayload?.(payload, model);
      return chatCompletionsMediaParts(base ?? payload) ?? base;
    },
  };
}

/** Whether a content block is media placed by `loadToolResultMedia`. */
export function isToolResultMediaBlock(block: unknown): block is ToolResultMediaBlock {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.mimeType === "string" &&
    mediaKindOfMime(block.mimeType) !== null
  );
}

/**
 * Resolve a reference into what the model receives: the media when it can be
 * attached, and always a sentence saying which it was. The sentence matters as
 * much as the bytes — a model told plainly that nothing is attached falls back
 * to tools, and one told the file is there stops reaching for them.
 */
export async function loadToolResultMedia(
  reference: HostMediaReference,
  description: string,
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
  options: {
    delegate?: boolean;
    /** Why a file of this size cannot ride the next request, or null when it can. */
    admit?: (size: number) => string | null;
  } = {},
): Promise<{ text: string; block?: ToolResultMediaBlock }> {
  const { noun, plural, verb, instead, bound } = MEDIA[reference.kind];
  // A delegate runs on its own model, which this call cannot see; media sent
  // to a model that does not take it fails the delegate's whole request.
  if (options.delegate) {
    return {
      text: `${description} A subagent's tool result does not carry ${noun}, so the ${noun} is not attached. The main agent can call ${VIEW_TOOL_NAMES[reference.kind]} itself to ${verb} it.`,
    };
  }
  const blocker = toolResultMediaBlocker(provider, reference.kind);
  if (blocker === "modality") {
    return {
      text: `${description} The current model does not take ${noun} input, so the ${noun} is not attached.`,
    };
  }
  if (blocker !== null) {
    const why =
      blocker === "api"
        ? `A tool result cannot carry ${noun} over this provider's API format`
        : `A tool result can carry ${noun} to this model only while its image input is on`;
    return {
      text:
        `${description} ${why}, so the ${noun} is not attached. ` +
        `Ask the user to attach the file to their message (drag it in or @-mention it) to ${verb} it directly.`,
    };
  }
  let size: number;
  try {
    size = (await stat(reference.path)).size;
  } catch (error) {
    return { text: `${description} The ${noun} could not be read: ${String(error)}` };
  }
  if (size > bound) {
    return {
      text: `${description} ${plural} above ${bound} bytes cannot be attached, so the ${noun} is not attached.`,
    };
  }
  const refusal = options.admit?.(size);
  if (refusal) return { text: `${description} ${refusal}` };
  try {
    const data = (await readFile(reference.path)).toString("base64");
    return {
      text: `${description} The ${noun} is attached to this result: ${verb} it directly, ${instead}.`,
      block: { type: "image", data, mimeType: reference.mimeType },
    };
  } catch (error) {
    return { text: `${description} The ${noun} could not be read: ${String(error)}` };
  }
}

/**
 * A tool result as it leaves the runtime for the transcript and the database.
 *
 * The media belongs to the model's context for the turn that received it. The
 * persisted row keeps the reference and a note in its place: a hundred
 * megabytes of base64 must not ride the event stream or sit in a message row,
 * and a later turn that needs the file again reads it again.
 */
export function toolResultWithoutMediaBytes<T>(result: T): T {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  if (!result.content.some(isToolResultMediaBlock)) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (!isToolResultMediaBlock(block)) return block;
      const kind = mediaKindOfMime(block.mimeType) ?? "video";
      const { noun, verb } = MEDIA[kind];
      return {
        type: "text",
        text: `[${block.mimeType} ${noun} was attached to this result when it ran; call ${VIEW_TOOL_NAMES[kind]} again to ${verb} it]`,
      };
    }),
  } as T;
}
