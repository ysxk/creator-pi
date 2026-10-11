import { useCallback, useRef, type RefObject } from "react";
import { mediaViewUrl } from "@pi-desktop/shared";
import { MediaHoverCard } from "../../../components/ImageHoverCard";
import { useComposerMediaHover } from "./hooks/useComposerMediaHover";
import type { ComposerFileReference } from "./model";

/**
 * Hover player for the audio chips in the draft. The recording streams over
 * the host-owned pi-media: scheme by the path the chip names — a pasted file's
 * scratch path or a workspace-relative `@` reference — which the main process
 * re-resolves and confines on every request, so the renderer never loads a raw
 * filesystem path itself. The card is the shared media card the transcript's
 * chips use, so a recording sounds the same before and after it is sent.
 */
export function ComposerMediaHover({ references, editorRef }: {
  references: ComposerFileReference[];
  editorRef: RefObject<HTMLDivElement | null>;
}) {
  // The draft hands back a fresh `references` array on every render, so keep
  // the lookup stable: the hover listeners must not detach while the pointer
  // still rests on a chip.
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const referenceForToken = useCallback(
    (token: string) =>
      referencesRef.current.find(
        (reference) => reference.token === token && reference.kind === "audio",
      ) ?? null,
    [],
  );
  const { target, dismiss, keep } = useComposerMediaHover(editorRef, referenceForToken);
  // A chip removed from the draft takes its card with it.
  const live =
    target !== null &&
    references.some(
      (reference) => reference.token === target.reference.token && reference.kind === "audio",
    );
  return (
    <MediaHoverCard
      media="audio"
      src={live ? mediaViewUrl(target.reference.path) : null}
      anchor={live ? target.anchor : null}
      onDismiss={dismiss}
      onPointerEnter={keep}
    />
  );
}
