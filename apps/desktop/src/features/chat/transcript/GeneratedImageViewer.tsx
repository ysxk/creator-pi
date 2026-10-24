import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight, IconClose, IconDownload, IconExternal, IconFolder, IconMinus, IconPlus } from "../../../components/icons";
import { Button, TooltipButton } from "../../../components/ui";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { api } from "../../../lib/api";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";
import { wheelZoomFactor } from "../../../lib/image-wheel-zoom";
import { portalToBody } from "../../../lib/portal-visibility";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import { useAppStore } from "../../../stores/app-store";
import { generatedImageDownloadName } from "./generated-image-download";
import { useScrollDragPan } from "./useScrollDragPan";
import { GeneratedImageThumbnail, type GeneratedImageRef } from "./GeneratedImageThumbnail";

export function GeneratedImageViewer({ images, selectedIndex, onSelect, onClose, focusReturnRef }: {
  images: GeneratedImageRef[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  focusReturnRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const wheelAnchorRef = useRef<{ fx: number; fy: number; clientX: number; clientY: number } | null>(null);
  const knownNaturalSizesRef = useRef(new Map<string, { width: number; height: number }>());
  const navigationRequestRef = useRef(0);
  const pendingIndexRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const [manualZoom, setManualZoom] = useState<{ src: string; value: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const selected = images[selectedIndex];
  const src = useReferencedImageDataUrl(selected?.path, selected?.mimeType);
  const size = selected && src && failedSrc !== src
    ? knownNaturalSizesRef.current.get(selected.path) ?? (natural?.src === src ? natural : null)
    : null;
  // A raster picture is never blown up past its own pixels; a vector one has
  // none to run out of, so it fills the space it is given.
  const vector = src?.startsWith("data:image/svg+xml") === true;
  const fit = size && viewport.width > 0 && viewport.height > 0
    ? Math.min(vector ? Number.POSITIVE_INFINITY : 1, viewport.width / size.width, viewport.height / size.height)
    : 1;
  const maxZoom = Math.max(4, fit);
  const zoom = manualZoom?.src === src ? manualZoom.value : fit;
  const downloadName = generatedImageDownloadName(src, selected?.index ?? 0, selected?.name);
  const label = selected
    ? selected.name ?? t("settings.generatedImage", { index: selected.index + 1 })
    : "";
  const openFile = useOpenChatFileRef();
  useBlockingOverlay();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      navigationRequestRef.current += 1;
      pendingIndexRef.current = null;
      dialog.close();
      focusReturnRef.current?.focus();
    };
  }, [focusReturnRef]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectImage = async (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= images.length) return;
    const request = ++navigationRequestRef.current;
    if (nextIndex === selectedIndex) {
      pendingIndexRef.current = null;
      return;
    }
    pendingIndexRef.current = nextIndex;
    const thumbnail = dialogRef.current?.querySelectorAll<HTMLImageElement>(".generated-image-viewer-thumb img")[nextIndex];
    if (thumbnail?.src) {
      try {
        await thumbnail.decode();
      } catch {
        // The viewer will show its existing unavailable state for unreadable images.
      }
      if (request !== navigationRequestRef.current) return;
      if (thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0) {
        knownNaturalSizesRef.current.set(images[nextIndex].path, {
          width: thumbnail.naturalWidth,
          height: thumbnail.naturalHeight,
        });
      }
    }
    if (request === navigationRequestRef.current) {
      pendingIndexRef.current = null;
      onSelect(nextIndex);
    }
  };
  const move = (direction: number) => {
    void selectImage((pendingIndexRef.current ?? selectedIndex) + direction);
  };
  const closeViewer = () => {
    navigationRequestRef.current += 1;
    pendingIndexRef.current = null;
    onClose();
  };
  const clampZoom = (value: number) => Math.min(maxZoom, Math.max(Math.min(0.1, fit), value));
  const changeZoom = (value: number) => {
    if (src) setManualZoom({ src, value: clampZoom(value) });
  };
  const pan = useScrollDragPan(viewportRef);

  // Several wheel events can land before React renders the previous one, so
  // each builds on the last one's zoom rather than on a stale render value.
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => { zoomRef.current = zoom; });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const image = imageRef.current;
      if (!src || !size || !image) return;
      event.preventDefault();
      event.stopPropagation();
      const from = zoomRef.current;
      const to = clampZoom(from * wheelZoomFactor(event, element.clientHeight));
      if (to === from) return;
      // Remember which part of the picture is under the cursor; once the new
      // size is laid out, the scroll position puts that part back under it.
      const rect = image.getBoundingClientRect();
      const fraction = (offset: number, length: number) => Math.min(1, Math.max(0, offset / length));
      wheelAnchorRef.current = {
        fx: fraction(event.clientX - rect.left, rect.width),
        fy: fraction(event.clientY - rect.top, rect.height),
        clientX: event.clientX,
        clientY: event.clientY,
      };
      zoomRef.current = to;
      setManualZoom({ src, value: to });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [src, size, fit, maxZoom]);
  useLayoutEffect(() => {
    const anchor = wheelAnchorRef.current;
    const element = viewportRef.current;
    const image = imageRef.current;
    wheelAnchorRef.current = null;
    if (!anchor || !element || !image) return;
    const rect = image.getBoundingClientRect();
    element.scrollLeft += rect.left + anchor.fx * rect.width - anchor.clientX;
    element.scrollTop += rect.top + anchor.fy * rect.height - anchor.clientY;
  }, [zoom]);
  const reveal = async () => {
    if (!selected) return;
    try {
      await api.fsReveal(selected.path);
    } catch {
      useAppStore.getState().showToast(t("settings.imageRevealFailed"), { variant: "error" });
    }
  };
  if (!selected) return null;

  return portalToBody(
    <dialog
      ref={dialogRef}
      className="generated-image-viewer"
      aria-label={label}
      onCancel={(event) => { event.preventDefault(); closeViewer(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <header className="generated-image-viewer-header">
        <TooltipButton type="button" autoFocus onClick={closeViewer} tooltip={t("common.close")}><IconClose size={18} /></TooltipButton>
        <strong>{label}</strong>
        <div className="generated-image-viewer-header-actions">
          <TooltipButton type="button" onClick={() => { closeViewer(); void openFile(selected.path); }} tooltip={t("chat.previewFile")}><IconExternal size={18} /></TooltipButton>
          <TooltipButton type="button" onClick={() => void reveal()} tooltip={t("settings.revealGeneratedImage")}><IconFolder size={18} /></TooltipButton>
          {src && downloadName ? <a href={src} download={downloadName} aria-label={t("settings.downloadGeneratedImage")} title={t("settings.downloadGeneratedImage")}><IconDownload size={18} /></a> : null}
        </div>
      </header>
      <div className="generated-image-viewer-body">
        {images.length > 1 ? <nav className="generated-image-viewer-thumbs" aria-label={t("chat.imagePreview.title")}>
          {images.map((image, index) => <GeneratedImageThumbnail key={image.path} image={image} selected={index === selectedIndex} onSelect={() => void selectImage(index)} className="generated-image-viewer-thumb" />)}
        </nav> : null}
        {/* The veil around the picture is the way out: a click that lands on
            it, not on the picture, closes the viewer. */}
        <div
          className="generated-image-viewer-viewport"
          ref={viewportRef}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeViewer();
          }}
        >
          {src && failedSrc !== src ? <img
            ref={imageRef}
            src={src}
            alt={label}
            draggable={false}
            {...pan.imageHandlers}
            data-dragging={pan.dragging || undefined}
            data-sized={size ? "true" : undefined}
            style={size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && height > 0) {
                knownNaturalSizesRef.current.set(selected.path, { width, height });
                setNatural({ src, width, height });
              }
            }}
            onError={() => setFailedSrc(src)}
          /> : <p role="status">{t("settings.imagePreviewUnavailable")}</p>}
        </div>
      </div>
      <footer className="generated-image-viewer-footer">
        {images.length > 1 ? <div className="generated-image-viewer-navigation">
          <TooltipButton type="button" disabled={selectedIndex === 0} onClick={() => move(-1)} tooltip={t("chat.imagePreview.previous")}><IconChevronLeft size={18} /></TooltipButton>
          <span role="status">{t("chat.imagePreview.position", { current: selectedIndex + 1, total: images.length })}</span>
          <TooltipButton type="button" disabled={selectedIndex === images.length - 1} onClick={() => move(1)} tooltip={t("chat.imagePreview.next")}><IconChevronRight size={18} /></TooltipButton>
        </div> : null}
        <div className="generated-image-viewer-zoom">
          <TooltipButton type="button" disabled={!size || zoom <= Math.min(0.1, fit)} onClick={() => changeZoom(zoom / 1.25)} tooltip={t("menu.zoomOut")}><IconMinus size={18} /></TooltipButton>
          <output>{Math.round(zoom * 100)}%</output>
          <TooltipButton type="button" disabled={!size || zoom >= maxZoom} onClick={() => changeZoom(zoom * 1.25)} tooltip={t("menu.zoomIn")}><IconPlus size={18} /></TooltipButton>
          <Button type="button" variant="ghost" disabled={!size} onClick={() => setManualZoom(null)}>{t("chat.imagePreview.fit")}</Button>
        </div>
      </footer>
    </dialog>,
  );
}
