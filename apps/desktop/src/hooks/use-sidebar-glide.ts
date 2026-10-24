import { useEffect, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** Longest a selection glide runs; the snap spring settles in 388ms. */
const SELECTION_GLIDE_MS = 420;
const ROW = "[data-sidebar-session-row]";

function rowFor(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-sidebar-session-row="${CSS.escape(id)}"]`);
}

/** A row's box inside the sidebar body, where the glide layers live. */
function boxIn(root: HTMLElement, row: HTMLElement) {
  const rootRect = root.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return {
    top: rect.top - rootRect.top,
    left: rect.left - rootRect.left,
    width: rect.width,
    height: rect.height,
  };
}

/** Fully shown by its own list: a glide toward a clipped row would end in the air. */
function onScreen(root: HTMLElement, row: HTMLElement): boolean {
  const rect = row.getBoundingClientRect();
  if (rect.height === 0) return false;
  for (const frame of [row.parentElement?.closest<HTMLElement>(".sidebar-session-group-body, .sidebar-session-groups"), root]) {
    if (!frame) continue;
    const bounds = frame.getBoundingClientRect();
    if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) return false;
  }
  return true;
}

function place(layer: HTMLElement, box: ReturnType<typeof boxIn>) {
  layer.style.top = `${box.top}px`;
  layer.style.left = `${box.left}px`;
  layer.style.width = `${box.width}px`;
  layer.style.height = `${box.height}px`;
}

/**
 * Selection and hover that travel in the sidebar (D696).
 *
 * When the selected session changes, a pill painted like the selection slides
 * from the row that had it to the row that gets it on the snap spring — across
 * the pinned, temporary and project lists alike — then hands over to the row's
 * own background (`data-selection-gliding` holds that background back
 * meanwhile). While the pointer moves over the rows, one hover tile follows it
 * instead of each row lighting up on its own (`data-hover-gliding`). Both
 * layers sit under the rows in the sidebar body. A glide toward or away from a
 * row its list has scrolled out of view, a scroll under the pointer, and
 * everything under reduced motion fall back to the rows' own backgrounds.
 */
export function useSidebarGlide(selectedId: string | null) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef<HTMLSpanElement | null>(null);
  const previous = useRef(selectedId);
  const settle = useRef(0);
  const hideHover = useRef(() => {});

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = selectedId;
    // The row just selected paints itself; a hover tile left under it (a click
    // does not move the pointer) would double its paint.
    hideHover.current();
    const root = rootRef.current;
    const pill = pillRef.current;
    if (!root || !pill || !before || !selectedId || before === selectedId) return;
    if (prefersReducedMotion()) return;
    const from = rowFor(root, before);
    const to = rowFor(root, selectedId);
    if (!from || !to || !onScreen(root, from) || !onScreen(root, to)) return;
    window.clearTimeout(settle.current);
    pill.style.transition = "none";
    place(pill, boxIn(root, from));
    pill.style.opacity = "1";
    void pill.offsetWidth;
    pill.style.transition = "";
    place(pill, boxIn(root, to));
    root.dataset.selectionGliding = "";
    settle.current = window.setTimeout(() => {
      delete root.dataset.selectionGliding;
      pill.style.opacity = "0";
    }, SELECTION_GLIDE_MS);
  }, [selectedId]);

  useEffect(() => () => window.clearTimeout(settle.current), []);

  useEffect(() => {
    const root = rootRef.current;
    const tile = hoverRef.current;
    if (!root || !tile) return;
    let shown = false;
    const hide = () => {
      if (!shown) return;
      shown = false;
      tile.style.opacity = "0";
      delete root.dataset.hoverGliding;
    };
    hideHover.current = hide;
    const follow = (event: PointerEvent) => {
      const row = (event.target as Element | null)?.closest?.<HTMLElement>(ROW);
      if (!row || !root.contains(row) || row.classList.contains("active") || prefersReducedMotion()) {
        hide();
        return;
      }
      // The first row under the pointer is lit where it is; later ones glide.
      if (!shown) tile.style.transition = "none";
      place(tile, boxIn(root, row));
      if (!shown) {
        void tile.offsetWidth;
        tile.style.transition = "";
      }
      shown = true;
      tile.style.opacity = "1";
      root.dataset.hoverGliding = "";
    };
    root.addEventListener("pointerover", follow);
    root.addEventListener("pointerleave", hide);
    root.addEventListener("dragstart", hide);
    // The tile does not scroll with a list; the next pointer move brings it back.
    root.addEventListener("scroll", hide, true);
    return () => {
      root.removeEventListener("pointerover", follow);
      root.removeEventListener("pointerleave", hide);
      root.removeEventListener("dragstart", hide);
      root.removeEventListener("scroll", hide, true);
    };
  }, []);

  return { rootRef, pillRef, hoverRef };
}
