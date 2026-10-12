import { readAppSource, readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  english,
  chinese,
  brandLogo,
  icons,
  sidebar,
  app,
  chatSurface,
  composer,
  styles,
  rendererLanguage,
] = await Promise.all([
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../src/components/BrandLogo.tsx"),
    read("../src/components/icons.tsx"),
    read("../src/components/Sidebar.tsx"),
    readAppSource(),
    read("../src/components/ChatSurface.tsx"),
    readComposerSource(),
    loadStyles(),
    read("../src/lib/renderer-language.ts"),
  ]);

test("renderer surfaces the PI-Desktop brand instead of the Codex shell brand", () => {
  assert.match(english, /shellName:\s*"PI-Desktop"/);
  assert.match(chinese, /shellName:\s*"PI-Desktop"/);
  assert.match(english, /placeholder:\s*"Ask PI-Desktop to help with anything"/);
  assert.match(chinese, /placeholder:\s*"让 PI-Desktop 帮你做任何事"/);
  assert.doesNotMatch(english, /shellName:\s*"Codex"/);
  assert.doesNotMatch(chinese, /shellName:\s*"Codex"/);
  // Codex remains a supported external import source, not the app identity.
  assert.match(english, /importSourceCodex:\s*"Codex"/);
  assert.match(chinese, /importSourceCodex:\s*"Codex"/);
});

test("app chrome uses the shared brand asset without branding the composer input", async () => {
  // Renderer-sized brand marks, not the 1024px electron-builder installer icons.
  assert.match(brandLogo, /import brandLogoUrlLight from\s*"\.\.\/assets\/brand\/logo-light\.png"/);
  assert.match(brandLogo, /import brandLogoUrlDark from\s*"\.\.\/assets\/brand\/logo-dark\.png"/);
  assert.doesNotMatch(brandLogo, /\.\.\/\.\.\/build\//);
  assert.match(brandLogo, /export function BrandLogo/);
  assert.match(brandLogo, /src=\{.*brandLogoUrl/);
  assert.match(icons, /export const IconNewSession/);
  assert.doesNotMatch(icons, /IconCodexHome|IconCompose|IconPiMark|IconPiHome/);
  // The empty home carries no mascot or brand mark: the title stands alone.
  for (const asset of [
    "home-mascot-dark.gif",
    "home-mascot-light.gif",
    "home-mascot-still-dark.png",
    "home-mascot-still-light.png",
    "home-mascot-groups.png",
  ]) {
    await assert.rejects(() => access(new URL(`../src/assets/${asset}`, import.meta.url)));
  }
  await assert.rejects(() => access(new URL("../src/components/HomeMascotLogo.tsx", import.meta.url)));
  assert.doesNotMatch(chatSurface, /HomeMascotLogo|empty-hero-icon|home-icon/);
  assert.doesNotMatch(chatSurface, /<BrandLogo/);
  assert.doesNotMatch(styles, /home-mascot|empty-hero-icon/);
  assert.match(
    rendererLanguage,
    /if \(request === languageRequest\)\s*document\.documentElement\.lang = target/,
  );
  assert.doesNotMatch(styles, /background-size:\s*5000px 100px|image-rendering:\s*pixelated/);
  assert.doesNotMatch(composer, /<BrandLogo/);
  assert.doesNotMatch(composer, /composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-input-wrap\s*\{[^}]*\bgap:/s);
  assert.doesNotMatch(composer, /infinity-mark|∞/);
  assert.match(sidebar, /<BrandLogo\s+size=\{20\}/);
  assert.match(sidebar, /IconNewSession/);
  assert.match(app, /<IconNewSession\s+size=\{15\}/);
  assert.doesNotMatch(sidebar, /IconCompose|IconPiMark|IconPiHome/);
});
