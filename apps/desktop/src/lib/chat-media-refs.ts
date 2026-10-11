/**
 * Media an assistant message merely names.
 *
 * A reply that says "saved to `out/final.mp4`" or lists a folder of clips in a
 * table leaves the reader a file name and nothing to look at. This pass finds
 * the file links the chat-link pass already made, keeps the ones that name a
 * clip or a recording the renderer can play or a vector drawing it can show,
 * and places a preview node under the block that mentions them. Whether the
 * file exists is not known here; the component that renders the node asks the
 * host and draws nothing for a name that resolves to no file.
 */
import { isHttpUrl, safeDecodeUri, type MdastNode } from "./chat-links.ts";

export type ChatMediaKind = "video" | "audio" | "image";

export type ChatMediaRef = { path: string; kind: ChatMediaKind };

/** The element the preview node becomes; the Markdown component map owns it. */
export const CHAT_MEDIA_TAG = "chat-media";

/** Clips Chromium decodes and the `pi-media:` handler has a type for. */
const VIDEO_RE = /\.(?:mp4|mov|webm)$/i;
/** Recordings Chromium decodes and the `pi-media:` handler has a type for. */
const AUDIO_RE = /\.(?:mp3|wav|m4a|flac|ogg|oga|aac)$/i;
/** Named drawings. Raster images are shown where the reply embeds them. */
const VECTOR_IMAGE_RE = /\.svg$/i;

/** What a path would preview as, or null when it is not previewed. */
export function chatMediaKind(path: string): ChatMediaKind | null {
  if (VIDEO_RE.test(path)) return "video";
  if (AUDIO_RE.test(path)) return "audio";
  if (VECTOR_IMAGE_RE.test(path)) return "image";
  return null;
}

/** Blocks a preview may sit inside, after the child that named the file. */
const FLOW_CONTAINERS = new Set(["root", "listItem", "blockquote"]);
/** Never a mention: code is quoted text, and an image is already shown. */
const NOT_A_MENTION = new Set(["code", "image", "definition", "html"]);

type PreviewNode = MdastNode & {
  data: { hName: string; hProperties: { path: string; kind: ChatMediaKind } };
  position?: unknown;
};

function mediaRefOfLink(url: string): ChatMediaRef | null {
  // A remote clip is the page's to play; only local files are previewed.
  if (!url || isHttpUrl(url)) return null;
  const path = safeDecodeUri(url);
  const kind = chatMediaKind(path);
  return kind ? { path, kind } : null;
}

function collectMentions(node: MdastNode, found: Map<string, ChatMediaRef>): void {
  if (NOT_A_MENTION.has(node.type)) return;
  if (node.type === "link" && typeof node.url === "string") {
    const ref = mediaRefOfLink(node.url);
    if (ref && !found.has(ref.path)) found.set(ref.path, ref);
    return;
  }
  for (const child of node.children ?? []) {
    if (child && typeof child.type === "string") collectMentions(child, found);
  }
}

/**
 * Put a preview node after each block that names previewable media.
 *
 * A list keeps its previews inside the item that named the file, and a quote
 * inside the quote, so a preview stays beside its mention; a table's previews
 * follow the table, because a cell cannot hold one.
 */
export function appendChatMediaPreviews(tree: MdastNode | null | undefined): void {
  if (!tree || !FLOW_CONTAINERS.has(tree.type) || !tree.children) return;
  const next: MdastNode[] = [];
  for (const child of tree.children) {
    if (!child || typeof child.type !== "string") continue;
    next.push(child);
    if (child.type === "list") {
      for (const item of child.children ?? []) appendChatMediaPreviews(item);
      continue;
    }
    if (child.type === "blockquote") {
      appendChatMediaPreviews(child);
      continue;
    }
    const found = new Map<string, ChatMediaRef>();
    collectMentions(child, found);
    for (const ref of found.values()) {
      const preview: PreviewNode = {
        type: "chatMedia",
        data: { hName: CHAT_MEDIA_TAG, hProperties: { path: ref.path, kind: ref.kind } },
        // The preview answers for the block it follows, so it shares its span.
        position: (child as { position?: unknown }).position,
      };
      next.push(preview);
    }
  }
  tree.children = next;
}

const MAX_MENTIONED_FOLDERS = 8;
const FENCE_RE = /^\s*(?:```|~~~)/;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/**
 * Folders a reply names in passing, in the order it names them.
 *
 * "Saved under `tmp/reference_videos/`", followed by a table of bare file
 * names, is how a batch of files is usually reported. The folder is the half
 * of each path the table leaves out, and often one the project index does not
 * list because it is ignored, so a bare name that resolves nowhere is tried
 * inside these. Only a code span that ends in a separator counts: that is a
 * deliberate way to write a folder, where a word in prose is not.
 */
export function mentionedFolders(markdown: string): string[] {
  const folders: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(INLINE_CODE_RE)) {
      const value = match[1].trim();
      if (!/[\\/]$/.test(value) || value.length > 256 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
      const folder = value.replace(/[\\/]+$/, "");
      if (!folder || folder === "." || folder === ".." || folder === "~") continue;
      if (!folders.includes(folder)) folders.push(folder);
      if (folders.length >= MAX_MENTIONED_FOLDERS) return folders;
    }
  }
  return folders;
}

/** unified attacher; runs after the chat file-link pass has made its links. */
export function remarkChatMediaPreviews() {
  return (tree: MdastNode) => {
    appendChatMediaPreviews(tree);
  };
}
