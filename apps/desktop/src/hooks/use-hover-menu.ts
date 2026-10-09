import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** How long the pointer may be outside both the anchor and the menu. */
const LEAVE_GRACE_MS = 140;
/** How long the pointer has to stay on the anchor before the menu opens. */
const SHOW_DWELL_MS = 100;

/**
 * A menu that opens as the pointer comes to rest on its anchor and stays open
 * while the pointer is over the anchor or the menu itself.
 *
 * The dwell is not a tooltip delay — it is below what reads as waiting — it
 * only tells a pointer that stopped from one that is passing through. The
 * menu opens over whatever is next to the anchor, so opening for a pointer on
 * its way there puts the menu under it and takes that surface away: the
 * composer's mode menu covered the editor for every hand that crossed the chip
 * to reach it. The grace period covers the gap the pointer crosses between
 * anchor and menu. Touch and pen never open it — they have no hover, and a tap
 * must keep its click meaning — and neither does a pointer that arrives
 * mid-drag.
 */
export function useHoverMenu({ disabled = false }: { disabled?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = useCallback(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  const cancelShow = useCallback(() => {
    clearTimeout(showTimer.current);
    showTimer.current = undefined;
  }, []);

  const close = useCallback(() => {
    cancelShow();
    cancelClose();
    setOpen(false);
  }, [cancelClose, cancelShow]);

  const scheduleClose = useCallback(() => {
    // A pointer that left before the dwell ran out was only passing through.
    cancelShow();
    cancelClose();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined;
      setOpen(false);
    }, LEAVE_GRACE_MS);
  }, [cancelClose, cancelShow]);

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent) => {
      if (disabled || event.pointerType !== "mouse" || event.buttons !== 0) return;
      // Coming back from the menu keeps it open; only a fresh arrival dwells.
      cancelClose();
      if (showTimer.current !== undefined) return;
      showTimer.current = setTimeout(() => {
        showTimer.current = undefined;
        setOpen(true);
      }, SHOW_DWELL_MS);
    },
    [cancelClose, disabled],
  );

  const onPointerLeave = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType !== "mouse") return;
      scheduleClose();
    },
    [scheduleClose],
  );

  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  useEffect(() => {
    if (!open) return;
    // A hover surface must not outlive the context it was opened in.
    const onVisibility = () => {
      if (document.hidden) close();
    };
    window.addEventListener("blur", close);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", close);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [close, open]);

  useEffect(
    () => () => {
      cancelClose();
      cancelShow();
    },
    [cancelClose, cancelShow],
  );

  return {
    open,
    /** Open from the keyboard, where there is no pointer to keep it open. */
    openNow: useCallback(() => {
      if (disabled) return;
      cancelShow();
      cancelClose();
      setOpen(true);
    }, [cancelClose, cancelShow, disabled]),
    close,
    /** Spread on the anchor's wrapper. */
    anchorProps: { onPointerEnter, onPointerLeave },
    /** Spread on the menu's content. */
    menuProps: { onPointerEnter: cancelClose, onPointerLeave },
  };
}
