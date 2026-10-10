/**
 * Build a safe filename only for image formats accepted by the host reader.
 * A picture that is a named file keeps its own name, whatever its format.
 */
export function generatedImageDownloadName(
  dataUrl: string | null,
  index: number,
  name?: string,
): string | null {
  if (!dataUrl) return null;
  if (name) {
    const leaf = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
    return leaf && /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl) ? leaf : null;
  }
  const extension = dataUrl.startsWith("data:image/png;base64,")
    ? "png"
    : dataUrl.startsWith("data:image/jpeg;base64,")
      ? "jpg"
      : dataUrl.startsWith("data:image/webp;base64,")
        ? "webp"
        : null;
  return extension ? `generated-image-${index + 1}.${extension}` : null;
}
