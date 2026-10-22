/**
 * Ink bloom for streaming text (D695).
 *
 * Each character a streaming reply reveals blooms from a soft blur into sharp
 * ink, and the next one starts before the last has settled, so the newest text
 * reads as a moving brush stroke rather than characters snapping in.
 *
 * Only the young tail is touched. An `InkClock` remembers when each stretch of
 * the reply appeared; `rehypeInkBloom` wraps just the characters still
 * blooming in `span.ink`, each with a negative `animation-delay` equal to its
 * age, and leaves everything older as the plain text it always was. Because
 * the delay comes from the character's own age, a span React re-creates or
 * reuses for a different character picks its bloom up at the right point; the
 * two animation names (`ink-0` / `ink-1`), alternating on every render of a
 * block, restart the young spans so a reused span never keeps a neighbour's
 * timing. Once a block has finished blooming it renders as plain text again,
 * so no finished span is left to replay when its block is shown again.
 */

/** One character's bloom; matches `--motion-ink-duration` in tokens.css. */
export const INK_BLOOM_MS = 140;
/** Characters revealed in one frame are spread over at most this long… */
const BATCH_SPREAD_MS = 64;
/** …and start at most one frame apart. */
const STEP_MS = 16;

type Stretch = { from: number; to: number; at: number; step: number };

export type InkClock = {
  /** The visible text grew from `from` to `to` (UTF-16 offsets) at `now`. */
  reveal(from: number, to: number, now: number): void;
  /** The visible text was replaced or cut back: nothing is blooming. */
  reset(): void;
  /**
   * The `animation-delay` (ms) for the character at `offset`: positive while
   * it waits for its turn, negative while it blooms, null once it is ink.
   */
  delayAt(offset: number, now: number): number | null;
  /** Every character before this offset has finished blooming. */
  settledBefore(now: number): number;
  /** When the last revealed character finishes blooming; -Infinity if none was. */
  settlesAt(): number;
  /** Alternates on every call for the block starting at `block`; see the module comment. */
  nextPhase(block: number): 0 | 1;
};

function stretchEnd(stretch: Stretch): number {
  return stretch.at + (stretch.to - stretch.from - 1) * stretch.step + INK_BLOOM_MS;
}

export function createInkClock(): InkClock {
  let stretches: Stretch[] = [];
  const phases = new Map<number, 0 | 1>();
  return {
    reveal(from, to, now) {
      if (to <= from) return;
      stretches = stretches.filter((stretch) => stretchEnd(stretch) > now);
      stretches.push({ from, to, at: now, step: Math.min(STEP_MS, BATCH_SPREAD_MS / (to - from)) });
    },
    reset() {
      stretches = [];
      phases.clear();
    },
    delayAt(offset, now) {
      for (let index = stretches.length - 1; index >= 0; index -= 1) {
        const stretch = stretches[index];
        if (offset < stretch.from || offset >= stretch.to) continue;
        const delay = stretch.at + (offset - stretch.from) * stretch.step - now;
        return -delay >= INK_BLOOM_MS ? null : delay;
      }
      return null;
    },
    settledBefore(now) {
      let settled = Number.POSITIVE_INFINITY;
      for (const stretch of stretches) {
        if (stretchEnd(stretch) > now) settled = Math.min(settled, stretch.from);
      }
      return settled;
    },
    settlesAt() {
      return stretches.reduce((latest, stretch) => Math.max(latest, stretchEnd(stretch)), Number.NEGATIVE_INFINITY);
    },
    nextPhase(block) {
      const phase = phases.get(block) === 0 ? 1 : 0;
      phases.set(block, phase);
      return phase;
    },
  };
}

type InkNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: InkNode[];
};

/**
 * Subtrees whose text a component reads as a string, renders from its own
 * source, or lays out itself: inline code (file-reference detection), fenced
 * code (highlighted from the raw block), math, media and embedded markup.
 */
const OPAQUE = new Set(["code", "pre", "script", "style", "svg", "math", "textarea", "audio", "video"]);

function isOpaque(node: InkNode): boolean {
  if (node.type !== "element" || !node.tagName) return false;
  if (OPAQUE.has(node.tagName) || node.tagName.includes("-")) return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((name) => String(name).startsWith("katex"));
}

/** Wrap the still-blooming characters of one block (`offset`: its place in the reply). */
export function rehypeInkBloom({ offset, clock }: { offset: number; clock: InkClock }) {
  return (tree: InkNode) => {
    const now = performance.now();
    const settled = clock.settledBefore(now);
    if (!Number.isFinite(settled)) return;
    const phase = clock.nextPhase(offset);

    const bloom = (text: InkNode): InkNode[] => {
      const value = text.value ?? "";
      const start = offset + (text.position?.start.offset ?? 0);
      if (start + value.length <= settled) return [text];
      const nodes: InkNode[] = [];
      let plain = "";
      let at = start;
      for (const char of value) {
        const delay = at >= settled ? clock.delayAt(at, now) : null;
        at += char.length;
        if (delay === null || /\s/.test(char)) {
          plain += char;
          continue;
        }
        if (plain) nodes.push({ type: "text", value: plain });
        plain = "";
        nodes.push({
          type: "element",
          tagName: "span",
          properties: { className: ["ink", `ink-${phase}`], style: `animation-delay:${Math.round(delay)}ms` },
          children: [{ type: "text", value: char }],
        });
      }
      if (plain) nodes.push({ type: "text", value: plain });
      return nodes;
    };

    const walk = (node: InkNode) => {
      if (!node.children || isOpaque(node)) return;
      const children: InkNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.position?.start.offset !== undefined) {
          children.push(...bloom(child));
        } else {
          walk(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    walk(tree);
  };
}
