import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ComposerFileReference } from "../model";

export type ComposerMediaHoverTarget = {
  reference: ComposerFileReference;
  /** Viewport rect of the hovered chip, used to place the player card. */
  anchor: { left: number; top: number; bottom: number; width: number };
};

/** Pointer dwell before a chip reveals its player. */
const HOVER_DELAY_MS = 180;
/** How long an open card waits for the pointer to cross the gap to it. */
const LEAVE_GRACE_MS = 400;

const MEDIA_CHIP_SELECTOR = ".composer-chip[data-audio]";

/**
 * Track the audio chip under the pointer inside the composer editor, for its
 * player card. Chips are painted imperatively, so the editor delegates pointer
 * movement here instead of every chip owning preview state.
 *
 * Unlike the image card, the player takes pointer events, so leaving the chip
 * does not close it at once: the card is portal-rendered with a gap from the
 * chip, and the pointer needs a moment to cross that gap to the controls.
 * `keep` is what the card calls when the pointer arrives; without it the card
 * closes after the grace period. The card closes on its own pointer leave,
 * when the draft changes or scrolls, and when another chip is hovered.
 */
export function useComposerMediaHover(
  editorRef: RefObject<HTMLDivElement | null>,
  referenceForToken: (token: string) => ComposerFileReference | null,
): { target: ComposerMediaHoverTarget | null; dismiss: () => void; keep: () => void } {
  const [target, setTarget] = useState<ComposerMediaHoverTarget | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const cancelLeave = useCallback(() => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const dismiss = useCallback(() => {
    cancelLeave();
    setTarget(null);
  }, [cancelLeave]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let timer: number | null = null;
    let pending: string | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const hide = () => {
      cancel();
      dismiss();
    };
    const chipOf = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>(MEDIA_CHIP_SELECTOR) : null;
    const reveal = (chip: HTMLElement, reference: ComposerFileReference) => {
      cancelLeave();
      const rect = chip.getBoundingClientRect();
      setTarget({
        reference,
        anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
      });
    };
    const onPointerOver = (event: PointerEvent) => {
      const chip = chipOf(event.target);
      if (!chip) {
        // Over the draft's text: a reveal that has not happened yet is
        // dropped, while an open card waits out its grace period.
        cancel();
        return;
      }
      const token = chip.dataset.token ?? "";
      const reference = referenceForToken(token);
      if (!reference) {
        hide();
        return;
      }
      if (pending === token) return;
      cancel();
      pending = token;
      timer = window.setTimeout(() => {
        timer = null;
        if (pending === token) reveal(chip, reference);
      }, HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const chip = chipOf(event.target);
      if (!chip || chipOf(event.relatedTarget) === chip) return;
      cancel();
      cancelLeave();
      leaveTimer.current = window.setTimeout(() => {
        leaveTimer.current = null;
        setTarget(null);
      }, LEAVE_GRACE_MS);
    };
    editor.addEventListener("pointerover", onPointerOver);
    editor.addEventListener("pointerout", onPointerOut);
    // A chip that moves under the pointer (typing, wrapping, scrolling) must
    // never leave a stale card behind.
    editor.addEventListener("input", hide);
    editor.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      cancel();
      cancelLeave();
      editor.removeEventListener("pointerover", onPointerOver);
      editor.removeEventListener("pointerout", onPointerOut);
      editor.removeEventListener("input", hide);
      editor.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [editorRef, referenceForToken, dismiss, cancelLeave]);

  return { target, dismiss, keep: cancelLeave };
}
