import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { portalToBody } from "../lib/portal-visibility";
import "../styles/image-hover-card.css";

/** Viewport rect of the chip that owns the card. */
export type ImageHoverAnchor = {
  left: number;
  top: number;
  bottom: number;
  width: number;
};

/** Distance between the hovered chip and its preview card. */
const PREVIEW_GAP = 8;

/**
 * Read-only preview card shared by every image chip (composer draft and
 * transcript). It renders nothing without a decoded source, never takes pointer
 * events, and asks its owner to dismiss it when the content moves underneath.
 */
export function ImageHoverCard({ src, anchor, onDismiss }: {
  src: string | null;
  anchor: ImageHoverAnchor | null;
  onDismiss?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<"above" | "below">("above");
  useLayoutEffect(() => {
    const card = cardRef.current;
    // A chip on the first line has no room above it.
    if (!anchor || !card) return;
    setPlacement(anchor.top - card.offsetHeight - PREVIEW_GAP < 0 ? "below" : "above");
  }, [anchor, src]);
  useEffect(() => {
    if (!anchor || !src || !onDismiss) return;
    const dismiss = () => onDismiss();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [anchor, src, onDismiss]);
  if (!anchor || !src) return null;
  return portalToBody(
    <div
      ref={cardRef}
      className="image-hover-card"
      data-placement={placement}
      role="presentation"
      style={{
        left: anchor.left + anchor.width / 2,
        top: placement === "above" ? anchor.top - PREVIEW_GAP : anchor.bottom + PREVIEW_GAP,
      }}
    >
      <img src={src} alt="" draggable={false} />
    </div>,
  );
}

/** What a media card plays: a clip in a video element, a recording in an audio element. */
export type HoverMedia = "video" | "audio";

/**
 * Hover player for a video or audio chip: same placement discipline as the
 * image card, but the card takes pointer events because the controls are the
 * point. The stream comes from the host-owned pi-media: scheme, so the
 * renderer never loads a raw filesystem path.
 *
 * The card is portal-rendered with a gap from its chip, so it owns its own
 * exit — the chip's pointerleave must not close it, or the pointer could
 * never cross the gap to the controls. It dismisses on leaving the card
 * itself, on Escape while open, and on scroll/resize like the image card.
 */
export function MediaHoverCard({ media, src, anchor, onDismiss, onPointerEnter, cardRef }: {
  media: HoverMedia;
  src: string | null;
  anchor: ImageHoverAnchor | null;
  onDismiss?: () => void;
  /** The pointer reached the card: an owner with a grace timer cancels it here. */
  onPointerEnter?: () => void;
  /** The owner's ref to this card's element, so it can tell its own card from
   * another attachment's when several are open at once. */
  cardRef?: RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<"above" | "below">("above");
  useLayoutEffect(() => {
    const card = localRef.current;
    if (!anchor || !card) return;
    setPlacement(anchor.top - card.offsetHeight - PREVIEW_GAP < 0 ? "below" : "above");
  }, [anchor, src]);
  useEffect(() => {
    if (!anchor || !src || !onDismiss) return;
    const dismiss = () => onDismiss();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, src, onDismiss]);
  const setCardRef = (element: HTMLDivElement | null) => {
    localRef.current = element;
    // A plain RefObject (not a callback param), so write `.current` directly.
    if (cardRef) cardRef.current = element;
  };
  /*
    The card owns its keyboard exit: focus leaving the player's controls (or
    the card itself) dismisses, unless it is heading back to the owning chip,
    which keeps the card open for another entry.
  */
  const onCardBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    onDismiss?.();
  };
  if (!anchor || !src) return null;
  return portalToBody(
    <div
      ref={setCardRef}
      className="image-hover-card is-interactive"
      data-placement={placement}
      data-media={media}
      role="presentation"
      style={{
        left: anchor.left + anchor.width / 2,
        top: placement === "above" ? anchor.top - PREVIEW_GAP : anchor.bottom + PREVIEW_GAP,
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onDismiss}
      onBlur={onCardBlur}
    >
      {media === "video" ? (
        <video src={src} controls preload="metadata" />
      ) : (
        <audio src={src} controls preload="metadata" />
      )}
    </div>,
  );
}
