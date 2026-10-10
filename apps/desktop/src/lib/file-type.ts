/**
 * The language or format a path names, for the mark that sits beside it in
 * tool rows, file chips, the file tree and a code block's head.
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
  pyw: { id: "py", label: "PY" },
  pyi: { id: "py", label: "PY" },
  ipynb: { id: "py", label: "NB", logo: "jupyter" },
  rs: { id: "rs", label: "RS" },
  go: { id: "go", label: "GO" },
  c: { id: "c", label: "C" },
  h: { id: "c", label: "H" },
  cpp: { id: "c", label: "C++", logo: "cpp" },
  cc: { id: "c", label: "C++", logo: "cpp" },
  cxx: { id: "c", label: "C++", logo: "cpp" },
  hpp: { id: "c", label: "H++", logo: "cpp" },
  hh: { id: "c", label: "H++", logo: "cpp" },
  hxx: { id: "c", label: "H++", logo: "cpp" },
  m: { id: "objc", label: "OBJC" },
  mm: { id: "objc", label: "OBJC" },
  cs: { id: "csharp", label: "C#" },
  csx: { id: "csharp", label: "C#" },
  fs: { id: "fsharp", label: "F#" },
  fsx: { id: "fsharp", label: "F#" },
  java: { id: "java", label: "JV" },
  class: { id: "java", label: "JV" },
  jar: { id: "java", label: "JAR" },
  kt: { id: "kotlin", label: "KT" },
  kts: { id: "kotlin", label: "KT" },
  scala: { id: "scala", label: "SC" },
  sc: { id: "scala", label: "SC" },
  gradle: { id: "gradle", label: "GRDL" },
  clj: { id: "clojure", label: "CLJ" },
  cljs: { id: "clojure", label: "CLJ" },
  cljc: { id: "clojure", label: "CLJ" },
  edn: { id: "clojure", label: "EDN" },
  swift: { id: "swift", label: "SW" },
  dart: { id: "dart", label: "DART" },
  rb: { id: "ruby", label: "RB" },
  php: { id: "php", label: "PHP" },
  pl: { id: "perl", label: "PL" },
  pm: { id: "perl", label: "PM" },
  lua: { id: "lua", label: "LUA" },
  r: { id: "r", label: "R" },
  rmd: { id: "r", label: "RMD" },
  jl: { id: "julia", label: "JL" },
  ex: { id: "elixir", label: "EX" },
  exs: { id: "elixir", label: "EXS" },
  erl: { id: "erlang", label: "ERL" },
  hrl: { id: "erlang", label: "HRL" },
  hs: { id: "haskell", label: "HS" },
  lhs: { id: "haskell", label: "HS" },
  ml: { id: "ocaml", label: "ML" },
  mli: { id: "ocaml", label: "MLI" },
  elm: { id: "elm", label: "ELM" },
  zig: { id: "zig", label: "ZIG" },
  nim: { id: "nim", label: "NIM" },
  cr: { id: "crystal", label: "CR" },
  sol: { id: "solidity", label: "SOL" },
  wasm: { id: "wasm", label: "WASM" },
  wat: { id: "wasm", label: "WAT" },
  html: { id: "html", label: "HTML" },
  htm: { id: "html", label: "HTML" },
  css: { id: "css", label: "CSS" },
  scss: { id: "sass", label: "SCSS" },
  sass: { id: "sass", label: "SASS" },
  vue: { id: "vue", label: "VUE" },
  svelte: { id: "svelte", label: "SV" },
  astro: { id: "astro", label: "AST" },
  graphql: { id: "graphql", label: "GQL" },
  gql: { id: "graphql", label: "GQL" },
  xml: { id: "xml", label: "XML" },
  xsd: { id: "xml", label: "XSD" },
  xsl: { id: "xml", label: "XSL" },
  plist: { id: "xml", label: "XML" },
  sh: { id: "shell", label: "SH" },
  bash: { id: "shell", label: "SH" },
  zsh: { id: "shell", label: "SH" },
  fish: { id: "shell", label: "SH" },
  ps1: { id: "powershell", label: "PS" },
  psm1: { id: "powershell", label: "PS" },
  psd1: { id: "powershell", label: "PS" },
  vim: { id: "vim", label: "VIM" },
  tf: { id: "terraform", label: "TF" },
  tfvars: { id: "terraform", label: "TF" },
  nix: { id: "nix", label: "NIX" },
  cmake: { id: "cmake", label: "CMK" },
  tex: { id: "latex", label: "TEX" },
  sty: { id: "latex", label: "TEX" },
  bib: { id: "latex", label: "BIB" },
  sql: { id: "sql", label: "SQL", glyph: "database" },
  db: { id: "sql", label: "DB", glyph: "database" },
  sqlite: { id: "sql", label: "DB", logo: "sqlite" },
  sqlite3: { id: "sql", label: "DB", logo: "sqlite" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "json", label: "JSON" },
  json5: { id: "json", label: "JSON" },
  yml: { id: "yaml", label: "YML" },
  yaml: { id: "yaml", label: "YML" },
  toml: { id: "config", label: "TOML", glyph: "text" },
  ini: { id: "config", label: "INI", glyph: "text" },
  conf: { id: "config", label: "CONF", glyph: "text" },
  cfg: { id: "config", label: "CFG", glyph: "text" },
  env: { id: "config", label: "ENV", glyph: "text" },
  md: { id: "md", label: "MD" },
  mdx: { id: "md", label: "MDX" },
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
  ico: { id: "image", label: "ICO", glyph: "image" },
  bmp: { id: "image", label: "IMG", glyph: "image" },
  avif: { id: "image", label: "IMG", glyph: "image" },
  heic: { id: "image", label: "IMG", glyph: "image" },
  tif: { id: "image", label: "IMG", glyph: "image" },
  tiff: { id: "image", label: "IMG", glyph: "image" },
  mp4: { id: "video", label: "VID", glyph: "video" },
  avi: { id: "video", label: "VID", glyph: "video" },
  m4v: { id: "video", label: "VID", glyph: "video" },
  mov: { id: "video", label: "VID", glyph: "video" },
  webm: { id: "video", label: "VID", glyph: "video" },
  mkv: { id: "video", label: "VID", glyph: "video" },
  mp3: { id: "audio", label: "AUD", glyph: "audio" },
  wav: { id: "audio", label: "AUD", glyph: "audio" },
  m4a: { id: "audio", label: "AUD", glyph: "audio" },
  flac: { id: "audio", label: "AUD", glyph: "audio" },
  aac: { id: "audio", label: "AUD", glyph: "audio" },
  ogg: { id: "audio", label: "AUD", glyph: "audio" },
  zip: { id: "archive", label: "ZIP", glyph: "archive" },
  tar: { id: "archive", label: "TAR", glyph: "archive" },
  gz: { id: "archive", label: "GZ", glyph: "archive" },
  "7z": { id: "archive", label: "7Z", glyph: "archive" },
  rar: { id: "archive", label: "RAR", glyph: "archive" },
  bz2: { id: "archive", label: "BZ2", glyph: "archive" },
  xz: { id: "archive", label: "XZ", glyph: "archive" },
  tgz: { id: "archive", label: "TGZ", glyph: "archive" },
};

/** A dotfile's whole name is its type: it has no extension to read. */
const DOTFILE: FileType = { id: "config", label: "CFG", glyph: "text" };
/** Git's own files are configuration that carries the tool's logo. */
const GIT_FILE: FileType = { id: "config", label: "GIT", logo: "git" };
const NPM_FILE: FileType = { id: "json", label: "NPM", logo: "npm" };

const BY_NAME: Record<string, FileType> = {
  dockerfile: { id: "docker", label: "DKR" },
  ".dockerignore": { id: "docker", label: "DKR" },
  "docker-compose.yml": { id: "docker", label: "DKR" },
  "docker-compose.yaml": { id: "docker", label: "DKR" },
  ".gitignore": GIT_FILE,
  ".gitattributes": GIT_FILE,
  ".gitmodules": GIT_FILE,
  ".gitkeep": GIT_FILE,
  ".editorconfig": DOTFILE,
  ".npmrc": { id: "config", label: "NPM", logo: "npm" },
  "package.json": NPM_FILE,
  "package-lock.json": NPM_FILE,
  "cargo.toml": { id: "rs", label: "RS" },
  "cargo.lock": { id: "rs", label: "RS" },
  "tsconfig.json": { id: "ts", label: "TS" },
  "go.mod": { id: "go", label: "GO" },
  "go.sum": { id: "go", label: "GO" },
  gemfile: { id: "ruby", label: "RB" },
  rakefile: { id: "ruby", label: "RB" },
  "cmakelists.txt": { id: "cmake", label: "CMK" },
  "pyproject.toml": { id: "py", label: "PY" },
};

/**
 * What a code fence calls a language when that is neither its extension nor
 * a file name, mapped to the extension or name that is.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  node: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  "c#": "cs",
  csharp: "cs",
  "f#": "fs",
  fsharp: "fs",
  objc: "m",
  "objective-c": "m",
  "objective-cpp": "mm",
  kotlin: "kt",
  ruby: "rb",
  perl: "pl",
  julia: "jl",
  elixir: "ex",
  erlang: "erl",
  haskell: "hs",
  ocaml: "ml",
  clojure: "clj",
  crystal: "cr",
  solidity: "sol",
  shell: "sh",
  shellscript: "sh",
  console: "sh",
  powershell: "ps1",
  pwsh: "ps1",
  viml: "vim",
  vimscript: "vim",
  terraform: "tf",
  hcl: "tf",
  latex: "tex",
  docker: "dockerfile",
  jupyter: "ipynb",
};

/** Own entries only: a path or a fence tag can spell `constructor`. */
function lookup(table: Record<string, FileType>, key: string): FileType | null {
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** The type of the file a path or bare name refers to, or null. */
export function fileTypeOf(pathOrName: string): FileType | null {
  // A tool summary can carry a line suffix (`a.ts:12`); it is not the name.
  const leaf = (pathOrName.split(/[\\/]/).pop() ?? "").replace(/:\d+(?::\d+)?$/, "").toLowerCase();
  if (!leaf) return null;
  const named = lookup(BY_NAME, leaf);
  if (named) return named;
  // `.env`, `.env.local`, `.env.production`: the environment, whatever follows.
  if (leaf === ".env" || leaf.startsWith(".env.")) return { ...DOTFILE, label: "ENV" };
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  return lookup(BY_EXTENSION, leaf.slice(dot + 1));
}

/** The type a code fence's language tag names (`ts`, `python`, `c++`), or null. */
export function fileTypeOfLanguage(tag: string): FileType | null {
  const key = tag.trim().toLowerCase();
  if (!key) return null;
  const name = Object.hasOwn(LANGUAGE_ALIASES, key) ? (LANGUAGE_ALIASES[key] ?? key) : key;
  return lookup(BY_NAME, name) ?? lookup(BY_EXTENSION, name);
}
