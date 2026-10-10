import type { ReactNode } from "react";
import {
  fileTypeOf,
  fileTypeOfCommand,
  fileTypeOfLanguage,
  type FileType,
  type FileTypeGlyph,
} from "../lib/file-type";
import { FILE_TYPE_LOGOS } from "../lib/file-type-logos";
import {
  IconArchive,
  IconAudio,
  IconDatabase,
  IconFileText,
  IconImage,
  IconSheet,
  IconVideo,
} from "./icons";

const GLYPHS: Record<FileTypeGlyph, typeof IconFileText> = {
  archive: IconArchive,
  audio: IconAudio,
  database: IconDatabase,
  image: IconImage,
  pdf: IconFileText,
  sheet: IconSheet,
  text: IconFileText,
  video: IconVideo,
};

function FileTypeMark({ type }: { type: FileType }) {
  const logo = FILE_TYPE_LOGOS[type.logo ?? type.id];
  const Glyph = type.glyph ? GLYPHS[type.glyph] : null;
  return (
    <span className="file-type-badge" data-file-type={type.id} aria-hidden="true">
      {logo ? (
        <img className="file-type-logo" src={logo} alt="" draggable={false} />
      ) : Glyph ? (
        <Glyph size={13} />
      ) : (
        <span className="file-type-letters">{type.label}</span>
      )}
    </span>
  );
}

/**
 * The mark for a path's language or format: the language's own logo, or a
 * line glyph in the format's colour for a format that has none. A type we do
 * not mark renders `fallback`, which is nothing unless the caller has a
 * generic icon to keep.
 */
export function FileTypeBadge({ path, fallback = null }: { path: string; fallback?: ReactNode }) {
  const type = fileTypeOf(path);
  return type ? <FileTypeMark type={type} /> : <>{fallback}</>;
}

/** The same mark for the language of the program a shell command runs, or nothing. */
export function CommandBadge({ command }: { command: string }) {
  const type = fileTypeOfCommand(command);
  return type ? <FileTypeMark type={type} /> : null;
}

/** The same mark for the language a code fence names, or nothing. */
export function LanguageBadge({ lang }: { lang: string }) {
  const type = fileTypeOfLanguage(lang);
  return type ? <FileTypeMark type={type} /> : null;
}
