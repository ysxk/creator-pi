import assert from "node:assert/strict";
import test from "node:test";
import { loadStylesSync } from "./helpers/styles.mjs";

/**
 * Idle status indicators must not keep submitting frames.
 *
 * Any continuously animating indicator keeps the window surface dirty, and the
 * macOS window is `transparent: true` over the native `sidebar` vibrancy
 * material, so it is re-composited every frame it stays dirty: a 7px dot is
 * enough to drive WindowServer GPU to ~70% on an otherwise idle desktop. See
 * issue #1064 and `04-ux/07-ui-design-system.md` (sidebar status marks).
 */

const styles = loadStylesSync();

function declarationBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule block for ${selector}`);
  const end = styles.indexOf("}", start);
  assert.ok(end > start, `unterminated rule block for ${selector}`);
  return styles.slice(start, end + 1);
}

function containedRule(scope, selector) {
  const start = scope.indexOf(`${selector} {`);
  if (start < 0) return null;
  const end = scope.indexOf("}", start);
  return scope.slice(start, end + 1);
}

/** Every top-level `@media (prefers-reduced-motion: reduce)` block, by brace. */
function reducedMotionBlocks() {
  const marker = "@media (prefers-reduced-motion: reduce) {";
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = styles.indexOf(marker, from);
    if (start < 0) return blocks;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      else if (styles[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(styles.slice(start, index + 1));
    from = index + 1;
  }
}

// These stay mounted while nothing is running (a session waiting on
// permission, plan mode left on, a backend warning banner), so they would keep
// animating on an idle window.
const IDLE_INDICATORS = [
  ".thread-item-status.permission::before",
  '.composer-mode-chip[data-planning="true"] svg',
  ".backend-banner.warn .backend-dot",
];

test("idle status indicators stop submitting frames", () => {
  for (const selector of IDLE_INDICATORS) {
    const block = declarationBlock(selector);
    assert.doesNotMatch(
      block,
      /infinite/,
      `${selector} must not animate forever while the window is idle`,
    );
    assert.match(
      block,
      /animation:[^;]*\b[12];/,
      `${selector} must keep a finite cycle count`,
    );
  }
});

test("idle status indicators honour reduced motion", () => {
  const blocks = reducedMotionBlocks();
  for (const selector of IDLE_INDICATORS) {
    const rule = blocks
      .map((block) => containedRule(block, selector))
      .find((candidate) => candidate !== null);
    assert.ok(rule, `${selector} needs a prefers-reduced-motion fallback`);
    assert.match(
      rule,
      /animation: none/,
      `${selector} must disable its animation under reduced motion`,
    );
  }
});

// A running session is work in flight, so its mark may loop — but only while
// someone can see it. The loop reads `--motion-play`, which the window-activity
// hook flips to `paused` on blur or hide, and every mark keeps a shape that
// still shows the state from a paused frame.
const WORK_IN_FLIGHT = [
  ".thread-item-status.running::before",
  ".sidebar-session-hover-card-session-link-status::before",
  ".tool-row-state.is-running .tool-row-state-dot",
];

test("work-in-flight indicators loop only while the window is active", () => {
  assert.match(
    styles,
    /:root\[data-window-active="false"\]\s*\{\s*--motion-play:\s*paused;/,
  );
  for (const selector of WORK_IN_FLIGHT) {
    const block = declarationBlock(selector);
    assert.match(block, /animation:\s*ds-(breathe|spin)\b/, `${selector} uses a shared motion`);
    assert.match(
      block,
      /animation-play-state:\s*var\(--motion-play\)/,
      `${selector} must pause with the window`,
    );
  }
  // Only opacity and transform move, so no frame costs a repaint of its own.
  for (const name of ["ds-breathe", "ds-spin"]) {
    const start = styles.indexOf(`@keyframes ${name} {`);
    assert.ok(start >= 0, `missing @keyframes ${name}`);
    const end = styles.indexOf("\n}\n", start);
    const declared = [...styles.slice(start, end).matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(declared)].sort(), name === "ds-breathe" ? ["opacity"] : ["transform"]);
  }
  // The running row turns an arc on a track: a still frame is still an arc.
  const running = declarationBlock(".thread-item-status.running::before");
  assert.match(running, /border-top-color:\s*var\(--ds-status-running\)/);
  assert.match(running, /border:[^;]*var\(--ds-status-running-halo\)/);
});
