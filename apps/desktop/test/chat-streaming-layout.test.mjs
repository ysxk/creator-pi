import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);

test("streaming prose chat stabilizes line wrapping against orphan-rebalancing reflow", () => {
  assert.match(
    messagesCss,
    /\.assistant-turn-fragment\.streaming \.prose-chat\s*\{\s*text-wrap:\s*wrap;\s*\}/,
  );
});

// The caret this file once pinned gave way to the ink bloom (D695); its
// contract lives in ink-bloom.test.mjs.
