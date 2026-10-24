import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadStylesSync } from "./helpers/styles.mjs";

/**
 * Surfaces that leave, folds that move, and feedback with a feel (D694,
 * design-system §8). Behaviour is checked in the running app and by the
 * transcript E2E; these contracts keep the pieces wired the way that check
 * relied on.
 */

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const styles = loadStylesSync();
const globals = read("styles/globals.css");
const surfaceMotion = read("styles/surface-motion.css");
const motionCss = read("styles/motion.css");
const messages = read("styles/messages.css");
const tokens = read("styles/tokens.css");

function rule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  return source.slice(start, source.indexOf("}", start) + 1);
}

function keyframes(name) {
  const start = motionCss.indexOf(`@keyframes ${name} {`);
  assert.ok(start >= 0, `missing @keyframes ${name}`);
  return motionCss.slice(start, motionCss.indexOf("\n}\n", start));
}

test("anchored and context menus stay mounted, inert, through their exit", () => {
  for (const path of ["components/settings/AnchoredMenu.tsx", "components/ContextMenu.tsx"]) {
    const source = read(path);
    assert.match(source, /usePresence\(/, `${path} holds its surface for the exit`);
    assert.match(source, /data-surface-motion=""/);
    assert.match(source, /data-surface-state=\{presence\.closing \? "closing" : "open"\}/);
    assert.match(source, /inert=\{presence\.closing\}/);
    assert.match(source, /surfaceOrigin\(/, `${path} grows from what opened it`);
  }
  const hook = read("hooks/use-presence.ts");
  // The hold starts in the render that closes, so no frame drops the surface.
  assert.match(hook, /if \(open !== seenOpen\) \{\s*setSeenOpen\(open\);\s*setLingering\(!open\);/);
  assert.match(hook, /prefersReducedMotion\(\) \? 0 : exitMs/);
});

test("shared surface motion out-ranks each menu's own entrance", () => {
  const order = [...globals.matchAll(/@import "\.\/([a-z-]+)\.css";/g)].map((m) => m[1]);
  assert.equal(order.at(-2), "surface-motion", "surface-motion.css comes after every feature sheet");
  assert.equal(order.at(-1), "responsive");
  assert.match(
    rule(surfaceMotion, ".is-open[data-surface-motion]"),
    /animation: ds-surface-grow var\(--motion-duration-snap\) var\(--motion-ease-snap\)/,
  );
  assert.match(
    rule(surfaceMotion, '.is-open[data-surface-motion][data-surface-state="closing"]'),
    /pointer-events: none;[\s\S]*animation: ds-surface-leave var\(--motion-duration-exit\) var\(--motion-ease-in\) both/,
  );
  assert.match(
    surfaceMotion,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.is-open\[data-surface-motion\],\s*\.is-open\[data-surface-motion\]\[data-surface-state="closing"\],\s*\.sidebar-floating-menu \{\s*animation: none;/,
  );
});

test("a departing dialog plays out as an inert copy the host owns", () => {
  const ui = read("components/ui.tsx");
  assert.match(ui, /document\.documentElement\.appendChild\(root\);[\s\S]*?installOverlayExit\(root\);/);
  const exit = read("lib/overlay-exit.ts");
  assert.match(exit, /copy\.dataset\.exitGhost = "";/);
  assert.match(exit, /copy\.inert = true;/);
  // The copy answers to nothing a lookup would use.
  assert.match(exit, /const IDENTITY = \/\^\(id\|for\|name\|role\|title\|tabindex\|autofocus\|data-testid\|aria-\.\+\)\$\/;/);
  assert.match(exit, /if \(IDENTITY\.test\(name\)\) element\.removeAttribute\(name\);/);
  // A dialog that opens clears any copy still leaving; no copy under reduced
  // motion or for content that would load or run again.
  assert.match(exit, /addedNodes\]\.some\(isLiveOverlay\)\)\) \{\s*clearCopies\(\);\s*return;/);
  // Both portal hosts are watched: the overlay host and document.body.
  assert.match(read("lib/portal-visibility.tsx"), /installOverlayExit\(document\.body\);/);
  assert.match(exit, /if \(prefersReducedMotion\(\) \|\| document\.visibilityState === "hidden"\) return;/);
  assert.match(exit, /const UNCOPYABLE = "iframe, webview, video, audio, canvas, object, embed";/);
  assert.match(
    rule(surfaceMotion, "#pi-desktop-overlays > .overlay[data-exit-ghost],\nbody > .overlay[data-exit-ghost]"),
    /pointer-events: none;/,
  );
  assert.match(rule(styles, ".dialog"), /animation: ds-dialog-rise var\(--motion-duration-snap\) var\(--motion-ease-snap\) both/);
});

test("folds animate their row and still drop out of layout when closed", () => {
  for (const [path, inner] of [
    ["features/chat/transcript/TurnProcess.tsx", "turn-process-fold"],
    ["features/chat/transcript/ProcessActivityGroup.tsx", "process-activity-fold"],
  ]) {
    const source = read(path);
    assert.match(source, /hidden=\{!(disclosure\.)?open\}/, `${path} keeps hidden for a closed body`);
    assert.match(source, new RegExp(`className="${inner}"`), `${path} wraps its body in one row item`);
    // Only the reader's own open of a closed fold animates it.
    assert.match(source, /if \(!(disclosure\.)?open\) fold\.markOpening\(\);/);
    assert.match(source, /data-fold-opening=\{fold\.opening \? "" : undefined\}/);
  }
  assert.match(
    messages,
    /\.turn-process-body\[hidden\],\s*\.process-activity-body\[hidden\] \{\s*display: none;\s*grid-template-rows: 0fr;[\s\S]*?display var\(--motion-duration-normal\) allow-discrete;/,
  );
  assert.match(
    messages,
    /@starting-style \{\s*\[data-fold-opening\] > \.turn-process-body:not\(\[hidden\]\),\s*\[data-fold-opening\] > \.process-activity-body:not\(\[hidden\]\) \{\s*grid-template-rows: 0fr;/,
  );
  // Clip without becoming a scroll container.
  assert.match(rule(messages, ".turn-process-fold,\n.process-activity-fold"), /overflow-y: clip;/);
  assert.doesNotMatch(rule(messages, ".turn-process-fold,\n.process-activity-fold"), /overflow(-y)?: hidden/);
});

test("a running label's sheen moves by transform only and pauses with the window", () => {
  for (const name of ["ds-sheen-window", "ds-sheen-text"]) {
    const declared = [...keyframes(name).matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(declared)], ["transform"], `${name} animates transform only (#1064)`);
  }
  for (const selector of [".tool-activity-sheen", ".tool-activity-sheen > span"]) {
    const block = rule(messages, selector);
    assert.match(block, /animation: ds-sheen-(window|text) var\(--motion-sheen-duration\) linear infinite;/);
    assert.match(block, /animation-play-state: var\(--motion-play\);/);
  }
  assert.match(messages, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-activity-sheen \{\s*display: none;/);
  assert.match(rule(messages, ".tool-activity-label"), /font-variant-numeric: tabular-nums;/);
  const label = read("features/chat/transcript/ActivityLabel.tsx");
  assert.match(label, /<span className="tool-activity-sheen" aria-hidden>/);
});

test("the composer's focus is its own: no theme rule out-ranks it", () => {
  const overrides = read("styles/theme-overrides.css") + read("styles/composer-menus.css");
  for (const theme of ["light", "dark"]) {
    const block = rule(overrides, `:root[data-theme="${theme}"] .composer-shell`);
    assert.doesNotMatch(block, /box-shadow/, `${theme} must not override the composer's shadow`);
  }
  assert.match(
    rule(read("styles/composer.css"), ".composer-shell:focus-within"),
    /0 0 0 1px var\(--ds-composer-focus-ring\),\s*0 0 0 4px var\(--ds-composer-focus-halo\),\s*var\(--ds-shadow-composer-focus\)/,
  );
  // Rest and focus lists line up layer by layer in both themes, so focus
  // interpolates instead of jumping.
  for (const [theme, block] of [
    ["dark", tokens.slice(0, tokens.indexOf(':root[data-theme="light"] {'))],
    ["light", tokens.slice(tokens.indexOf(':root[data-theme="light"] {'))],
  ]) {
    const layers = (name) => {
      const value = block.match(new RegExp(`${name}:([^;]+);`))?.[1];
      assert.ok(value, `${theme} declares ${name}`);
      return value.split(/,\s*(?![^()]*\))/).map((layer) => layer.trim().startsWith("inset"));
    };
    assert.deepEqual(layers("--ds-shadow-composer"), layers("--ds-shadow-composer-focus"), theme);
  }
});

test("send, stop and copy feedback use the pop spring, and only there", () => {
  const composer = read("styles/composer.css");
  assert.match(rule(composer, ".send-btn:not(:disabled)"), /animation: ds-ready-pop var\(--motion-duration-pop\) var\(--motion-ease-pop\);/);
  assert.match(rule(composer, ".send-btn:active:not(:disabled),\n.stop-btn:active:not(:disabled)"), /transition-duration: 90ms;/);
  assert.match(messages, /\.copied > svg \{\s*color: var\(--ds-success\);\s*animation: ds-glyph-pop var\(--motion-duration-pop\) var\(--motion-ease-pop\);/);
  assert.match(messages, /\.copy-returning > svg \{\s*animation: ds-glyph-return var\(--motion-duration-glide\) var\(--motion-ease-glide\);/);
  // Structure never bounces: folds, menus and dialogs stay on snap or exit.
  for (const source of [surfaceMotion, rule(messages, ".turn-process-body,\n.process-activity-body")]) {
    assert.doesNotMatch(source, /--motion-ease-pop/);
  }
});
