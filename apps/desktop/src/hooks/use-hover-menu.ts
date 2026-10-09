import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** How long the pointer may be outside both the anchor and the menu. */
const LEAVE_GRACE_MS = 140;

/**
 * A menu that opens the moment the pointer rests on its anchor and stays open
 * while the pointer is over the anchor or the menu itself.
 *
 * There is no show delay: the menu is a second, faster way to do what a click
 * on the anchor already does, so it should be there by the time the pointer
 * stops. The grace period only covers the gap the pointer crosses between the
 * two. Touch and pen never open it — they have no hover, and a tap must keep
 * its click meaning — and neither does a pointer that arrives mid-drag.
 */
export function useHoverMenu({ disabled = false }: { disabled?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = useCallback(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined;
      setOpen(false);
    }, LEAVE_GRACE_MS);
  }, [cancelClose]);

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent) => {
      if (disabled || event.pointerType !== "mouse" || event.buttons !== 0) return;
      cancelClose();
      setOpen(true);
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

  useEffect(() => cancelClose, [cancelClose]);

  return {
    open,
    /** Open from the keyboard, where there is no pointer to keep it open. */
    openNow: useCallback(() => {
      if (disabled) return;
      cancelClose();
      setOpen(true);
    }, [cancelClose, disabled]),
    close,
    /** Spread on the anchor's wrapper. */
    anchorProps: { onPointerEnter, onPointerLeave },
    /** Spread on the menu's content. */
    menuProps: { onPointerEnter: cancelClose, onPointerLeave },
  };
}
