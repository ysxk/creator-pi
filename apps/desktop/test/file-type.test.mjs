import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadStyles } from "./helpers/styles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { fileTypeOf } = await import("../src/lib/file-type.ts");

test("a path is typed by its extension, whatever directory it is in", () => {
  assert.deepEqual(fileTypeOf("apps/desktop/src/hooks/use-thing.ts"), { id: "ts", label: "TS" });
  assert.deepEqual(fileTypeOf("Component.TSX"), { id: "ts", label: "TSX" });
  assert.deepEqual(fileTypeOf("crates\\host-core\\src\\db.rs"), { id: "rs", label: "RS" });
  assert.deepEqual(fileTypeOf("styles/tokens.css"), { id: "css", label: "CSS" });
  assert.deepEqual(fileTypeOf("scripts/run.sh"), { id: "shell", label: "SH" });
});

test("a line suffix on a tool summary is not part of the name", () => {
  assert.deepEqual(fileTypeOf("src/a.ts:255"), { id: "ts", label: "TS" });
  assert.deepEqual(fileTypeOf("src/a.py:12:4"), { id: "py", label: "PY" });
});

test("well-known file names are typed even without a telling extension", () => {
  assert.equal(fileTypeOf("Dockerfile")?.id, "docker");
  assert.equal(fileTypeOf("crates/host-core/Cargo.toml")?.id, "rs");
  assert.equal(fileTypeOf("tsconfig.json")?.id, "ts");
});

test("anything not worth telling apart keeps its generic icon", () => {
  for (const path of ["README", "LICENSE", "data.bin", "", "dir/"]) {
    assert.equal(fileTypeOf(path), null, path);
  }
});

test("every badge colour the helper can name is defined", async () => {
  const styles = await loadStyles();
  const source = await readFile(new URL("../src/lib/file-type.ts", import.meta.url), "utf8");
  const ids = new Set([...source.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]));
  assert.ok(ids.size > 15);
  for (const id of ids) {
    assert.match(styles, new RegExp(`--ds-filetype-${id}:\\s*#[0-9a-f]{6};`), `token for ${id}`);
    assert.ok(
      styles.includes(`[data-file-type="${id}"] { --file-type: var(--ds-filetype-${id}); }`),
      `rule for ${id}`,
    );
  }
});

test("a language shows its own logo and a plain format a line glyph", async () => {
  const { FILE_TYPE_LOGOS } = await import("../src/lib/file-type-logos.ts");
  const source = await readFile(new URL("../src/lib/file-type.ts", import.meta.url), "utf8");
  // Every type either names a glyph or resolves to a vendored logo.
  for (const [, body] of source.matchAll(/: (\{ id: "[a-z]+"[^}]*\})/g)) {
    const id = body.match(/id: "([a-z]+)"/)[1];
    const logo = body.match(/logo: "([a-z]+)"/)?.[1] ?? id;
    assert.ok(/glyph: "/.test(body) || FILE_TYPE_LOGOS[logo], `mark for ${id}`);
  }
  for (const [key, url] of Object.entries(FILE_TYPE_LOGOS)) {
    assert.match(url, /^data:image\/svg\+xml,%3Csvg/, key);
    // An <img> runs no script, and the drawings carry none to begin with.
    assert.doesNotMatch(decodeURIComponent(url), /<script|javascript:|href="http/i, key);
  }
  assert.equal(fileTypeOf("notes.txt")?.glyph, "text");
  assert.equal(fileTypeOf("clip.mp4")?.glyph, "video");
  assert.equal(fileTypeOf("main.cpp")?.logo, "cpp");
});

test("the formats the design names are all marked", () => {
  const expected = {
    "favicon.ico": "image",
    "voice.aac": "audio",
    "clip.avi": "video",
    "app.db": "sql",
    "cache.sqlite": "sql",
    ".env": "config",
    ".env.local": "config",
    "config/.env.production": "config",
    ".gitignore": "config",
    "analysis.ipynb": "py",
    "Main.class": "java",
    "lib/app.jar": "java",
    "notes.mdx": "md",
    "settings.jsonc": "json",
    "docker-compose.yml": "docker",
    "build.gradle.kts": "kotlin",
    "bundle.tgz": "archive",
  };
  for (const [path, id] of Object.entries(expected)) {
    assert.equal(fileTypeOf(path)?.id, id, path);
  }
  // A name that merely starts like one is not that dotfile.
  assert.equal(fileTypeOf(".environment"), null);
});

test("every mark sits on a plate of its type's colour, except inside a chip", async () => {
  const styles = await loadStyles();
  const badge = styles.match(/\.file-type-badge\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(badge, /background:\s*color-mix\(in oklab, var\(--file-type, var\(--ds-filetype-default\)\) 8%, transparent\)/);
  assert.match(badge, /color-mix\(in oklab, var\(--file-type, var\(--ds-filetype-default\)\) 16%, transparent\)/);
  assert.match(
    styles,
    /\.chat-file-chip \.file-type-badge,\s*\.chat-code-link \.file-type-badge\s*\{[^}]*background:\s*none;[^}]*box-shadow:\s*none;/,
  );
  // File lists and search results lead each path with its mark.
  const details = await readFile(new URL("../src/components/ToolDetails.tsx", import.meta.url), "utf8");
  assert.equal(details.match(/<FileTypeBadge path=\{path\} \/>/g)?.length, 2);
  assert.equal(details.match(/<FileTypeBadge path=\{group\.path\} \/>/g)?.length, 2);
});
