import { useEffect, useState } from "react";
import { prefersReducedMotion, SURFACE_EXIT_MS } from "../lib/motion";

export type Presence = {
  /** Render the surface: it is open, or still playing its exit. */
  present: boolean;
  /** The exit window: play the exit and take no input. */
  closing: boolean;
};

/**
 * Keeps a surface mounted through its exit (D694).
 *
 * A surface rendered only while `open` vanishes the moment it closes, so it
 * can never leave gracefully. This holds it for `exitMs` after `open` turns
 * false. The hold starts in the same render that closes it, so no frame drops
 * the surface early, and reopening during the exit simply resumes the open
 * surface. Reduced motion lets go on the next tick.
 */
export function usePresence(open: boolean, exitMs = SURFACE_EXIT_MS): Presence {
  const [lingering, setLingering] = useState(false);
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    setLingering(!open);
  }

  useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(
      () => setLingering(false),
      prefersReducedMotion() ? 0 : exitMs,
    );
    return () => window.clearTimeout(timer);
  }, [exitMs, lingering]);

  return { present: open || lingering, closing: !open && lingering };
}
