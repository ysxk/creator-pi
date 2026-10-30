import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import {
  applyDevelopmentUserData,
  applyProfileUserData,
  desktopDataDir,
  parseInstallationProfile,
  SHIPPED_PROFILE,
  type InstallationProfile,
} from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";
import { hasReleaseFeed } from "./update-policy";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;

/** A personal build's identity; the shipped one for every other build. */
function readInstallationProfile(): InstallationProfile {
  if (isDevelopmentBuild) return SHIPPED_PROFILE;
  try {
    return parseInstallationProfile(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    );
  } catch {
    // Unreadable metadata is not a reason to refuse to start.
    return SHIPPED_PROFILE;
  }
}
const installationProfile = readInstallationProfile();
/**
 * False in development, in a personal build that must not self-replace, and on
 * a platform whose releases carry no update feed.
 */
export const updatesEnabled =
  !isDevelopmentBuild && installationProfile.updates && hasReleaseFeed(process.platform);

app.setName(APP_NAME);
applyDevelopmentUserData(app, isDevelopmentBuild);
if (!isDevelopmentBuild) applyProfileUserData(app, installationProfile.name);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
export const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild, installationProfile.dataDirName);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
