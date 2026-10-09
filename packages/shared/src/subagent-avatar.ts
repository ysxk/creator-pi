/**
 * Deterministic subagent avatars.
 *
 * Every subagent surface (settings rows, the @ popup, the session board) shows
 * an identity mark, but a subagent is a Markdown file: nothing about it is
 * graphical. The default avatar is therefore drawn from the name alone — a
 * small monochrome line portrait inside a circle, assembled from a handful of
 * headwear, eye and mouth shapes — so the same subagent looks the same
 * everywhere, offline and before any image model is configured. The shipped
 * subagents have fixed portraits; every other name picks its parts by hash.
 * An AI-generated PNG (Settings) replaces it per name when one exists.
 *
 * The drawing is ink on paper in both themes: it is an `<img>`, so it cannot
 * follow theme tokens, and a white disc reads as a badge on a dark surface.
 */

const INK = "#0f172a";
const PAPER = "#ffffff";
const SHADE = "#475569";

/** Shapes drawn over the top of the head. Coordinates are in the 64px box. */
const HEADWEAR = [
  // Short crop, swept to one side.
  `<path d="M20 31c-1-10 4-16 12-16 9 0 14 6 12 16-2-5-5-8-9-9-4 4-10 5-15 9z" fill="${INK}"/>`,
  // Centre parting.
  `<path d="M20 32c-1-11 4-17 12-17s13 6 12 17c-2-6-6-10-12-11-6 1-10 5-12 11z" fill="${INK}"/><path d="M32 15v6" stroke="${PAPER}" stroke-width="1.5"/>`,
  // Baseball cap with its brim to the right.
  `<path d="M19 28c0-9 6-14 13-14s13 5 13 14z" fill="${INK}"/><path d="M40 28h13" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  // Beret, tilted, with its stalk.
  `<path d="M16 26c1-8 9-12 18-11 8 1 13 5 12 10-9-3-20-3-30 1z" fill="${INK}"/><path d="M33 15l1-4" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
  // Beanie with a folded band and a bobble.
  `<path d="M19 28c0-9 6-14 13-14s13 5 13 14z" fill="${PAPER}" stroke="${INK}" stroke-width="2"/><path d="M18 26h28v5H18z" fill="${SHADE}"/><circle cx="32" cy="12" r="2.6" fill="${INK}"/>`,
  // Choppy fringe under a headband.
  `<path d="M20 30c0-9 5-14 12-14s12 5 12 14l-3-4-3 4-3-4-3 4-3-4-3 4-3-4z" fill="${INK}"/><path d="M20 24h24" stroke="${PAPER}" stroke-width="2.5"/>`,
  // Bob that falls past the ears.
  `<path d="M18 40c-2-14 3-25 14-25s16 11 14 25c-1-6-2-10-4-13-5 1-14 1-20 0-2 3-3 7-4 13z" fill="${INK}"/>`,
  // Top knot.
  `<path d="M20 31c-1-9 4-14 12-14s13 5 12 14c-3-5-7-7-12-7s-9 2-12 7z" fill="${INK}"/><circle cx="32" cy="13" r="4" fill="${INK}"/>`,
] as const;

const EYES = [
  // Plain dots.
  `<circle cx="27" cy="35" r="1.6" fill="${INK}"/><circle cx="37" cy="35" r="1.6" fill="${INK}"/>`,
  // Round glasses.
  `<circle cx="26.5" cy="35" r="4.6" fill="${PAPER}" stroke="${INK}" stroke-width="1.8"/><circle cx="37.5" cy="35" r="4.6" fill="${PAPER}" stroke="${INK}" stroke-width="1.8"/><path d="M31.1 35h1.8" stroke="${INK}" stroke-width="1.8"/><circle cx="26.5" cy="35" r="1.2" fill="${INK}"/><circle cx="37.5" cy="35" r="1.2" fill="${INK}"/>`,
  // Thick square frames.
  `<rect x="21.5" y="31.5" width="9" height="7" rx="1.6" fill="${PAPER}" stroke="${INK}" stroke-width="2.2"/><rect x="33.5" y="31.5" width="9" height="7" rx="1.6" fill="${PAPER}" stroke="${INK}" stroke-width="2.2"/><path d="M30.5 34.5h3" stroke="${INK}" stroke-width="2.2"/><circle cx="26" cy="35" r="1.1" fill="${INK}"/><circle cx="38" cy="35" r="1.1" fill="${INK}"/>`,
  // Half-rim reading glasses.
  `<path d="M22 33.5h9.5M32.5 33.5H42M22 33.5c0 4 2 5.5 4.7 5.5s4.8-1.5 4.8-5.5M32.5 33.5c0 4 2 5.5 4.8 5.5S42 37.5 42 33.5" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/><circle cx="26.7" cy="35.5" r="1.1" fill="${INK}"/><circle cx="37.3" cy="35.5" r="1.1" fill="${INK}"/>`,
  // Closed, smiling.
  `<path d="M24.5 35.5c1.2-1.8 3.3-1.8 4.5 0M35 35.5c1.2-1.8 3.3-1.8 4.5 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`,
] as const;

const MOUTHS = [
  `<path d="M28 43c2.4 2.2 5.6 2.2 8 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`,
  `<path d="M28.5 43.5h7" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`,
  `<path d="M28.5 44c2.5 0.8 5 0 7-2" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`,
  `<ellipse cx="32" cy="43.5" rx="1.8" ry="1.5" fill="none" stroke="${INK}" stroke-width="1.6"/>`,
] as const;

/** [headwear, eyes, mouth] for the subagents PI-Desktop ships. */
const SHIPPED: Record<string, readonly [number, number, number]> = {
  explorer: [2, 1, 0],
  "code-reviewer": [0, 2, 1],
  "test-runner": [5, 0, 2],
  fixer: [4, 4, 0],
  "ui-designer": [3, 1, 2],
};

function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function partsFor(name: string): readonly [number, number, number] {
  const shipped = SHIPPED[name];
  if (shipped) return shipped;
  const hash = hashName(name);
  return [
    hash % HEADWEAR.length,
    (hash >>> 8) % EYES.length,
    (hash >>> 16) % MOUTHS.length,
  ];
}

/**
 * The avatar SVG for one subagent name. Pure and deterministic: the same name
 * always yields the same bytes, so callers may embed it as a data URL without
 * caching or invalidation. The name itself is never written into the markup.
 */
export function subagentAvatarSvg(name: string): string {
  const [headwear, eyes, mouth] = partsFor(name);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true">`,
    `<defs><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath></defs>`,
    `<circle cx="32" cy="32" r="31" fill="${PAPER}"/>`,
    `<g clip-path="url(#c)">`,
    // Shoulders, then the head over them.
    `<path d="M12 64c1-10 8-14 20-14s19 4 20 14z" fill="${PAPER}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="M20 31c0-9 5-14 12-14s12 5 12 14v6c0 8-5 13-12 13s-12-5-12-13z" fill="${PAPER}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`,
    HEADWEAR[headwear],
    EYES[eyes],
    MOUTHS[mouth],
    `</g>`,
    `<circle cx="32" cy="32" r="30" fill="none" stroke="${INK}" stroke-width="2"/>`,
    `</svg>`,
  ].join("");
}

/** The avatar as a data URL, ready for an `<img src>`. */
export function subagentAvatarDataUrl(name: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(subagentAvatarSvg(name))}`;
}
