/**
 * The language or format a path names, for the mark that sits beside it in
 * tool rows and file chips.
 *
 * A reader scanning a turn cares which rows touched Rust and which touched
 * CSS; a generic document glyph on every row says nothing. A language shows
 * its own logo; a format with no logo of its own (a spreadsheet, a clip, an
 * archive) shows a line glyph in its colour. Anything unlisted returns null
 * and keeps the generic icon it had.
 */
export type FileTypeGlyph =
  | "archive"
  | "audio"
  | "database"
  | "image"
  | "pdf"
  | "sheet"
  | "text"
  | "video";

export type FileType = {
  /** Selects the tint (`--ds-filetype-<id>`). */
  id: string;
  /** Two to four characters, as the language abbreviates itself. */
  label: string;
  /** Key into `FILE_TYPE_LOGOS` when it differs from `id`. */
  logo?: string;
  /** Line glyph for a format that has no logo. */
  glyph?: FileTypeGlyph;
};

const BY_EXTENSION: Record<string, FileType> = {
  ts: { id: "ts", label: "TS" },
  tsx: { id: "ts", label: "TSX" },
  mts: { id: "ts", label: "TS" },
  cts: { id: "ts", label: "TS" },
  js: { id: "js", label: "JS" },
  jsx: { id: "js", label: "JSX" },
  mjs: { id: "js", label: "JS" },
  cjs: { id: "js", label: "JS" },
  py: { id: "py", label: "PY" },
  rs: { id: "rs", label: "RS" },
  go: { id: "go", label: "GO" },
  c: { id: "c", label: "C" },
  h: { id: "c", label: "H" },
  cpp: { id: "c", label: "C++", logo: "cpp" },
  cc: { id: "c", label: "C++", logo: "cpp" },
  hpp: { id: "c", label: "H++", logo: "cpp" },
  java: { id: "java", label: "JV" },
  kt: { id: "kotlin", label: "KT" },
  swift: { id: "swift", label: "SW" },
  rb: { id: "ruby", label: "RB" },
  php: { id: "php", label: "PHP" },
  html: { id: "html", label: "HTML" },
  htm: { id: "html", label: "HTML" },
  css: { id: "css", label: "CSS" },
  scss: { id: "sass", label: "SCSS" },
  sass: { id: "sass", label: "SASS" },
  vue: { id: "vue", label: "VUE" },
  svelte: { id: "svelte", label: "SV" },
  sh: { id: "shell", label: "SH" },
  bash: { id: "shell", label: "SH" },
  zsh: { id: "shell", label: "SH" },
  sql: { id: "sql", label: "SQL", glyph: "database" },
  json: { id: "json", label: "JSON" },
  yml: { id: "yaml", label: "YML" },
  yaml: { id: "yaml", label: "YML" },
  toml: { id: "config", label: "TOML", glyph: "text" },
  md: { id: "md", label: "MD" },
  markdown: { id: "md", label: "MD" },
  txt: { id: "text", label: "TXT", glyph: "text" },
  log: { id: "text", label: "LOG", glyph: "text" },
  pdf: { id: "pdf", label: "PDF", glyph: "pdf" },
  csv: { id: "sheet", label: "CSV", glyph: "sheet" },
  tsv: { id: "sheet", label: "TSV", glyph: "sheet" },
  xls: { id: "sheet", label: "XLS", glyph: "sheet" },
  xlsx: { id: "sheet", label: "XLSX", glyph: "sheet" },
  png: { id: "image", label: "IMG", glyph: "image" },
  jpg: { id: "image", label: "IMG", glyph: "image" },
  jpeg: { id: "image", label: "IMG", glyph: "image" },
  gif: { id: "image", label: "IMG", glyph: "image" },
  webp: { id: "image", label: "IMG", glyph: "image" },
  svg: { id: "image", label: "SVG", glyph: "image" },
  mp4: { id: "video", label: "VID", glyph: "video" },
  mov: { id: "video", label: "VID", glyph: "video" },
  webm: { id: "video", label: "VID", glyph: "video" },
  mkv: { id: "video", label: "VID", glyph: "video" },
  mp3: { id: "audio", label: "AUD", glyph: "audio" },
  wav: { id: "audio", label: "AUD", glyph: "audio" },
  m4a: { id: "audio", label: "AUD", glyph: "audio" },
  flac: { id: "audio", label: "AUD", glyph: "audio" },
  zip: { id: "archive", label: "ZIP", glyph: "archive" },
  tar: { id: "archive", label: "TAR", glyph: "archive" },
  gz: { id: "archive", label: "GZ", glyph: "archive" },
  "7z": { id: "archive", label: "7Z", glyph: "archive" },
};

const BY_NAME: Record<string, FileType> = {
  dockerfile: { id: "docker", label: "DKR" },
  "cargo.toml": { id: "rs", label: "RS" },
  "cargo.lock": { id: "rs", label: "RS" },
  "tsconfig.json": { id: "ts", label: "TS" },
};

/** The type of the file a path or bare name refers to, or null. */
export function fileTypeOf(pathOrName: string): FileType | null {
  // A tool summary can carry a line suffix (`a.ts:12`); it is not the name.
  const leaf = (pathOrName.split(/[\\/]/).pop() ?? "").replace(/:\d+(?::\d+)?$/, "").toLowerCase();
  if (!leaf) return null;
  const named = BY_NAME[leaf];
  if (named) return named;
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[leaf.slice(dot + 1)] ?? null;
}
