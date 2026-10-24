import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

/*
 * D702: app chrome draws MingCute glyphs generated from the pinned
 * @iconify-json/mingcute package; conversation code chrome keeps Lucide.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const require = createRequire(import.meta.url);

function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const glyphs = loadModule("../src/components/mingcute-icons.generated.ts", {});
const icons = loadModule("../src/components/icons.tsx", {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "lucide-react": require("lucide-react"),
  "./mingcute-icons.generated": glyphs,
});
const iconsSource = read("../src/components/icons.tsx");
const render = (Icon, props = {}) => renderToStaticMarkup(React.createElement(Icon, props));

test("the generated glyph file matches the pinned package and icons.tsx", () => {
  execFileSync(process.execPath, ["../../scripts/generate-mingcute-icons.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
  for (const [, base] of iconsSource.matchAll(/mingcute\("([a-z0-9-]+)"/g)) {
    assert.ok(glyphs.MINGCUTE_GLYPHS[`${base}-line`], `${base}-line`);
    assert.ok(glyphs.MINGCUTE_GLYPHS[`${base}-fill`], `${base}-fill`);
  }
});

test("chrome icons come from MingCute; Lucide is left only for conversation code chrome", () => {
  assert.match(iconsSource, /import \{ Code2, Workflow, type LucideIcon, type LucideProps \} from "lucide-react";/);
  assert.doesNotMatch(iconsSource, /export const Icon\w+ = icon\(/);
  assert.match(iconsSource, /export const IconCodeBlock = lucide\(Code2\);/);
  assert.match(iconsSource, /export const IconDiagram = lucide\(Workflow\);/);
  // The four meaning-level swaps the user accepted.
  assert.match(iconsSource, /export const IconPlug = mingcute\("plugin-2"\);/);
  assert.match(iconsSource, /export const IconBranch = mingcute\("git-branch"\);/);
  assert.match(iconsSource, /export const IconNewSession = mingcute\("edit-3"\);/);
  assert.match(iconsSource, /export const IconChat = mingcute\("chat-3"\);/);
  // Conversation content keeps its Lucide code glyphs.
  const markdown = read("../src/components/Markdown.tsx");
  assert.match(markdown, /<IconDiagram size=\{13\} aria-hidden \/>/);
  assert.match(markdown, /<IconCodeBlock size=\{13\} \/>/);
  assert.doesNotMatch(markdown, /<IconWorkflow|<IconCode /);
  assert.match(read("../src/features/chat/transcript/shared.tsx"), /return IconCodeBlock;/);
});

test("a line icon keeps its stroke on the <svg> so callers and CSS can still thin it", () => {
  const markup = render(icons.IconCheck, { size: 14 });
  assert.match(markup, /^<svg [^>]*viewBox="0 0 24 24"/);
  assert.match(markup, /^<svg [^>]*stroke-width="2"/);
  assert.match(markup, /^<svg [^>]*aria-hidden="true"/);
  assert.match(markup, /width:calc\(14px \* var\(--font-scale\)\)/);
  assert.doesNotMatch(markup, /<path[^>]*stroke-width/);
  assert.match(render(icons.IconClose, { strokeWidth: 1.5 }), /^<svg [^>]*stroke-width="1.5"/);
  // A labelled icon is not hidden from assistive technology.
  assert.doesNotMatch(render(icons.IconCheck, { "aria-label": "Done" }), /aria-hidden/);
});

test("filled draws the solid variant of the same glyph", () => {
  const line = render(icons.IconFolder);
  const solid = render(icons.IconFolder, { filled: true });
  assert.notEqual(line, solid);
  assert.match(solid, /fill="currentColor"/);
  assert.doesNotMatch(solid, /^<svg [^>]*stroke-width/);
  // Stop and the status dot are solid by default.
  assert.match(render(icons.IconStop), /fill="currentColor"/);
});

test("selected destinations and solid glyphs use filled, not Lucide's fill prop", () => {
  const settings = read("../src/features/settings/SettingsPage.tsx");
  assert.match(settings, /<item\.icon size=\{14\} filled=\{tab === item\.id\} \/>/);
  assert.match(settings, /<ExtensionIcon size=\{14\} filled=\{activeExtension\?\.ref === entry\.ref\} \/>/);
  const sidebar = read("../src/components/Sidebar.tsx");
  assert.match(sidebar, /<IconFolder size=\{13\} filled=\{entry\.active\} aria-hidden \/>/);
  for (const file of [
    "../src/components/Sidebar.tsx",
    "../src/components/AudioPlayer.tsx",
    "../src/components/ProjectCreateDialog.tsx",
    "../src/components/ProjectEditDialog.tsx",
    "../src/features/projects/ProjectArchiveIndex.tsx",
  ]) {
    assert.doesNotMatch(read(file), /<Icon\w+[^>]*\sfill="currentColor"/, file);
  }
});
