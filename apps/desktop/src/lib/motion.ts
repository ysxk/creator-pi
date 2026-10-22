/**
 * Motion values the renderer's code shares with its stylesheet
 * (design-system §8, D694).
 */
import type { CSSProperties } from "react";

/**
 * How long a closing surface stays mounted for its exit. It matches
 * `--motion-duration-exit` in tokens.css; motion-tokens.test.mjs keeps the two
 * in step.
 */
export const SURFACE_EXIT_MS = 140;

/** How long a copy's success state holds before it fades back. */
export const COPY_FEEDBACK_MS = 2500;

/**
 * How long a reader's open of a fold counts as opening: the glide its rows
 * ease in on (405ms) after the last row's 90ms step, plus a frame of slack.
 */
export const FOLD_OPEN_MS = 520;

/**
 * Where a floating surface grows from: the edge that touches what opened it.
 * `above` is a surface placed over its anchor, which therefore grows upward.
 * surface-motion.css reads both properties.
 */
export function surfaceOrigin(
  above: boolean,
  edge: "left" | "center" | "right",
): CSSProperties {
  return {
    "--ds-surface-origin": `${edge} ${above ? "bottom" : "top"}`,
    "--ds-surface-shift": above ? "4px" : "-4px",
  } as CSSProperties;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
