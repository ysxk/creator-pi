import { fileTypeOf, type FileTypeGlyph } from "../lib/file-type";
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

/**
 * The mark for a path's language or format, or nothing when the type is not
 * one we mark: the language's own logo, or a line glyph in the format's
 * colour for a format that has none.
 */
export function FileTypeBadge({ path }: { path: string }) {
  const type = fileTypeOf(path);
  if (!type) return null;
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
