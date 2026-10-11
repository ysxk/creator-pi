import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { normalizeAudioMimeType } from "@pi-desktop/shared";

const ATTACHMENT_HASH = /^[0-9a-f]{64}$/i;

/**
 * The extension the OS associates a stored media blob's type with. Only types
 * the chat plays itself are listed: a stored picture already opens through the
 * image viewer, and anything else keeps its hash name.
 */
const OPENABLE_MEDIA_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/aiff": "aiff",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
};

/** Give an extensionless attachment its media association without copying it. */
export async function openableMediaPath(
  dataDir: string,
  target: string,
  mimeType?: string,
): Promise<string> {
  const hash = basename(target);
  const extension = mimeType
    ? OPENABLE_MEDIA_EXTENSIONS[normalizeAudioMimeType(mimeType)]
    : undefined;
  if (!ATTACHMENT_HASH.test(hash) || !extension) {
    return target;
  }
  let attachmentRoot: string;
  try {
    attachmentRoot = await realpath(join(dataDir, "attachments"));
  } catch {
    return target;
  }
  if (dirname(target) !== attachmentRoot) return target;

  const directory = join(dataDir, "openable-attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("attachment open directory is a symbolic link");
  }
  const alias = join(directory, `${hash.toLowerCase()}.${extension}`);
  try {
    await symlink(target, alias, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(alias)).isSymbolicLink() || (await realpath(alias)) !== target) {
      throw new Error("attachment open path is already occupied");
    }
  }
  return alias;
}
