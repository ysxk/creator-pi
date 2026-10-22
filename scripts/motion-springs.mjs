#!/usr/bin/env node
/**
 * Spring curves behind the motion personality tokens (D694).
 *
 * CSS has no spring timing function, but `linear()` can carry any sampled
 * curve. Each personality is a damped spring (mass 1) released from rest at 0
 * toward rest at 1. The simulated curve is reduced to the fewest stops that
 * stay within `TOLERANCE` of it, and the duration is the time the spring takes
 * to settle, so a token pair (`--motion-ease-*`, `--motion-duration-*`) plays
 * the physical spring.
 *
 * `node scripts/motion-springs.mjs` prints the token block for
 * `apps/desktop/src/styles/tokens.css`; `apps/desktop/test/motion-tokens.test.mjs`
 * fails when the two drift apart.
 */
import { fileURLToPath } from "node:url";

/** Stiffness and damping per personality, in the units motion libraries use. */
export const SPRINGS = {
  // Over-damped: structure moves and stops dead — folds, docks, dialogs.
  snap: { stiffness: 1200, damping: 80, precision: 0.001 },
  // Critically damped: content arriving — rows easing into place.
  glide: { stiffness: 600, damping: 49, precision: 0.001 },
  // Under-damped, ~19% overshoot: small feedback glyphs only.
  pop: { stiffness: 380, damping: 18, precision: 0.002 },
};

/** Largest gap allowed between the simulated curve and its `linear()` stops. */
export const TOLERANCE = 0.002;

const STEP = 1 / 2000;
/** The spring counts as settled once it stays within precision this long. */
const SETTLE_HOLD = 0.02;

/** Semi-implicit Euler from rest at 0 until the spring settles at 1. */
export function simulateSpring({ stiffness, damping, mass = 1, precision }) {
  let x = 0;
  let v = 0;
  let t = 0;
  let calm = 0;
  const points = [[0, 0]];
  while (t < 3) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * STEP;
    x += v * STEP;
    t += STEP;
    points.push([t, x]);
    if (Math.abs(1 - x) < precision && Math.abs(v) < precision * 20) {
      calm += STEP;
      if (calm >= SETTLE_HOLD) break;
    } else {
      calm = 0;
    }
  }
  return { duration: t, points };
}

/** Ramer–Douglas–Peucker on the curve's value axis. */
function simplify(points, tolerance) {
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [t0, x0] = points[first];
    const [t1, x1] = points[last];
    let worst = -1;
    let worstGap = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const [t, x] = points[i];
      const expected = x0 + ((x1 - x0) * (t - t0)) / (t1 - t0);
      const gap = Math.abs(x - expected);
      if (gap > worstGap) {
        worst = i;
        worstGap = gap;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([first, worst], [worst, last]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

const round = (value, digits) => Number(value.toFixed(digits));

/** The `linear()` easing and settle duration for one spring. */
export function springToken(spec) {
  const { duration, points } = simulateSpring(spec);
  const stops = simplify(points, TOLERANCE);
  const parts = stops.map(([t, x], index) => {
    if (index === 0) return "0";
    if (index === stops.length - 1) return "1";
    return `${round(x, 4)} ${round((t / duration) * 100, 2)}%`;
  });
  return {
    durationMs: Math.round(duration * 1000),
    easing: `linear(${parts.join(", ")})`,
  };
}

/** The highest value a spring's curve reaches, for overshoot checks. */
export function springPeak(spec) {
  return Math.max(...simulateSpring(spec).points.map(([, x]) => x));
}

/** Wraps a `linear()` value a few stops per line, as tokens.css carries it. */
function wrapEasing(easing, indent) {
  const stops = easing.slice("linear(".length, -1).split(", ");
  const lines = [];
  for (let i = 0; i < stops.length; i += 6) lines.push(stops.slice(i, i + 6).join(", "));
  return `linear(\n${lines.map((line) => `${indent}  ${line}`).join(",\n")}\n${indent})`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, spec] of Object.entries(SPRINGS)) {
    const token = springToken(spec);
    console.log(`  --motion-ease-${name}: ${wrapEasing(token.easing, "  ")};`);
    console.log(`  --motion-duration-${name}: ${token.durationMs}ms;`);
  }
}
