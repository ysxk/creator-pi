import type { UpdateMode, UpdatePreference } from "@pi-desktop/shared";

export type WindowsDistribution = "installed" | "zip" | "portable";

/**
 * Whether this fork's releases carry an update feed for the platform (D704).
 * The release matrix builds Windows and Linux only, because the macOS lanes
 * need a Developer ID the fork does not have.
 */
export function hasReleaseFeed(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPackaged) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  if (
    platform === "win32" &&
    (Boolean(env.PORTABLE_EXECUTABLE_FILE) || distribution === "zip" || distribution === "portable")
  ) {
    return "manual";
  }
  return "automatic";
}

export function resolveStoredUpdatePreference(
  value: unknown,
  fallback: UpdatePreference,
): UpdatePreference {
  return value === "automatic" || value === "manual" ? value : fallback;
}

export function resolveEffectiveUpdatePreference(
  preference: UpdatePreference,
  automaticSupported: boolean,
): UpdatePreference {
  return automaticSupported ? preference : "manual";
}

export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
  preference?: UpdatePreference,
): UpdateMode {
  if (!isPackaged) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  const selected =
    preference ??
    resolveDefaultUpdatePreference(platform, isPackaged, env, distribution);
  return selected === "automatic" ? "in-app" : "manual";
}
