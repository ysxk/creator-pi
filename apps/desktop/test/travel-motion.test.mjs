import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { claimArrival } from "../src/lib/message-arrival.ts";

/**
 * Selection, hover and arrival that travel; dark polish (D696). The motion
 * itself is checked in the running app; these contracts keep it wired and
 * keep history from ever animating.
 */

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

function rule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  return source.slice(start, source.indexOf("}", start) + 1);
}

test("only a message sent a moment ago rises, and a row replacing it resumes the rise", () => {
  const sent = Date.parse("2026-10-23T08:00:00.000Z");
  assert.equal(claimArrival({ role: "user", createdAt: "2026-10-23T07:59:59.990Z" }, sent), 0);
  // A native session swaps in the persisted row: a new id and the SDK's own
  // timestamp. It picks the rise up where it is instead of rising twice.
  assert.equal(claimArrival({ role: "user", createdAt: "2026-10-23T08:00:00.080Z" }, sent + 120), 120);
  assert.equal(claimArrival({ role: "user", createdAt: "2026-10-23T07:58:00.000Z" }, sent + 130), null);
  assert.equal(claimArrival({ role: "assistant", createdAt: "2026-10-23T08:00:00.100Z" }, sent + 130), null);
  assert.equal(claimArrival({ role: "user" }, sent + 130), null);
  assert.equal(claimArrival({ role: "user", createdAt: "2026-10-23T08:00:05.000Z" }, sent + 130), null, "clock skew");
  // The next send is a new arrival and rises from the start.
  assert.equal(claimArrival({ role: "user", createdAt: "2026-10-23T08:00:04.995Z" }, sent + 5000), 0);

  const row = read("features/chat/transcript/MessageRow.tsx");
  assert.match(row, /const \[arrival\] = useState\(\(\) => \(isUser && !isSessionMessage \? claimArrival\(message\) : null\)\);/);
  assert.match(row, /\$\{arrival !== null \? " just-sent" : ""\}/);
  assert.match(row, /style=\{arrival \? \(\{ "--arrival-elapsed": `\$\{-arrival\}ms` \} as CSSProperties\) : undefined\}/);
  // The transcript's tail slot is unkeyed; a message row must still be its own.
  assert.match(
    read("features/chat/transcript/AssistantTurn.tsx"),
    /return <MessageRow key=\{entry\.message\.id\} message=\{entry\.message\} isRunning=\{isRunning\} \/>;/,
  );
  assert.match(
    rule(read("styles/chat-shell.css"), ".message-row.user.just-sent .message-bubble"),
    /animation: ds-message-rise var\(--motion-duration-glide\) var\(--motion-ease-glide\)\s+var\(--arrival-elapsed, 0ms\) backwards;/,
  );
});

test("sidebar selection and hover glide under the rows and hand back to them", () => {
  const sidebar = read("components/Sidebar.tsx");
  assert.match(sidebar, /const glide = useSidebarGlide\(page === "chat" \? selectedSessionId \?\? null : null\);/);
  assert.match(sidebar, /<div className="sidebar-body no-drag" ref=\{glide\.rootRef\}>/);
  assert.match(sidebar, /<span ref=\{glide\.pillRef\} className="sidebar-selection-glide" aria-hidden \/>/);
  const hook = read("hooks/use-sidebar-glide.ts");
  // No glide toward a row its list has scrolled away, and none under reduced motion.
  assert.match(hook, /if \(!from \|\| !to \|\| !onScreen\(root, from\) \|\| !onScreen\(root, to\)\) return;/);
  assert.match(hook, /if \(prefersReducedMotion\(\)\) return;/);
  assert.match(hook, /root\.addEventListener\("scroll", hide, true\);/);
  // A click selects the row under a resting pointer; its hover tile steps away.
  assert.match(hook, /previous\.current = selectedId;[\s\S]{0,200}hideHover\.current\(\);/);
  assert.match(hook, /hideHover\.current = hide;/);
  const css = read("styles/sidebar-threads.css");
  assert.match(rule(css, ".sidebar-body"), /position: relative;\s*isolation: isolate;/);
  assert.match(css, /\.sidebar-selection-glide,\s*\.sidebar-hover-glide \{\s*position: absolute;\s*z-index: -1;/);
  // Handing back, a layer fades out on the curve the row's background fades in on.
  assert.match(rule(css, ".thread-item,\n.sidebar-session-group-header"), /transition: background var\(--motion-duration-fast\) var\(--motion-ease-out\)/);
  assert.match(
    rule(css, ".sidebar-selection-glide,\n.sidebar-hover-glide"),
    /opacity var\(--motion-duration-fast\) var\(--motion-ease-out\);/,
  );
  assert.match(
    css,
    /\.sidebar-body\[data-selection-gliding\] \.thread-item\.active,\s*\.sidebar-body\[data-hover-gliding\] \.thread-item:hover:not\(\.active\):not\(\.selected\) \{\s*background: transparent;/,
  );
});

test("menus glide their hover and the sidebar's menus leave like dialogs", () => {
  const glide = read("lib/hover-glide.ts");
  assert.match(glide, /const SURFACE = "\[data-surface-motion\], \.sidebar-floating-menu";/);
  assert.match(glide, /if \(item\.matches\(OWN_LOOK\)\) \{\s*hide\(\);/);
  assert.match(read("lib/portal-visibility.tsx"), /installOverlayExit\(document\.body\);\s*installHoverGlide\(\);/);
  assert.match(read("components/settings/AnchoredMenu.tsx"), /if \(presence\.present\) installHoverGlide\(\);/);
  assert.match(read("lib/overlay-exit.ts"), /const LEAVING = "\.overlay, \.sidebar-floating-menu";/);
  const surfaces = read("styles/surface-motion.css");
  assert.match(rule(surfaces, ".surface-hover-glide"), /z-index: -1;/);
  // Only a menu's own items step aside for its tile; the sidebar has its own rule.
  assert.match(surfaces, /:is\(\[data-surface-motion\], \.sidebar-floating-menu\)\[data-hover-gliding\]\n\s+:is\(\[role="menuitem"\]/);
  assert.match(rule(surfaces, "body > .sidebar-floating-menu[data-exit-ghost]"), /animation: ds-surface-leave/);
  assert.match(surfaces, /\.sidebar-floating-menu \{\s*transform-origin: left top;\s*animation: ds-surface-grow/);
});

test("dark is near-black and its heavier weights stay on their PingFang face", () => {
  const tokens = read("styles/tokens.css");
  assert.match(tokens, /--ds-bg-under: #111111;/);
  assert.doesNotMatch(tokens, /--ds-bg-under: #000000;/);
  const dark = tokens.slice(tokens.indexOf("/*\n  Dark weight compensation"), tokens.indexOf(':root[data-theme="light"] {'));
  const weights = Object.fromEntries([...dark.matchAll(/--font-weight-([a-z-]+): (\d+);/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(weights, { medium: 460, "medium-plus": 505, strong: 530, semibold: 560 });
  // CSS font matching: 401–500 resolves up to Medium, above 500 up to Semibold;
  // the light values sit in the same bands, so Chinese text keeps its face.
  assert.ok(weights.medium > 400 && weights.medium <= 500);
  for (const name of ["medium-plus", "strong", "semibold"]) assert.ok(weights[name] > 500 && weights[name] <= 600);
});
