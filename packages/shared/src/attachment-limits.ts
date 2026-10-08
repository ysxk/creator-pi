/**
 * Maximum raw image size that may be embedded in a provider request.
 *
 * MiniMax's OpenAI-compatible endpoint accepts one image up to 10 MB. Keep
 * the bound decimal and shared by Electron main and the sidecar so a replay
 * cannot take a different transport path from a fresh prompt.
 */
export const MAX_INLINE_IMAGE_BYTES = 10_000_000;

/**
 * Maximum aggregate raw image bytes inlined into V8 memory during history restoration.
 * Bounds total base64 memory footprint to protect against sidecar heap exhaustion (#1077).
 */
export const MAX_INLINED_IMAGE_HISTORY_BYTES = 30_000_000;

/**
 * Maximum raw video size that may be embedded in a provider request. Gemini's
 * inline (base64) media limit is 20 MB per request; keep the bound shared by
 * Electron main and the sidecar so a replay cannot take a different transport
 * path from a fresh prompt.
 */
export const MAX_INLINE_VIDEO_BYTES = 20_000_000;

/**
 * Maximum aggregate raw video bytes inlined during history restoration. Video
 * rehydration shares the newest-first budget discipline images use, with its
 * own ceiling because a handful of clips already dwarfs the image budget.
 */
export const MAX_INLINED_VIDEO_HISTORY_BYTES = 60_000_000;
