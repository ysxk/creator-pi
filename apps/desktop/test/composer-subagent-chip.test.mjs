import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [hook, completions, editor, helpers, optimistic] = await Promise.all([
  read("../src/hooks/use-composer-autocomplete.ts"),
  read("../src/features/chat/composer/hooks/useComposerCompletions.ts"),
  read("../src/features/chat/composer/editor.ts"),
  read("../src/stores/helpers/store-helpers.ts"),
  read("../src/lib/session-transcript.ts"),
]);
const { serializeComposerFileReferences } = await import("../../../packages/shared/dist/index.js");

test("accepting a subagent puts a chip in the draft, not `@name` text", () => {
  assert.match(
    hook,
    /fileReference: \{ path: item\.agent\.name, name: item\.agent\.name, subagent: true \}/,
  );
  // The chip is named as the panel named the subagent; the handle is its path.
  assert.match(
    completions,
    /subagentDisplayName\(t, acceptedFileReference\.path\),\s*referenceSessionId,\s*\{ kind: "subagent", token \}/,
  );
});

test("the chip wears the subagent's portrait", async () => {
  assert.match(editor, /chip\.dataset\.subagent = reference\.path;/);
  assert.match(editor, /avatar\.src = subagentAvatarDataUrl\(reference\.path\);/);
  const styles = await loadStyles();
  assert.match(
    styles,
    /\.composer-chip\[data-subagent\]\s*\{[^}]*border-radius:\s*var\(--radius-full\)/,
  );
});

test("a subagent chip is sent as `@handle` text and never as an attachment", () => {
  const token = "\ue123";
  const sent = serializeComposerFileReferences(`让 ${token} 看一下这个改动`, [
    { path: "code-reviewer", kind: "subagent", token },
  ]);
  assert.equal(sent, "让 @code-reviewer 看一下这个改动");
  assert.match(helpers, /reference\.kind === "session" \|\| reference\.kind === "subagent"\) return \[\];/);
  assert.match(optimistic, /if \(reference\.kind === "subagent"\) return \[\];/);
});
