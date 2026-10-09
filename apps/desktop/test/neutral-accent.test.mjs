import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();
const recentSource = await readFile(
  new URL("../src/lib/recent-projects.ts", import.meta.url),
  "utf8",
);

test("the accent is neutral in dark and bamboo green in light, never blue", () => {
  assert.doesNotMatch(stylesSource, /--blue-\d+/);
  assert.doesNotMatch(stylesSource, /#0285ff/i);
  assert.doesNotMatch(stylesSource, /#339cff/i);
  assert.doesNotMatch(stylesSource, /#99ceff/i);
  assert.doesNotMatch(stylesSource, /#e5f3ff/i);

  assert.match(
    stylesSource,
    /--ds-accent:\s*var\(--gray-0\)/,
  );
  assert.match(
    stylesSource,
    /--ds-accent-hover:\s*var\(--gray-100\)/,
  );
  assert.match(
    stylesSource,
    /--ds-accent-soft:\s*var\(--gray-300\)/,
  );
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\][\s\S]*?--ds-accent:\s*#059669/,
  );
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\][\s\S]*?--ds-accent-hover:\s*#047857/,
  );
  // Soft stays a solid colour: it draws outlines and mixes into text.
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\][\s\S]*?--ds-accent-soft:\s*#34d399/,
  );
  // White text sits on the darker step, which clears 4.5:1; the plain accent
  // does not.
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\][\s\S]*?--ds-accent-strong:\s*#047857/,
  );
});

test("project color dots stay on the gray ladder", () => {
  assert.doesNotMatch(recentSource, /#0285ff/i);
  assert.doesNotMatch(recentSource, /#7c5cff/i);
  const match = recentSource.match(/const COLORS = \[([^\]]+)\]/);
  assert.ok(match, "COLORS array missing");
  const hexes = match[1].match(/#[0-9a-fA-F]{6}/g) ?? [];
  assert.equal(hexes.length, 6);
  for (const hex of hexes) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Near-gray: channels stay close and out of the blue brand range.
    assert.ok(Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8, hex);
    assert.ok(b <= r + 8, `blue-leaning ${hex}`);
  }
});
