import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";

/**
 * One picture the viewer can show. `name` is set for a picture that is a file
 * the conversation refers to rather than a numbered generation result; it then
 * labels the picture and names its download.
 */
export type GeneratedImageRef = { path: string; mimeType?: string; index: number; name?: string };

export function GeneratedImageThumbnail({ image, selected, onSelect, className }: {
  image: GeneratedImageRef;
  selected: boolean;
  onSelect: () => void;
  className: string;
}) {
  const { t } = useTranslation();
  const src = useReferencedImageDataUrl(image.path, image.mimeType);
  return (
    <TooltipButton
      type="button"
      className={className}
      tooltip={image.name ?? t("settings.generatedImage", { index: image.index + 1 })}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{image.index + 1}</span>}
    </TooltipButton>
  );
}
