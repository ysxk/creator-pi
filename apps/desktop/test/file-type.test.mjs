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
  for (const path of ["notes.txt", "photo.png", "archive.zip", "README", ".gitignore", "", "dir/"]) {
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
      styles.includes(`.file-type-badge[data-file-type="${id}"] { --file-type: var(--ds-filetype-${id}); }`),
      `rule for ${id}`,
    );
  }
});
