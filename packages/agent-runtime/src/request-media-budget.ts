import type { Message } from "@earendil-works/pi-ai";
import { MAX_INLINE_VIDEO_BYTES } from "@pi-desktop/shared";
import { VIEW_AUDIO_TOOL_NAME, VIEW_VIDEO_TOOL_NAME } from "./tool-result-media.js";

/**
 * How much inline media one provider request may carry.
 *
 * A clip or a picture stays in the agent's context after the response that
 * received it, so every later request in the run carried it again: six clips
 * read one after another made a 209 MB request (157 MB of video as base64)
 * that the provider never answered, and each retry re-sent all of it. The
 * per-file bounds say nothing about the sum, so the sum gets a bound of its
 * own, measured where it is sent: the base64 the request actually carries.
 *
 * The bound is the base64 of one clip at `MAX_INLINE_VIDEO_BYTES`, so a clip
 * the per-file bound admits still travels on its own. It is a conservative
 * figure, not a measured provider limit: a 112 MB body was seen to pass a
 * CLIProxyAPI relay and a 209 MB one to time out, and nothing in between was
 * measured. Text and tool declarations ride on top of it uncounted.
 */
export const MAX_REQUEST_MEDIA_BASE64_BYTES = base64Length(MAX_INLINE_VIDEO_BYTES);

/** The length of the base64 text `rawBytes` bytes encode to. */
export function base64Length(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

type InlineMediaKind = "image" | "video" | "audio";

/** How each medium is spoken of in the note that stands in for it. */
const NOUNS: Record<InlineMediaKind, string> = { image: "image", video: "video", audio: "audio" };
const VIEW_TOOLS: Partial<Record<InlineMediaKind, string>> = {
  video: VIEW_VIDEO_TOOL_NAME,
  audio: VIEW_AUDIO_TOOL_NAME,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The medium an inline content block carries, or null for anything else. A
 * tool result's clip rides an image-typed block with a `video/*` or `audio/*`
 * type (see `tool-result-media.ts`), so the mime type decides.
 */
function inlineMediaKind(block: unknown): InlineMediaKind | null {
  if (!isRecord(block) || typeof block.data !== "string" || block.data.length === 0) return null;
  if (block.type === "video" || block.type === "audio") return block.type;
  if (block.type !== "image") return null;
  const mime = typeof block.mimeType === "string" ? block.mimeType : "";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
}

/**
 * The index of the last response that came back whole. Media in any message
 * before it has been in front of the model at least once; media after it has
 * not, because no request carrying it has been answered yet.
 */
function lastAnsweredIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      return index;
    }
  }
  return -1;
}

type MediaEntry = {
  messageIndex: number;
  blockIndex: number;
  key: string;
  kind: InlineMediaKind;
  mimeType: string;
  role: "user" | "toolResult";
  bytes: number;
  delivered: boolean;
};

/**
 * Every inline media block in the messages, oldest first. A block is keyed by
 * the message it belongs to — its tool call, or a user message's timestamp —
 * and its position there, which hold across the copies the runtime makes of
 * a message on its way to the wire.
 */
function mediaEntries(messages: readonly unknown[]): MediaEntry[] {
  const answered = lastAnsweredIndex(messages);
  const entries: MediaEntry[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    if (message.role !== "user" && message.role !== "toolResult") return;
    const owner =
      message.role === "toolResult"
        ? `tool:${String(message.toolCallId)}`
        : `user:${String(message.timestamp)}`;
    message.content.forEach((block, blockIndex) => {
      const kind = inlineMediaKind(block);
      if (!kind) return;
      const { data, mimeType } = block as { data: string; mimeType?: unknown };
      entries.push({
        messageIndex,
        blockIndex,
        key: `${owner}#${blockIndex}`,
        kind,
        mimeType: typeof mimeType === "string" && mimeType ? mimeType : kind,
        role: message.role as "user" | "toolResult",
        bytes: data.length,
        delivered: messageIndex < answered,
      });
    });
  });
  return entries;
}

/** How many media blocks a request carries and how much base64 they take. */
export function measureRequestMedia(messages: readonly unknown[]): {
  count: number;
  base64Bytes: number;
} {
  const entries = mediaEntries(messages);
  return {
    count: entries.length,
    base64Bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/**
 * The base64 of media no answered response has seen yet: what the next
 * request must carry whatever the budget leaves out of the older history.
 */
export function undeliveredMediaBase64Bytes(messages: readonly unknown[]): number {
  return mediaEntries(messages)
    .filter((entry) => !entry.delivered)
    .reduce((sum, entry) => sum + entry.bytes, 0);
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Why a clip or a recording of `rawBytes` cannot be attached to a tool result
 * now, or null when it fits.
 *
 * It must fit beside the media nothing has answered yet — earlier results of
 * the same tool batch, or a prompt's attachments — because none of that can
 * be left out of the next request. Media already answered does not count: the
 * budget makes room by leaving it out. A refused file is not lost; once the
 * model has answered what is attached, the same call fits.
 */
export function mediaBudgetRefusal(
  kind: "video" | "audio",
  rawBytes: number,
  messages: readonly unknown[],
  limit: number = MAX_REQUEST_MEDIA_BASE64_BYTES,
): string | null {
  const pending = undeliveredMediaBase64Bytes(messages);
  const total = pending + base64Length(rawBytes);
  if (total <= limit) return null;
  const tool = VIEW_TOOLS[kind];
  return (
    `The ${kind} is not attached: with the media already attached and not yet looked at, ` +
    `this request would carry ${megabytes(total)} of media, over the ${megabytes(limit)} one request carries. ` +
    `Look at what is already attached first, then call ${tool} for this file again in a later step.`
  );
}

/**
 * The note that takes a left-out block's place. It says plainly that the
 * media is gone from this request and how to get it back, so the model does
 * not answer as though it could still see it.
 */
function omittedMediaNote(entry: MediaEntry, limit: number): string {
  const noun = NOUNS[entry.kind];
  const why =
    `was left out of this request: one request carries at most ${megabytes(limit)} of media, ` +
    "and newer media needed the room. You received it in an earlier request.";
  if (entry.role === "user") {
    return `[The ${entry.mimeType} ${noun} the user attached here ${why} If you need it again, ask the user to attach it again.]`;
  }
  const tool = VIEW_TOOLS[entry.kind];
  return tool
    ? `[The ${entry.mimeType} ${noun} attached to this result ${why} If you need it again, call ${tool} on the same file.]`
    : `[The ${entry.mimeType} ${noun} attached to this result ${why} If you need it again, run the tool again.]`;
}

export type RequestMediaBudgetResult = {
  messages: Message[];
  /** Media blocks replaced by a note in this request. */
  omitted: number;
  /** Blocks left out for the first time by this call. */
  newlyOmitted: number;
  /** Base64 of the media the request still carries. */
  base64Bytes: number;
  /** True when media nothing has answered yet exceeds the budget on its own. */
  overBudget: boolean;
};

export type RequestMediaBudget = {
  apply(messages: Message[]): RequestMediaBudgetResult;
};

/**
 * Keep a request's inline media within `limit` by leaving out the oldest
 * media the model has already received, each replaced by a note.
 *
 * Media no answered response has seen is never left out: the model has not
 * looked at it yet, so dropping it would lose it unseen. `ViewVideo` and
 * `ViewAudio` refuse a file that would push such media past the budget (see
 * `loadToolResultMedia`), so in a run of tool calls the budget is met. Media
 * the user attaches in one message is not checked against it here, and a
 * request it overflows is sent anyway and reported by `overBudget`.
 *
 * A block left out stays left out for the life of this budget, even when the
 * history later shrinks below the limit, so the request does not change shape
 * from one turn to the next. The caller's messages are never modified.
 */
export function createRequestMediaBudget(
  limit: number = MAX_REQUEST_MEDIA_BASE64_BYTES,
): RequestMediaBudget {
  const omittedKeys = new Set<string>();
  return {
    apply(messages) {
      const entries = mediaEntries(messages);
      let total = 0;
      for (const entry of entries) {
        if (!omittedKeys.has(entry.key)) total += entry.bytes;
      }
      let newlyOmitted = 0;
      for (const entry of entries) {
        if (total <= limit) break;
        if (!entry.delivered || omittedKeys.has(entry.key)) continue;
        omittedKeys.add(entry.key);
        total -= entry.bytes;
        newlyOmitted += 1;
      }
      const replaced = entries.filter((entry) => omittedKeys.has(entry.key));
      if (replaced.length === 0) {
        return { messages, omitted: 0, newlyOmitted: 0, base64Bytes: total, overBudget: total > limit };
      }
      const byMessage = new Map<number, Map<number, MediaEntry>>();
      for (const entry of replaced) {
        const blocks = byMessage.get(entry.messageIndex) ?? new Map<number, MediaEntry>();
        blocks.set(entry.blockIndex, entry);
        byMessage.set(entry.messageIndex, blocks);
      }
      const next = messages.map((message, messageIndex) => {
        const blocks = byMessage.get(messageIndex);
        if (!blocks || !Array.isArray(message.content)) return message;
        return {
          ...message,
          content: message.content.map((block, blockIndex) => {
            const entry = blocks.get(blockIndex);
            return entry ? { type: "text" as const, text: omittedMediaNote(entry, limit) } : block;
          }),
        } as Message;
      });
      return {
        messages: next,
        omitted: replaced.length,
        newlyOmitted,
        base64Bytes: total,
        overBudget: total > limit,
      };
    },
  };
}
