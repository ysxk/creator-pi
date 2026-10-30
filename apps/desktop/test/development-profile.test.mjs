import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModule } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  applyDevelopmentUserData,
  applyProfileUserData,
  DEVELOPMENT_DATA_DIR_NAME,
  DEVELOPMENT_INSTALLATION_NAME,
  INSTALLATION_DATA_DIR_NAME,
  parseInstallationProfile,
  resolveDataDir,
  SHIPPED_PROFILE,
} = await import("../electron/main/data-paths.ts");

const indexSource = await readMainModule("index.ts");
const installationSource = await readMainModule("installation.ts");
const entrySource = await readMainModule("entry.ts");

test("a development build owns a different data directory than the shipped app", () => {
  const home = join(tmpdir(), "pi-desktop-profile-home");

  assert.equal(
    resolveDataDir({ override: undefined, development: false, home }),
    join(home, INSTALLATION_DATA_DIR_NAME),
  );
  assert.equal(
    resolveDataDir({ override: undefined, development: true, home }),
    join(home, DEVELOPMENT_DATA_DIR_NAME),
  );

  // A shipped installation must keep the directory its users already have, so
  // the split can only have moved the development side.
  assert.equal(INSTALLATION_DATA_DIR_NAME, ".pi-desktop");
  assert.equal(DEVELOPMENT_DATA_DIR_NAME, ".pi-desktop-dev");
  assert.equal(DEVELOPMENT_INSTALLATION_NAME, "PI-Desktop Dev");
});

test("PI_DESKTOP_DATA_DIR still overrides either profile", () => {
  const home = join(tmpdir(), "pi-desktop-profile-home");
  const override = join(tmpdir(), "pi-desktop-explicit-profile");

  for (const development of [false, true]) {
    assert.equal(
      resolveDataDir({ override, development, home }),
      override,
    );
  }

  // Every call site this replaced treated a blank value as unset, which is what
  // keeps `PI_DESKTOP_DATA_DIR=` from naming a relative directory.
  assert.equal(
    resolveDataDir({ override: "   ", development: true, home }),
    join(home, DEVELOPMENT_DATA_DIR_NAME),
  );
});

test("an explicit data directory reaches the child processes as an absolute path", () => {
  // host-core and the plugin host read the value as an environment variable
  // from a different working directory, so a relative override would resolve to
  // two different trees.
  const relative = join("pi-desktop-relative-profile");
  assert.equal(
    resolveDataDir({
      override: relative,
      development: false,
      home: join(tmpdir(), "pi-desktop-profile-home"),
    }),
    resolve(relative),
  );
});

test("applyDevelopmentUserData sets userData unless --user-data-dir is set", () => {
  const calls = [];
  const app = {
    commandLine: { hasSwitch: () => false },
    getPath: () => "/tmp/appData",
    setPath: (name, path) => calls.push([name, path]),
  };
  applyDevelopmentUserData(app, true);
  assert.deepEqual(calls, [
    ["userData", join("/tmp/appData", DEVELOPMENT_INSTALLATION_NAME)],
  ]);
  calls.length = 0;
  applyDevelopmentUserData(app, false);
  assert.equal(calls.length, 0);
  applyDevelopmentUserData(
    { ...app, commandLine: { hasSwitch: (name) => name === "user-data-dir" } },
    true,
  );
  assert.equal(calls.length, 0);
});

test("a development build takes its own userData before the single-instance lock", async () => {
  // The lock lives under `userData`, so the profile has to be applied before
  // Electron asks for it; otherwise a running packaged app refuses the lock and
  // `pnpm dev` quits on arrival.
  const pathsSource = await readMainModule("data-paths.ts");
  const apply = installationSource.indexOf("applyDevelopmentUserData(app, isDevelopmentBuild)");
  const setName = installationSource.indexOf("app.setName(APP_NAME)");
  const lock = installationSource.indexOf("app.requestSingleInstanceLock()");

  assert.ok(apply > 0, "main must give the development build its own userData");
  assert.ok(lock > 0, "main must request the single-instance lock");
  assert.ok(setName > 0 && setName < apply);
  assert.ok(apply < lock);

  // An explicit `--user-data-dir` wins. The E2E harnesses point a build at a
  // throwaway profile with that switch, so overriding it would run their
  // assertions against the developer's own state instead.
  assert.match(
    pathsSource,
    /if \(development && !app\.commandLine\.hasSwitch\("user-data-dir"\)\) \{/,
  );
  assert.match(
    pathsSource,
    /app\.setPath\(\s*"userData",\s*join\(app\.getPath\("appData"\), DEVELOPMENT_INSTALLATION_NAME\)/,
  );

  // The two profiles are told apart by the same verdict everywhere, and it is
  // reached before the name the lock path derives from.
  const development = installationSource.search(
    /const isDevelopmentBuild =\s*\n?\s*process\.env\.PI_DESKTOP_DEV === "1" \|\| !app\.isPackaged;/,
  );
  assert.ok(development > 0 && development < apply);
});

test("main resolves one data directory and publishes it to everything below", () => {
  assert.match(
    installationSource,
    /const defaultDataDir = desktopDataDir\(isDevelopmentBuild, installationProfile\.dataDirName\);/,
  );
  assert.match(entrySource, /prepareStorage\(defaultDataDir, !singleInstanceRequired\)/);
  assert.match(indexSource, /const storage = getStorageBootstrap\(\);/);
  assert.match(indexSource, /const dataDir = storage\.preferences\.roots\.data;/);
  // The plugin runtime resolves this root from the environment rather than
  // taking it as a parameter, so the resolved value has to be the one it reads.
  assert.match(indexSource, /process\.env\.PI_DESKTOP_DATA_DIR = dataDir;/);
  assert.doesNotMatch(indexSource, /join\(homedir\(\), "\.pi-desktop"\)/);

  // Publishing happens after the lock verdict, which reads the same variable:
  // moving the write above `singleInstanceRequired` would make every launch
  // look like it had been given an explicit data directory and skip the lock.
  const lockVerdict = installationSource.indexOf(
    "const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;",
  );
  assert.ok(lockVerdict > 0);
  assert.doesNotMatch(installationSource, /process\.env\.PI_DESKTOP_DATA_DIR = dataDir;/);
  assert.match(entrySource, /from ["']\.\/installation["']/);
  assert.match(entrySource, /\.then\([\s\S]*?import\(["']\.\/index["']\)/);
});

test("downstream data directories follow the profile instead of the shipped default", async () => {
  const runtimeSource = await readMainModule("plugin-runtime.ts");
  assert.match(runtimeSource, /const root = desktopDataDir\(\);/);
  assert.doesNotMatch(runtimeSource, /join\(homedir\(\), "\.pi-desktop"\)/);

  // The plugin services already receive the resolved directory; the scratch
  // root was the one place that re-derived it.
  const servicesSource = await readMainModule("services/plugin-services.ts");
  assert.match(servicesSource, /return join\(dataDir, "scratch", sessionId\);/);
  assert.doesNotMatch(servicesSource, /join\(homedir\(\), "\.pi-desktop"\)/);
});

test("a personal build owns its own data directory, userData, and never self-updates", () => {
  const home = join(tmpdir(), "pi-desktop-profile-home");
  const profile = parseInstallationProfile({
    piInstallation: { name: "PI-Ultra", dataDirName: ".pi-ultra", updates: "false" },
  });
  assert.deepEqual(profile, { name: "PI-Ultra", dataDirName: ".pi-ultra", updates: false });

  // Beside the released app's directory, not inside or over it.
  assert.equal(
    resolveDataDir({ override: undefined, development: false, home, dataDirName: profile.dataDirName }),
    join(home, ".pi-ultra"),
  );
  // A development launch of the same source keeps the development directory,
  // and an explicit directory still wins over the profile.
  assert.equal(
    resolveDataDir({ override: undefined, development: true, home, dataDirName: profile.dataDirName }),
    join(home, DEVELOPMENT_DATA_DIR_NAME),
  );
  const override = join(tmpdir(), "pi-desktop-explicit-profile");
  assert.equal(
    resolveDataDir({ override, development: false, home, dataDirName: profile.dataDirName }),
    override,
  );

  const paths = [];
  const app = {
    commandLine: { hasSwitch: () => false },
    getPath: () => "/appdata",
    setPath: (name, path) => paths.push([name, path]),
  };
  applyProfileUserData(app, profile.name);
  assert.deepEqual(paths, [["userData", join("/appdata", "PI-Ultra")]]);
  // The released build, and an explicit profile directory, are left alone.
  applyProfileUserData(app, undefined);
  applyProfileUserData({ ...app, commandLine: { hasSwitch: () => true } }, "PI-Ultra");
  assert.equal(paths.length, 1);
});

test("malformed profile metadata can only fall back to the shipped identity", () => {
  assert.equal(parseInstallationProfile({}), SHIPPED_PROFILE);
  assert.equal(parseInstallationProfile(null), SHIPPED_PROFILE);
  assert.equal(parseInstallationProfile({ piInstallation: "PI-Ultra" }), SHIPPED_PROFILE);
  // A data directory is one dot-directory name, never a path.
  for (const dataDirName of ["../elsewhere", "/tmp/x", ".pi/ultra", "pi-ultra", ".", ""]) {
    assert.equal(
      parseInstallationProfile({ piInstallation: { dataDirName } }).dataDirName,
      undefined,
      dataDirName,
    );
  }
  for (const name of ["../x", "a/b", "", " leading"]) {
    assert.equal(parseInstallationProfile({ piInstallation: { name } }).name, undefined, name);
  }
  // Updates stay on unless the build says otherwise.
  assert.equal(parseInstallationProfile({ piInstallation: {} }).updates, true);
  assert.equal(parseInstallationProfile({ piInstallation: { updates: false } }).updates, false);
});

test("the installation reads its profile once and the updater follows it", () => {
  assert.match(installationSource, /const installationProfile = readInstallationProfile\(\);/);
  assert.match(
    installationSource,
    /export const updatesEnabled =\s*!isDevelopmentBuild && installationProfile\.updates && hasReleaseFeed\(process\.platform\);/,
  );
  assert.match(
    installationSource,
    /desktopDataDir\(isDevelopmentBuild, installationProfile\.dataDirName\)/,
  );
  assert.match(indexSource, /isPackaged: updatesEnabled,/);
});
