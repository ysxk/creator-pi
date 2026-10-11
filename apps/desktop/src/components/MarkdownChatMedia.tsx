/**
 * Previews for media an assistant message names (see `lib/chat-media-refs`).
 *
 * The Markdown tree only knows that a block mentioned `out/final.mp4`. Whether
 * such a file exists, and where, is the host's answer: a name is completed
 * against the project, scratch and attachment roots the same way a click on
 * its chip is. A name that resolves to no file draws nothing, so prose about a
 * file that was never written does not grow an empty player.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type MouseEvent,
} from "react";
import { mediaViewUrl } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { toWorkspaceRel } from "../lib/chat-links";
import type { ChatMediaKind } from "../lib/chat-media-refs";
import { useReferencedImageDataUrl } from "../lib/use-referenced-image-data-url";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import { useAppStore } from "../stores/app-store";
import { AudioPlayer } from "./AudioPlayer";
import { IconAudio, IconVideo } from "./icons";

/**
 * What the transcript lends a Markdown tree so its media can be looked at.
 * A tree rendered without it (a README, a plan card) keeps its old behaviour:
 * no previews for named files, and an image opens as a file.
 */
export type MarkdownChatMedia = {
  /** Open the viewer on a picture, with the pictures around it to step through. */
  openImage: (trigger: HTMLElement, path: string) => void;
  /** Folders the reply names; a bare file name is also looked for in them. */
  folders: readonly string[];
  /** One preview per file in a message: the first mention to ask gets it. */
  claim: (file: string, owner: string) => boolean;
  release: (file: string, owner: string) => void;
};

export const MarkdownChatMediaContext = createContext<MarkdownChatMedia | null>(null);

/** Marks a picture the viewer can step to; the value is the file to load. */
export const CHAT_GALLERY_ATTRIBUTE = "data-chat-gallery-path";

const MAX_RESOLVED_ENTRIES = 256;
/** A file named before it is written is asked for again after this long. */
const MISSING_RETRY_MS = 4000;
/** ...a few times. A name that still finds nothing is prose, not a file. */
const MAX_LOOKUPS = 4;

const NO_FOLDERS: readonly string[] = [];
const resolvedPaths = new Map<string, string>();
const missingUntil = new Map<string, number>();
const pendingLookups = new Map<string, Promise<string | null>>();

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The first candidate the host can find, tried in order. */
async function firstMatch(candidates: readonly string[], sessionId: string | null): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const result = await api.fsResolveRef(candidate, sessionId ?? undefined);
      if (result.match) return result.match.absolutePath;
    } catch {
      // A lookup that fails is a file not found, as far as a preview goes.
    }
  }
  return null;
}

async function lookUp(
  key: string,
  candidates: readonly string[],
  sessionId: string | null,
): Promise<string | null> {
  const pending = pendingLookups.get(key);
  if (pending) return pending;
  const lookup = firstMatch(candidates, sessionId)
    .then((absolutePath) => {
      pendingLookups.delete(key);
      if (absolutePath) {
        if (resolvedPaths.size >= MAX_RESOLVED_ENTRIES) {
          const oldest = resolvedPaths.keys().next().value;
          if (oldest !== undefined) resolvedPaths.delete(oldest);
        }
        resolvedPaths.set(key, absolutePath);
        missingUntil.delete(key);
      } else {
        missingUntil.set(key, Date.now() + MISSING_RETRY_MS);
      }
      return absolutePath;
    });
  pendingLookups.set(key, lookup);
  return lookup;
}

/** The absolute path of a named file, once the host has found one. */
function useMentionedFile(
  path: string | null,
  baseDir: string,
  folders: readonly string[],
): string | null {
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const sessionId = useAppStore((s) => s.activeSessionId) ?? null;
  const ref = !path
    ? null
    : isAbsolutePath(path)
      ? path
      : toWorkspaceRel(path, workspacePath, baseDir) ?? path;
  // A bare name is half a path; the folders the reply named may be the rest.
  const bare = ref !== null && !/[\\/]/.test(ref);
  const folderKey = bare ? folders.join("\n") : "";
  const key = ref ? `${workspacePath ?? ""}\n${sessionId ?? ""}\n${ref}\n${folderKey}` : null;
  const [found, setFound] = useState<{ key: string; path: string } | null>(null);
  useEffect(() => {
    if (!key || !ref) return;
    if (resolvedPaths.has(key)) return;
    const candidates = [
      ref,
      ...(folderKey ? folderKey.split("\n").map((folder) => `${folder}/${ref}`) : []),
    ];
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lookups = 0;
    const ask = () => {
      lookups += 1;
      void lookUp(key, candidates, sessionId).then((absolutePath) => {
        if (!current) return;
        if (absolutePath) setFound({ key, path: absolutePath });
        // The reply may be describing a file a tool is still writing.
        else if (lookups < MAX_LOOKUPS) timer = setTimeout(ask, MISSING_RETRY_MS);
      });
    };
    const wait = (missingUntil.get(key) ?? 0) - Date.now();
    if (wait > 0) timer = setTimeout(ask, wait);
    else ask();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, ref, folderKey, sessionId]);
  if (!key) return null;
  return resolvedPaths.get(key) ?? (found?.key === key ? found.path : null);
}

function leafName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

function MentionedVideo({
  file,
  onContextMenu,
}: {
  file: string;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const openFileRef = useOpenChatFileRef();
  const [failed, setFailed] = useState(false);
  const name = leafName(file);
  // A container the renderer cannot decode still names a file worth opening.
  if (failed) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        title={file}
        onClick={() => openFileRef(file)}
        onContextMenu={onContextMenu}
      >
        <IconVideo size={14} aria-hidden />
        <span>{name}</span>
      </button>
    );
  }
  return (
    <figure className="chat-video chat-media-mention" onContextMenu={onContextMenu}>
      <video
        controls
        preload="metadata"
        src={mediaViewUrl(file)}
        title={name}
        onError={() => setFailed(true)}
      />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

function MentionedAudio({
  file,
  onContextMenu,
}: {
  file: string;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const openFileRef = useOpenChatFileRef();
  const [failed, setFailed] = useState(false);
  const name = leafName(file);
  // A container the renderer cannot decode still names a file worth opening.
  if (failed) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        title={file}
        onClick={() => openFileRef(file)}
        onContextMenu={onContextMenu}
      >
        <IconAudio size={14} aria-hidden />
        <span>{name}</span>
      </button>
    );
  }
  return (
    <figure className="chat-audio chat-media-mention" onContextMenu={onContextMenu}>
      <AudioPlayer src={mediaViewUrl(file)} title={name} onError={() => setFailed(true)} />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

function MentionedImage({
  file,
  media,
  onContextMenu,
}: {
  file: string;
  media: MarkdownChatMedia;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const dataUrl = useReferencedImageDataUrl(file);
  const name = leafName(file);
  if (!dataUrl) return null;
  const gallery = { [CHAT_GALLERY_ATTRIBUTE]: file };
  return (
    <figure className="chat-media-mention" onContextMenu={onContextMenu}>
      <img
        {...gallery}
        className="chat-image-local"
        src={dataUrl}
        alt={name}
        title={name}
        onClick={(event) => media.openImage(event.currentTarget, file)}
      />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

/** The preview under a block that named a clip or a drawing. */
export function MentionedMedia({
  path,
  kind,
  baseDir,
  onContextMenu,
}: {
  path: string;
  kind: ChatMediaKind;
  baseDir: string;
  onContextMenu?: (event: MouseEvent<HTMLElement>, file: string) => void;
}) {
  const media = useContext(MarkdownChatMediaContext);
  const file = useMentionedFile(media ? path : null, baseDir, media?.folders ?? NO_FOLDERS);
  const owner = useId();
  const [owned, setOwned] = useState<string | null>(null);
  useEffect(() => {
    if (!media || !file) return;
    if (media.claim(file, owner)) setOwned(file);
    return () => {
      media.release(file, owner);
      setOwned(null);
    };
  }, [media, file, owner]);
  if (!media || !file || owned !== file) return null;
  const openMenu = onContextMenu
    ? (event: MouseEvent<HTMLElement>) => onContextMenu(event, file)
    : undefined;
  return kind === "video" ? (
    <MentionedVideo file={file} onContextMenu={openMenu} />
  ) : kind === "audio" ? (
    <MentionedAudio file={file} onContextMenu={openMenu} />
  ) : (
    <MentionedImage file={file} media={media} onContextMenu={openMenu} />
  );
}
