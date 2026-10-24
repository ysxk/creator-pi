import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { anchoredZoomOffset, wheelZoomFactor } from "../src/lib/image-wheel-zoom.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a wheel notch zooms in going up and out going down by the same step", () => {
  const up = wheelZoomFactor({ deltaY: -100, deltaMode: 0 }, 800);
  const down = wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, 800);
  assert.ok(up > 1.3 && up < 1.5, `up ${up}`);
  assert.ok(Math.abs(up * down - 1) < 1e-9);
  assert.equal(wheelZoomFactor({ deltaY: 0, deltaMode: 0 }, 800), 1);
});

test("line and page wheel deltas are normalized and a fast spin is capped", () => {
  assert.equal(wheelZoomFactor({ deltaY: 3, deltaMode: 1 }, 800), wheelZoomFactor({ deltaY: 48, deltaMode: 0 }, 800));
  assert.equal(wheelZoomFactor({ deltaY: 1, deltaMode: 2 }, 800), wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, 800));
  assert.equal(wheelZoomFactor({ deltaY: -2000, deltaMode: 0 }, 800), wheelZoomFactor({ deltaY: -100, deltaMode: 0 }, 800));
});

test("the picture point under the cursor stays under it across a zoom", () => {
  const anchor = { x: 120, y: -40 };
  const offset = { x: 30, y: 10 };
  const next = anchoredZoomOffset(anchor, offset, 1, 2);
  // At scale 1 the cursor sits 90/-50 px from the picture centre, which is
  // 180/-100 px at scale 2.
  assert.deepEqual(next, { x: 120 - 180, y: -40 + 100 });
  assert.deepEqual(anchoredZoomOffset(anchor, offset, 1.5, 1.5), offset);
});

test("both image viewers zoom on a plain wheel, anchored at the cursor", () => {
  const composer = read("../src/features/chat/composer/ComposerImagePreview.tsx");
  assert.match(composer, /wheelZoomFactor\(event, element\.clientHeight\)/);
  assert.match(composer, /anchoredZoomOffset\(anchor, offset, from, to\)/);
  assert.doesNotMatch(composer, /event\.ctrlKey/, "a plain wheel zooms, not only a pinch");

  const generated = read("../src/features/chat/transcript/GeneratedImageViewer.tsx");
  assert.match(generated, /addEventListener\("wheel", wheel, \{ passive: false \}\)/);
  assert.match(generated, /wheelZoomFactor\(event, element\.clientHeight\)/);
  assert.match(generated, /element\.scrollLeft \+= rect\.left \+ anchor\.fx \* rect\.width - anchor\.clientX/);
  // The wheel no longer scrolls, so a zoomed picture is dragged instead.
  assert.match(generated, /\{\.\.\.pan\.imageHandlers\}/);
});
