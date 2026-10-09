import { fileTypeOf } from "../lib/file-type";

/** The language badge for a path, or nothing when the type is not one we mark. */
export function FileTypeBadge({ path }: { path: string }) {
  const type = fileTypeOf(path);
  if (!type) return null;
  return (
    <span className="file-type-badge" data-file-type={type.id} aria-hidden="true">
      {type.label}
    </span>
  );
}
