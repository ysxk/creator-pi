/**
 * Exit motion for modal overlays (D694) and the sidebar's floating menus (D696).
 *
 * Every dialog portals one `.overlay` into a host — the overlay host
 * (`portalOverlay`) or `document.body` (`portalToBody`) — and simply unmounts
 * when it closes, so on its own it could only ever snap away; the sidebar's
 * floating menus portal to the body the same way. Each host is watched
 * instead: when such a layer leaves, a static copy takes its place for the
 * exit (surface-motion.css) and removes itself once that exit has played.
 * No dialog or menu has to know.
 *
 * The copy only looks like the dialog. It is inert and click-through, and it
 * answers to nothing a lookup would use — no ids, roles, labels or names — so
 * neither assistive technology nor code searching the page mistakes it for an
 * open dialog. A dialog that opens anywhere while a copy is leaving clears it
 * at once.
 */
import { prefersReducedMotion } from "./motion";

/** Longest a copy may linger if its exit never reports an end. */
const COPY_LIMIT_MS = 400;

/** Live content a static copy must not duplicate: it would load or run again. */
const UNCOPYABLE = "iframe, webview, video, audio, canvas, object, embed";

/** The layers that leave this way. */
const LEAVING = ".overlay, .sidebar-floating-menu";

/** Attributes that identify an element rather than draw it. */
const IDENTITY = /^(id|for|name|role|title|tabindex|autofocus|data-testid|aria-.+)$/;

const hosts = new Set<HTMLElement>();

function isLiveOverlay(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.matches(LEAVING) &&
    node.dataset.exitGhost === undefined
  );
}

function clearCopies() {
  for (const host of hosts) {
    for (const copy of host.querySelectorAll(":scope > [data-exit-ghost]")) copy.remove();
  }
}

/** Watch one portal host for departing overlays; once per host. */
export function installOverlayExit(host: HTMLElement): () => void {
  if (hosts.has(host)) return () => {};
  hosts.add(host);
  // A removed node no longer has a layout box to read its scroll offset from,
  // so offsets are remembered as they change.
  const offsets = new WeakMap<Element, [top: number, left: number]>();
  const rememberScroll = (event: Event) => {
    if (event.target instanceof Element) {
      offsets.set(event.target, [event.target.scrollTop, event.target.scrollLeft]);
    }
  };
  host.addEventListener("scroll", rememberScroll, true);

  const observer = new MutationObserver((records) => {
    // A dialog that opens takes the stage at once: a copy still leaving would
    // stack its scrim over the new one.
    if (records.some((record) => [...record.addedNodes].some(isLiveOverlay))) {
      clearCopies();
      return;
    }
    if (prefersReducedMotion() || document.visibilityState === "hidden") return;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!isLiveOverlay(node) || node.querySelector(UNCOPYABLE)) continue;
        playExit(host, node, offsets);
      }
    }
  });
  observer.observe(host, { childList: true });
  return () => {
    hosts.delete(host);
    observer.disconnect();
    host.removeEventListener("scroll", rememberScroll, true);
  };
}

function playExit(
  host: HTMLElement,
  overlay: HTMLElement,
  offsets: WeakMap<Element, [number, number]>,
) {
  const copy = overlay.cloneNode(true) as HTMLElement;
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    for (const { name } of [...element.attributes]) {
      if (IDENTITY.test(name)) element.removeAttribute(name);
    }
  }
  copy.dataset.exitGhost = "";
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");

  // Fields keep what was typed into them, which lives in properties, not markup.
  const fields = "input, textarea, select";
  const liveFields = overlay.querySelectorAll<HTMLInputElement>(fields);
  copy.querySelectorAll<HTMLInputElement>(fields).forEach((field, index) => {
    const live = liveFields[index];
    if (!live) return;
    field.value = live.value;
    if ("checked" in live) field.checked = live.checked;
  });

  host.appendChild(copy);

  const liveElements = [overlay, ...overlay.querySelectorAll("*")];
  const copiedElements = [copy, ...copy.querySelectorAll("*")];
  liveElements.forEach((element, index) => {
    const offset = offsets.get(element);
    const target = copiedElements[index];
    if (!offset || !target) return;
    target.scrollTop = offset[0];
    target.scrollLeft = offset[1];
  });

  let timer = 0;
  const finish = () => {
    window.clearTimeout(timer);
    copy.remove();
  };
  copy.addEventListener("animationend", (event) => {
    if (event.target === copy) finish();
  });
  timer = window.setTimeout(finish, COPY_LIMIT_MS);
}
