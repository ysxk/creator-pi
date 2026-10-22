export type Point = { x: number; y: number };

// One mouse-wheel notch arrives as roughly 40-100 px, which this scale turns
// into a 1.15x-1.4x step; the attachment viewer's pinch already used it. The
// cap keeps an accelerated spin from leaping several steps in one event.
const MAX_WHEEL_STEP_PX = 100;
const WHEEL_PX_PER_E = 300;

/**
 * Scale factor for one wheel event in an image viewer. A plain wheel and a
 * trackpad pinch (which Chromium reports as a wheel with ctrlKey) both zoom;
 * scrolling down zooms out.
 */
export function wheelZoomFactor(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  pageHeight: number,
): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  const delta = Math.max(-MAX_WHEEL_STEP_PX, Math.min(MAX_WHEEL_STEP_PX, event.deltaY * unit));
  return Math.exp(-delta / WHEEL_PX_PER_E);
}

/**
 * New offset of an image's centre, measured like `anchor` from the same
 * origin, so the picture point under `anchor` stays under it when the scale
 * changes from `from` to `to`.
 */
export function anchoredZoomOffset(anchor: Point, offset: Point, from: number, to: number): Point {
  const ratio = to / from;
  return {
    x: anchor.x - (anchor.x - offset.x) * ratio,
    y: anchor.y - (anchor.y - offset.y) * ratio,
  };
}
