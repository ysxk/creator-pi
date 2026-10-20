import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { normalizeToolResultImages } from "@earendil-works/pi-coding-agent/tool-result-images";

type ResultBlock = TextContent | ImageContent;
type Normalize = (blocks: ResultBlock[]) => Promise<ResultBlock[]>;

/**
 * Pictures a tool hands back (MCP, plugins, screenshots, restored history)
 * go to the provider with every later request, so one oversized or
 * undecodable image makes the whole conversation fail. pi normalizes them on
 * its own session path; a Desktop session runs `pi-agent-core` directly, so
 * the runtime does it here, with pi's own normalizer.
 *
 * Only `image/*` blocks are pictures. A clip or recording rides in an image
 * block with a `video/*` or `audio/*` type (D660 / D667) and passes untouched.
 */
function isPicture(block: unknown): block is ImageContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { mimeType?: unknown }).mimeType === "string" &&
    (block as { mimeType: string }).mimeType.startsWith("image/") &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

/**
 * What each picture became, per block object. The same blocks are seen on
 * every request of a session, and resizing is not free.
 */
const processed = new WeakMap<object, ResultBlock[]>();

const OMITTED = "[Image omitted: it could not be processed for the model.]";

async function normalizeOne(block: ImageContent, normalize: Normalize): Promise<ResultBlock[]> {
  const known = processed.get(block);
  if (known) return known;
  let result: ResultBlock[];
  try {
    result = await normalize([block]);
  } catch {
    // An image that cannot be checked must not reach the provider either.
    result = [{ type: "text", text: OMITTED }];
  }
  processed.set(block, result);
  return result;
}

/**
 * Resize oversized pictures and replace undecodable ones with a note.
 * Returns the same array when nothing changed.
 */
export async function normalizeToolResultPictures(
  content: ResultBlock[],
  normalize: Normalize = normalizeToolResultImages,
): Promise<ResultBlock[]> {
  if (!content.some(isPicture)) return content;
  const out: ResultBlock[] = [];
  let changed = false;
  for (const block of content) {
    if (!isPicture(block)) {
      out.push(block);
      continue;
    }
    const replaced = await normalizeOne(block, normalize);
    if (replaced.length !== 1 || replaced[0] !== block) changed = true;
    out.push(...replaced);
  }
  return changed ? out : content;
}

/**
 * The same for every tool result in a request context, which also covers
 * history restored from a transcript written before this check existed.
 * Returns the same array when nothing changed; messages are not mutated.
 */
export async function normalizeMessagePictures(
  messages: AgentMessage[],
  normalize: Normalize = normalizeToolResultImages,
): Promise<AgentMessage[]> {
  let out: AgentMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
    const content = await normalizeToolResultPictures(message.content as ResultBlock[], normalize);
    if (content === message.content) continue;
    out ??= [...messages];
    out[index] = { ...message, content } as AgentMessage;
  }
  return out ?? messages;
}
