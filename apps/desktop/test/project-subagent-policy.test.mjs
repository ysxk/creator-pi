import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [card, page, hook, launch, headlessLaunch, popup, styles] = await Promise.all([
  read("../src/components/settings/ProjectSubagentPolicyCard.tsx"),
  read("../src/components/settings/AgentSubagentsPage.tsx"),
  read("../src/hooks/use-composer-autocomplete.ts"),
  read("../electron/main/runtime/session-launch.ts"),
  read("../../../packages/host-runtime/src/launch-resolver.ts"),
  read("../src/components/ComposerAutocomplete.tsx"),
  read("../src/styles/composer-autocomplete.css"),
]);

test("the subagents page carries both project switches", () => {
  assert.match(page, /<ProjectSubagentPolicyCard \/>/);
  assert.match(card, /globalSubagentsInProjects: !policy\.available/);
  assert.match(card, /showGlobalSubagentsInProjects: !policy\.listed/);
  // The display switch does nothing once delegation is off, so it locks.
  assert.match(card, /disabled=\{!policy\.available\}/);
});

test("both launch paths keep a project session to its own documents when asked", () => {
  for (const source of [launch, headlessLaunch]) {
    assert.match(
      source,
      /projectOnly: projectPath \? !\(await globalSubagentsAvailableInProjects\(\)\) : false/,
    );
    // A failed settings read keeps the delegates rather than dropping them.
    assert.match(source, /globalSubagentsInProjectPolicy\(settings\)\.available;[\s\S]*?return true;/);
  }
});

test("the @ panel lists only project documents when global ones are hidden on a project", () => {
  assert.match(hook, /globalSubagentsInProjectPolicy\(s\.settings\)\.listed/);
  assert.match(
    hook,
    /subagents && hasWorkspace && !listGlobalSubagents\s*\? subagents\.filter\(\(agent\) => agent\.source === "project"\)/,
  );
});

test("the portraits stand on the transcript and only the list is a card", () => {
  const panel = styles.match(/\.composer-autocomplete\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(panel, /background:|box-shadow:|border:/);
  const cardRule = styles.match(/\.composer-ac-card\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(cardRule, /background:\s*var\(--ds-bg-elevated-opaque\)/);
  assert.match(cardRule, /box-shadow:\s*var\(--ds-shadow-dialog\)/);
  assert.match(popup, /<div className="composer-ac-card">[\s\S]*composer-ac-list[\s\S]*composer-ac-footer/);
  // The empty space between portraits lets clicks through to the transcript.
  assert.doesNotMatch(
    styles.match(/\.composer-autocomplete\.is-open\s*\{[^}]*\}/)?.[0] ?? "",
    /pointer-events:\s*auto/,
  );
});
