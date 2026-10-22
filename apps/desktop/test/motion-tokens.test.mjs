import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SPRINGS, springPeak, springToken } from "../../../scripts/motion-springs.mjs";

/**
 * Motion personalities (D694, design-system §8.2). The springs live in
 * scripts/motion-springs.mjs; tokens.css carries their sampled curves. These
 * tests keep the two in step and pin each personality's character, so nobody
 * hand-tunes a curve into something the spring would not do.
 */

const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const motionSource = readFileSync(new URL("../src/lib/motion.ts", import.meta.url), "utf8");
const markdownSource = readFileSync(new URL("../src/components/Markdown.tsx", import.meta.url), "utf8");

function token(name) {
  const match = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `tokens.css declares ${name}`);
  return match[1].replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function constant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
  assert.ok(match, `${name} is exported`);
  return Number(match[1]);
}

test("each spring token is the curve its spring produces", () => {
  for (const [name, spec] of Object.entries(SPRINGS)) {
    const expected = springToken(spec);
    assert.equal(token(`--motion-ease-${name}`), expected.easing, `--motion-ease-${name} drifted from its spring`);
    assert.equal(token(`--motion-duration-${name}`), `${expected.durationMs}ms`);
  }
});

test("snap and glide never overshoot; pop overshoots about a fifth", () => {
  assert.ok(springPeak(SPRINGS.snap) <= 1.0005, "snap must stop dead");
  assert.ok(springPeak(SPRINGS.glide) <= 1.0005, "glide must not overshoot");
  const pop = springPeak(SPRINGS.pop);
  assert.ok(pop > 1.15 && pop < 1.25, `pop overshoot out of range: ${pop}`);
});

test("linear() stops run forward from 0 to 1", () => {
  for (const name of Object.keys(SPRINGS)) {
    const stops = token(`--motion-ease-${name}`).slice("linear(".length, -1).split(", ");
    assert.equal(stops[0], "0");
    assert.equal(stops.at(-1), "1");
    let previous = 0;
    for (const stop of stops.slice(1, -1)) {
      const at = Number(stop.split(" ")[1].replace("%", ""));
      assert.ok(at > previous && at < 100, `${name}: stop positions must increase (${stop})`);
      previous = at;
    }
  }
});

test("renderer timings match the stylesheet they wait for", () => {
  assert.equal(token("--motion-duration-exit"), `${constant(motionSource, "SURFACE_EXIT_MS")}ms`);
  // A fold counts as opening until its last revealed row (90ms step) has glided in.
  const glide = springToken(SPRINGS.glide).durationMs;
  assert.ok(constant(motionSource, "FOLD_OPEN_MS") >= glide + 90);
});

test("copy feedback holds for 2.5s, then eases back", () => {
  assert.equal(constant(motionSource, "COPY_FEEDBACK_MS"), 2500);
  assert.match(markdownSource, /setPhase\("returning"\)[\s\S]*?COPY_FEEDBACK_MS\)/);
  assert.match(markdownSource, /return \{ copied: phase === "copied", returning: phase === "returning", copy \}/);
});
