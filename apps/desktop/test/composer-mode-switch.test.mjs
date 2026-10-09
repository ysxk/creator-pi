import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const switchSource = await read("../src/features/chat/composer/ComposerModeSwitch.tsx");
const hookSource = await read("../src/hooks/use-hover-menu.ts");
const toolbarSource = await read("../src/features/chat/composer/ComposerToolbar.tsx");
const styles = await loadStyles();

test("the mode chip keeps its click-to-cycle behaviour and its selectors", () => {
  // E2E and the plan-mode journeys find the chip by this exact class list.
  assert.match(switchSource, /className="icon-btn mode-chip composer-mode-chip"/);
  assert.match(switchSource, /data-mode=\{mode\}/);
  assert.match(switchSource, /void onSelect\(nextMode\(mode\)\);/);
  // The options are not chips, so `.composer-shell button.mode-chip` still
  // counts exactly the controls it counted before.
  assert.doesNotMatch(switchSource, /className=\{?`?composer-mode-option[^"`]*mode-chip/);
  assert.match(toolbarSource, /<ComposerModeSwitch/);
});

test("the options open on hover without a delay and never take the caret", () => {
  // No show timer: the menu is there by the time the pointer stops.
  assert.doesNotMatch(hookSource, /setTimeout\([^)]*\bsetOpen\(true\)/);
  assert.match(hookSource, /if \(disabled \|\| event\.pointerType !== "mouse" \|\| event\.buttons !== 0\) return;/);
  assert.match(hookSource, /const LEAVE_GRACE_MS = 140;/);
  // Hovering must not move focus out of the editor, and closing must not
  // throw it at the chip either.
  assert.match(switchSource, /initialFocus="none"/);
  assert.match(switchSource, /restoreFocus=\{false\}/);
  assert.match(switchSource, /\{\.\.\.hover\.anchorProps\}/);
  assert.match(switchSource, /\{\.\.\.hover\.menuProps\}/);
});

test("every mode is an option with a description, reachable from the keyboard", () => {
  assert.match(switchSource, /MODE_CYCLE\.map\(\(candidate\) =>/);
  assert.match(switchSource, /role="menuitemradio"/);
  assert.match(switchSource, /aria-checked=\{candidate === mode\}/);
  for (const key of ["chat.modeAgentDesc", "chat.modePlanDesc", "chat.modeGoalDesc"]) {
    assert.ok(switchSource.includes(`"${key}"`), key);
  }
  assert.match(switchSource, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/);
  assert.match(switchSource, /hover\.openNow\(\);/);
});

test("the menu is a fixed surface that fades in from the chip", () => {
  const menu = styles.match(/\.composer-mode-menu\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(menu, /position:\s*fixed/);
  assert.match(menu, /visibility:\s*hidden/);
  assert.match(
    styles,
    /\.composer-mode-menu\.is-open\s*\{[^}]*animation:\s*composer-menu-in var\(--motion-duration-fast\)[^}]*transform-origin:\s*bottom left/,
  );
});
