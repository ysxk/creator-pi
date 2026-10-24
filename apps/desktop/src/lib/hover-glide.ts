/**
 * Hover that travels inside menus (D696).
 *
 * In every floating menu — the anchored menus, the context menu and the
 * sidebar's floating menus — one tile follows the pointer from item to item on
 * the snap spring instead of each item lighting up on its own. One delegated
 * listener serves them all, and a menu gets its tile the first time one of its
 * items is hovered. An item that shows a selection or is disabled keeps its
 * own look, and nothing moves under reduced motion.
 */
import { prefersReducedMotion } from "./motion";

const SURFACE = "[data-surface-motion], .sidebar-floating-menu";
const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
const OWN_LOOK = '.active, .selected, [aria-checked="true"], [aria-selected="true"], :disabled, [aria-disabled="true"]';

let installed = false;

/** Where an item sits in its menu's padding box, scrolled content included. */
function boxIn(surface: HTMLElement, item: HTMLElement) {
  const surfaceRect = surface.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  return {
    top: rect.top - surfaceRect.top - surface.clientTop + surface.scrollTop,
    left: rect.left - surfaceRect.left - surface.clientLeft + surface.scrollLeft,
    width: rect.width,
    height: rect.height,
  };
}

/** Start following the pointer in floating menus; once per document. */
export function installHoverGlide() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let current: { surface: HTMLElement; tile: HTMLElement } | null = null;

  const hide = () => {
    if (!current) return;
    current.tile.style.opacity = "0";
    delete current.surface.dataset.hoverGliding;
    current = null;
  };

  document.addEventListener("pointerover", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const surface = target?.closest<HTMLElement>(SURFACE) ?? null;
    if (current && current.surface !== surface) hide();
    if (!surface || surface.dataset.surfaceState === "closing" || prefersReducedMotion()) return;
    const item = target?.closest<HTMLElement>(ITEM);
    // Between items — a separator, a heading — the tile stays where it was.
    if (!item || !surface.contains(item)) return;
    if (item.matches(OWN_LOOK)) {
      hide();
      return;
    }
    let tile = surface.querySelector<HTMLElement>(":scope > .surface-hover-glide");
    if (!tile) {
      tile = document.createElement("span");
      tile.className = "surface-hover-glide";
      tile.setAttribute("aria-hidden", "true");
      surface.prepend(tile);
    }
    const arriving = current === null;
    if (arriving) tile.style.transition = "none";
    const box = boxIn(surface, item);
    tile.style.top = `${box.top}px`;
    tile.style.left = `${box.left}px`;
    tile.style.width = `${box.width}px`;
    tile.style.height = `${box.height}px`;
    tile.style.borderRadius = getComputedStyle(item).borderRadius;
    if (arriving) {
      void tile.offsetWidth;
      tile.style.transition = "";
    }
    tile.style.opacity = "1";
    surface.dataset.hoverGliding = "";
    current = { surface, tile };
  });

  document.addEventListener("pointerout", (event) => {
    if (!current) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !current.surface.contains(next)) hide();
  });

  // The tile would not follow a list scrolling under it.
  document.addEventListener(
    "scroll",
    (event) => {
      if (current && event.target instanceof Node && current.surface.contains(event.target)) hide();
    },
    true,
  );
}
