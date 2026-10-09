/**
 * Deterministic subagent avatars.
 *
 * Every subagent surface (settings rows, the @ popup, the delegation topology)
 * shows an identity mark, but a subagent is a Markdown file: nothing about it
 * is graphical. The default avatar is therefore generated from the name alone —
 * a stable two-tone gradient and the leading initials — so the same subagent
 * looks the same everywhere, offline and before any image model is configured.
 * An AI-generated PNG (Settings) replaces it per name when one exists.
 */

/** Palette pairs indexed by hash; adjacent entries contrast by design. */
const PALETTES: Array<readonly [string, string]> = [
  ["#2563eb", "#06b6d4"],
  ["#7c3aed", "#db2777"],
  ["#0891b2", "#22c55e"],
  ["#b45309", "#f59e0b"],
  ["#be123c", "#fb7185"],
  ["#4f46e5", "#a78bfa"],
  ["#047857", "#34d399"],
  ["#b91c1c", "#f97316"],
  ["#0f766e", "#14b8a6"],
  ["#6d28d9", "#60a5fa"],
];

function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Up to two leading characters of a name, uppercased for the mark. */
function initialsOf(name: string): string {
  const segments = name.split(/[-_]+/).filter(Boolean);
  const letters =
    segments.length >= 2
      ? `${segments[0][0]}${segments[1][0]}`
      : (segments[0] ?? name).slice(0, 2);
  return (letters || "a").toUpperCase();
}

/**
 * The avatar SVG for one subagent name. Pure and deterministic: the same name
 * always yields the same bytes, so callers may embed it as a data URL without
 * caching or invalidation.
 */
export function subagentAvatarSvg(name: string): string {
  const hash = hashName(name);
  const [from, to] = PALETTES[hash % PALETTES.length];
  const initials = initialsOf(name);
  const angle = (hash >>> 4) % 360;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true">`,
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">`,
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`,
    `</linearGradient></defs>`,
    `<rect width="64" height="64" rx="14" fill="url(#g)"/>`,
    `<text x="32" y="32" text-anchor="middle" dominant-baseline="central"`,
    ` font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" font-weight="600"`,
    ` fill="#ffffff" fill-opacity="0.92">${initials}</text>`,
    `</svg>`,
  ].join("");
}

/** The avatar as a data URL, ready for an `<img src>`. */
export function subagentAvatarDataUrl(name: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(subagentAvatarSvg(name))}`;
}
