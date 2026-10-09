import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { agentCount, initialHighlight, moveHighlight } = await import(
  "../src/lib/composer-ac-navigation.ts"
);

const agent = (name) => ({ kind: "subagent", agent: { name } });
const file = (path) => ({ kind: "path", entry: { path } });
const AT_END = { queryEmpty: true, caretAtTokenEnd: true };
const MID_TOKEN = { queryEmpty: false, caretAtTokenEnd: false };

// Two subagents on the strip (0, 1), three files in the list (2, 3, 4).
const panel = [agent("explorer"), agent("fixer"), file("a.ts"), file("b.ts"), file("c.ts")];

test("the highlight starts on the first file, not on the strip", () => {
  assert.equal(agentCount(panel), 2);
  assert.equal(initialHighlight(panel, ""), 2);
  assert.equal(initialHighlight(panel, "b"), 2);
  // Nothing but subagents, or nothing but files: the top of what there is.
  assert.equal(initialHighlight([agent("explorer")], ""), 0);
  assert.equal(initialHighlight([file("a.ts")], ""), 0);
});

test("typing the start of a subagent's name still selects that subagent", () => {
  // `@fixer` followed by Enter has to keep meaning the subagent.
  assert.equal(initialHighlight(panel, "fix"), 1);
  assert.equal(initialHighlight(panel, "FIXER"), 1);
  assert.equal(initialHighlight(panel, "x"), 2);
});

test("up and down stay inside the file list and wrap there", () => {
  assert.equal(moveHighlight(panel, 2, "ArrowDown", AT_END), 3);
  assert.equal(moveHighlight(panel, 4, "ArrowDown", AT_END), 2);
  assert.equal(moveHighlight(panel, 2, "ArrowUp", AT_END), 4);
});

test("left and right enter the strip only when the caret has nowhere to go", () => {
  // Right at the end of the token, with or without a query.
  assert.equal(moveHighlight(panel, 2, "ArrowRight", AT_END), 0);
  assert.equal(
    moveHighlight(panel, 3, "ArrowRight", { queryEmpty: false, caretAtTokenEnd: true }),
    0,
  );
  // Left only before anything was typed after the trigger.
  assert.equal(moveHighlight(panel, 2, "ArrowLeft", AT_END), 0);
  assert.equal(
    moveHighlight(panel, 2, "ArrowLeft", { queryEmpty: false, caretAtTokenEnd: true }),
    null,
  );
  // Mid-token both keys belong to the caret.
  assert.equal(moveHighlight(panel, 2, "ArrowRight", MID_TOKEN), null);
  assert.equal(moveHighlight(panel, 2, "ArrowLeft", MID_TOKEN), null);
});

test("inside the strip left and right move, and every exit leads back to the files", () => {
  assert.equal(moveHighlight(panel, 0, "ArrowRight", MID_TOKEN), 1);
  assert.equal(moveHighlight(panel, 1, "ArrowRight", MID_TOKEN), 1);
  assert.equal(moveHighlight(panel, 1, "ArrowLeft", MID_TOKEN), 0);
  assert.equal(moveHighlight(panel, 0, "ArrowLeft", MID_TOKEN), 2);
  assert.equal(moveHighlight(panel, 1, "ArrowDown", MID_TOKEN), 2);
  assert.equal(moveHighlight(panel, 1, "ArrowUp", MID_TOKEN), 2);
});

test("a panel without subagents behaves like the list it always was", () => {
  const list = [file("a.ts"), file("b.ts")];
  assert.equal(moveHighlight(list, 1, "ArrowDown", AT_END), 0);
  assert.equal(moveHighlight(list, 0, "ArrowUp", AT_END), 1);
  assert.equal(moveHighlight(list, 0, "ArrowRight", AT_END), null);
  assert.equal(moveHighlight(list, 0, "ArrowLeft", AT_END), null);
  assert.equal(moveHighlight([], 0, "ArrowDown", AT_END), null);
});

test("only subagents: the strip is the whole panel", () => {
  const only = [agent("explorer"), agent("fixer")];
  assert.equal(moveHighlight(only, 0, "ArrowDown", AT_END), 1);
  assert.equal(moveHighlight(only, 0, "ArrowLeft", AT_END), 0);
  assert.equal(moveHighlight(only, 0, "ArrowRight", AT_END), 1);
});

test("the composer hands arrow keys to the panel only when it takes them", async () => {
  const input = await readFile(
    new URL("../src/features/chat/composer/ComposerInput.tsx", import.meta.url),
    "utf8",
  );
  const popup = await readFile(
    new URL("../src/components/ComposerAutocomplete.tsx", import.meta.url),
    "utf8",
  );
  assert.match(input, /const next = moveHighlight\(composerAc\.items, composerAc\.highlight, event\.key, \{/);
  // A key the panel declines is never swallowed.
  assert.match(input, /if \(next !== null\) \{\s*event\.preventDefault\(\);\s*composerAc\.setHighlight\(next\);/);
  // The explanation renders in the card's flow, under the strip.
  assert.match(popup, /\{focusedAgent \? <AgentDetail t=\{t\} agent=\{focusedAgent\} \/> : null\}/);
  assert.match(popup, /className="composer-ac-agent-strip"/);
});
