import { useEffect, useReducer, useRef, useState } from "react";
import { createInkClock, type InkClock } from "../lib/ink-bloom";

/**
 * The clock a streaming reply's ink bloom reads (D695), fed by the length of
 * the text on screen. Text already there when the reply mounts — a pane
 * restored mid-stream — is ink from the start; only what appears afterwards
 * blooms.
 *
 * Returns undefined while nothing is blooming, and always while `active` is
 * false, which leaves the reply's Markdown exactly as it renders without the
 * effect. When the last character has bloomed the reply renders once more, so
 * its finished spans turn back into plain text instead of waiting to replay
 * when their block is shown again (a folded turn process opening).
 */
export function useInkClock(visibleLength: number, active: boolean): InkClock | undefined {
  const [clock] = useState(createInkClock);
  const shown = useRef(visibleLength);
  const [, settle] = useReducer((renders: number) => renders + 1, 0);
  if (active && visibleLength !== shown.current) {
    if (visibleLength > shown.current) clock.reveal(shown.current, visibleLength, performance.now());
    else clock.reset();
  }
  shown.current = visibleLength;
  const settlesAt = active ? clock.settlesAt() : Number.NEGATIVE_INFINITY;
  const blooming = settlesAt > performance.now();
  useEffect(() => {
    if (!blooming) return;
    const timer = window.setTimeout(settle, settlesAt - performance.now() + 1);
    return () => window.clearTimeout(timer);
  }, [blooming, settlesAt]);
  return blooming ? clock : undefined;
}
