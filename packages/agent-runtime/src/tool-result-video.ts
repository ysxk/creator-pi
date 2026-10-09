import { readFile, stat } from "node:fs/promises";
import { MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { videoFromModelConfig } from "./model-capabilities.js";
import { apiBindingForProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

/**
 * A video the model asked to read, handed to it as video.
 *
 * host-core answers `Read` of a video file with a reference — it has applied
 * the path policy, and only the runtime knows whether the model can watch. A
 * model that takes video gets the clip itself inside the tool result, so it
 * watches instead of extracting frames with shell tools.
 *
 * pi-ai's tool result carries text and image blocks only. Its Gemini adapter
 * forwards a block as `inlineData` with the block's own mime type, nested in
 * the function response, which is the exact shape Gemini reads a clip from; so
 * the clip travels as a block of that kind with a `video/*` type. That is true
 * of the Gemini adapter alone, hence the API check: every other adapter would
 * present the same bytes as a picture.
 */
export type HostVideoReference = {
  /** Absolute path host-core resolved and admitted. */
  path: string;
  mimeType: string;
  size: number;
};

/** The block a watched clip rides in; see the note on the module. */
export type ToolResultVideoBlock = { type: "image"; data: string; mimeType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The video reference in a host `Read` result, or null when there is none. */
export function hostVideoReference(content: unknown): HostVideoReference | null {
  if (!isRecord(content) || !isRecord(content.video)) return null;
  const { path, mimeType, size } = content.video;
  if (
    typeof path !== "string" ||
    !path ||
    typeof mimeType !== "string" ||
    !mimeType.startsWith("video/") ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    return null;
  }
  return { path, mimeType, size };
}

/** Whether a tool result can carry a clip to this provider's model. */
export function toolResultVideoSupported(
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
): boolean {
  if (!provider || !videoFromModelConfig(provider.modelConfig)) return false;
  return apiBindingForProviderModel(provider as RuntimeProviderConfig).api === "google-generative-ai";
}

/** Whether a content block is a clip placed by `loadToolResultVideo`. */
export function isToolResultVideoBlock(block: unknown): block is ToolResultVideoBlock {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.mimeType === "string" &&
    block.mimeType.startsWith("video/")
  );
}

/**
 * Resolve a reference into what the model receives: the clip when it can be
 * attached, and always a sentence saying which it was. The sentence matters as
 * much as the clip — a model told plainly that nothing is attached falls back
 * to tools, and one told the clip is there stops reaching for them.
 */
export async function loadToolResultVideo(
  reference: HostVideoReference,
  description: string,
  provider: Pick<RuntimeProviderConfig, "apiStyle" | "modelConfig"> | undefined,
  options: { delegate?: boolean } = {},
): Promise<{ text: string; block?: ToolResultVideoBlock }> {
  // A delegate runs on its own model, which this call cannot see; a clip sent
  // to a model that does not take video fails the delegate's whole request.
  if (options.delegate) {
    return {
      text: `${description} A subagent's tool result does not carry video, so the video is not attached. The main agent can Read the file itself to watch it.`,
    };
  }
  if (!videoFromModelConfig(provider?.modelConfig)) {
    return {
      text: `${description} The current model does not take video input, so the video is not attached.`,
    };
  }
  if (!toolResultVideoSupported(provider)) {
    return {
      text:
        `${description} A tool result cannot carry video over this provider's API format, so the video is not attached. ` +
        "Ask the user to attach the file to their message (drag it in or @-mention it) to watch it directly.",
    };
  }
  let size: number;
  try {
    size = (await stat(reference.path)).size;
  } catch (error) {
    return { text: `${description} The video could not be read: ${String(error)}` };
  }
  if (size > MAX_INLINE_VIDEO_BYTES) {
    return {
      text: `${description} Videos above ${MAX_INLINE_VIDEO_BYTES} bytes cannot be attached, so the video is not attached.`,
    };
  }
  try {
    const data = (await readFile(reference.path)).toString("base64");
    return {
      text: `${description} The video is attached to this result: watch it directly, do not extract frames.`,
      block: { type: "image", data, mimeType: reference.mimeType },
    };
  } catch (error) {
    return { text: `${description} The video could not be read: ${String(error)}` };
  }
}

/**
 * A tool result as it leaves the runtime for the transcript and the database.
 *
 * The clip belongs to the model's context for the turn that watched it. The
 * persisted row keeps the reference and a note in its place: a hundred
 * megabytes of base64 must not ride the event stream or sit in a message row,
 * and a later turn that needs the clip again reads the file again.
 */
export function toolResultWithoutVideoBytes<T>(result: T): T {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  if (!result.content.some(isToolResultVideoBlock)) return result;
  return {
    ...result,
    content: result.content.map((block) =>
      isToolResultVideoBlock(block)
        ? {
            type: "text",
            text: `[${block.mimeType} video was attached to this result when it ran; Read the file again to watch it]`,
          }
        : block,
    ),
  } as T;
}
