/**
 * The language or format a path names, for the small badge that sits beside it
 * in tool rows and file chips.
 *
 * A reader scanning a turn cares which rows touched Rust and which touched
 * CSS; a generic document glyph on every row says nothing. Only types worth
 * telling apart at a glance are listed. Anything else returns null and keeps
 * the generic icon it had.
 */
export type FileType = {
  /** Selects the badge colour (`--ds-filetype-<id>`). */
  id: string;
  /** Two to four characters, as the language abbreviates itself. */
  label: string;
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
  cpp: { id: "c", label: "C++" },
  hpp: { id: "c", label: "H++" },
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
  sql: { id: "sql", label: "SQL" },
  json: { id: "json", label: "JSON" },
  yml: { id: "yaml", label: "YML" },
  yaml: { id: "yaml", label: "YML" },
  toml: { id: "config", label: "TOML" },
  md: { id: "md", label: "MD" },
  markdown: { id: "md", label: "MD" },
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
