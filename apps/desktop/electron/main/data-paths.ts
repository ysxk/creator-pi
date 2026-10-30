import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME } from "@pi-desktop/shared";

/**
 * The two directories that define an installation, and the development split
 * between them.
 *
 * A packaged PI-Desktop and a `pnpm dev` host used to share both: the
 * name-derived `userData` — where Electron keeps the single-instance lock,
 * renderer `localStorage`, and the plugin panel partitions — and
 * `~/.pi-desktop`, where host-core keeps `pi.sqlite` beside the persistence
 * outbox and the log tree. Sharing them meant a shipped app that was already
 * running held the lock, so the development launch quit on arrival; a
 * development host that won the race instead put a second host-core over the
 * same single-writer database, which is the divergence D236 exists to
 * prevent. Neither is workable while someone debugs against the app they use.
 *
 * Only the development side moves, and only these two names differ. A shipped
 * installation keeps `PI-Desktop` and `~/.pi-desktop`, so no upgrade relocates
 * a user's database, secrets, plugins, or renderer-local state, and
 * `PI_DESKTOP_DATA_DIR` still overrides either profile outright.
 */

/** `userData` directory of a development installation, beside the shipped one. */
export const DEVELOPMENT_INSTALLATION_NAME = `${APP_NAME} Dev`;

/** Data directory of a shipped installation, below the user's home. */
export const INSTALLATION_DATA_DIR_NAME = ".pi-desktop";

/** Data directory of a development installation, below the user's home. */
export const DEVELOPMENT_DATA_DIR_NAME = ".pi-desktop-dev";

/**
 * The identity of a personal build, read from the packaged app's own
 * `package.json` (`piInstallation`, written by the pack command).
 *
 * Someone who builds PI-Desktop from modified source and installs it next to
 * the released app needs the two to stay apart for the same reasons a
 * development build does: a shared `userData` means a shared single-instance
 * lock, and a shared data directory means two host-cores over one database —
 * here with different schema versions. A personal build also must not update
 * itself, because the release feed would replace it with the published app
 * (`updates: false`). A released build names its own identity and leaves
 * updates on, so it follows its own feed (D704).
 */
export type InstallationProfile = {
  /** `userData` directory name; absent keeps the shipped one. */
  name?: string;
  /** Data directory name below the user's home; absent keeps the shipped one. */
  dataDirName?: string;
  /** False for a build that must never replace itself with a release. */
  updates: boolean;
};

export const SHIPPED_PROFILE: InstallationProfile = { updates: true };

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const PROFILE_DATA_DIR = /^\.[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Read `piInstallation` out of parsed package metadata. Each field is taken
 * only when it is well-formed — a directory name is a single dot-directory,
 * never a path — and anything else falls back to the shipped value, so a
 * malformed build can at worst behave like the released app.
 */
export function parseInstallationProfile(metadata: unknown): InstallationProfile {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).piInstallation
      : undefined;
  if (!raw || typeof raw !== "object") return SHIPPED_PROFILE;
  const { name, dataDirName, updates } = raw as Record<string, unknown>;
  return {
    ...(typeof name === "string" && PROFILE_NAME.test(name) ? { name } : {}),
    ...(typeof dataDirName === "string" && PROFILE_DATA_DIR.test(dataDirName)
      ? { dataDirName }
      : {}),
    // The pack command passes values on a command line, where `false` may
    // arrive as text.
    updates: !(updates === false || updates === "false"),
  };
}

export type DataDirInput = {
  /** `PI_DESKTOP_DATA_DIR`; an explicit directory wins over either profile. */
  override: string | undefined;
  /** True for a development build. */
  development: boolean;
  /** The user's home directory. */
  home: string;
  /** A personal build's own data directory name, when it has one. */
  dataDirName?: string;
};

/**
 * The data directory one installation owns.
 *
 * `PI_DESKTOP_DATA_DIR` stays the escape hatch it always was: an explicit
 * directory wins, which is how the E2E harnesses, the capture rig, and
 * side-by-side profiles keep choosing their own root. The result is absolute,
 * because it reaches host-core as a child-process environment variable from a
 * working directory that need not be this one, and because `homedir()` is the
 * only other input that could be relative. Without an override the profile
 * picks the name, and that name is the whole difference between the two
 * installations.
 */
export function resolveDataDir({
  override,
  development,
  home,
  dataDirName,
}: DataDirInput): string {
  const explicit = override?.trim();
  if (explicit) return resolve(explicit);
  return resolve(
    join(
      home,
      development
        ? DEVELOPMENT_DATA_DIR_NAME
        : (dataDirName ?? INSTALLATION_DATA_DIR_NAME),
    ),
  );
}

/**
 * The data directory this process owns.
 *
 * Electron main passes its own verdict for `development`, because only it can
 * ask `app.isPackaged`, and it publishes the resolved directory back to
 * `PI_DESKTOP_DATA_DIR` at boot. That publication is what keeps the plugin
 * runtime — which resolves this root from the environment rather than taking
 * it as a parameter — on one directory instead of falling back to the shipped
 * default, which would strand a development host's plugin data inside the
 * packaged profile.
 */
export function desktopDataDir(
  development: boolean = process.env.PI_DESKTOP_DEV === "1",
  dataDirName?: string,
): string {
  return resolveDataDir({
    override: process.env.PI_DESKTOP_DATA_DIR,
    development,
    home: homedir(),
    ...(dataDirName ? { dataDirName } : {}),
  });
}

/** The Electron `app` surface this helper needs; kept structural so tests need no Electron. */
export type UserDataApp = {
  commandLine: { hasSwitch(name: string): boolean };
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
};

/**
 * Give a development build its own `userData` so the single-instance lock
 * does not collide with a shipped app that is already running (D236, ADR 0094).
 * An explicit `--user-data-dir` wins, because that is how the E2E harnesses
 * point a build at a throwaway profile.
 */
export function applyDevelopmentUserData(
  app: UserDataApp,
  development: boolean,
): void {
  if (development && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath(
      "userData",
      join(app.getPath("appData"), DEVELOPMENT_INSTALLATION_NAME),
    );
  }
}

/**
 * Give a personal build its own `userData`, beside the released app's, for the
 * same reason a development build has one. An explicit `--user-data-dir`
 * still wins.
 */
export function applyProfileUserData(app: UserDataApp, name: string | undefined): void {
  if (name && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", join(app.getPath("appData"), name));
  }
}
