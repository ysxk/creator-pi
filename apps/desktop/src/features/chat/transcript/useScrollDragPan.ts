import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

type Drag = { pointerId: number; element: HTMLElement; startX: number; startY: number; left: number; top: number };

/**
 * Drag a picture to scroll its viewport. The viewer's wheel zooms, so a
 * picture larger than the viewport needs another way to move around.
 */
export function useScrollDragPan(viewportRef: RefObject<HTMLElement | null>) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }, []);
  const end = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const { element, pointerId } = drag.current;
    drag.current = null;
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    setDragging(false);
  };
  return {
    dragging,
    imageHandlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const viewport = viewportRef.current;
        if (event.button !== 0 || !event.isPrimary || drag.current || !viewport) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          element: event.currentTarget,
          startX: event.clientX,
          startY: event.clientY,
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
        };
        setDragging(true);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = drag.current;
        const viewport = viewportRef.current;
        if (!current || current.pointerId !== event.pointerId || !viewport) return;
        viewport.scrollLeft = current.left - (event.clientX - current.startX);
        viewport.scrollTop = current.top - (event.clientY - current.startY);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    },
  };
}
