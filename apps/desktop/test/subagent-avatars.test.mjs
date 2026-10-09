import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  protocol,
  apiSource,
  skillsIpc,
  autocomplete,
  autocompleteView,
  avatarComponent,
  editorSheet,
  settingsPage,
  toolRow,
  iconService,
] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  read("../electron/main/ipc/skills-ipc.ts"),
  read("../src/hooks/use-composer-autocomplete.ts"),
  read("../src/components/ComposerAutocomplete.tsx"),
  read("../src/components/SubagentAvatar.tsx"),
  read("../src/components/settings/SubagentEditorSheet.tsx"),
  read("../src/components/settings/AgentSubagentsPage.tsx"),
  read("../src/features/chat/transcript/ToolRow.tsx"),
  read("../electron/main/services/subagent-icon-service.ts"),
]);

test("subagent avatar PNGs cross a dedicated IPC surface", () => {
  assert.match(protocol, /subagentIcon: "pi-desktop\/subagent\/icon"/);
  assert.match(protocol, /subagentGenerateIcon: "pi-desktop\/subagent\/generateIcon"/);
  assert.match(protocol, /subagentDeleteIcon: "pi-desktop\/subagent\/deleteIcon"/);
  assert.match(apiSource, /subagentIcon: \(name: string\)/);
  assert.match(apiSource, /subagentGenerateIcon: \(input: \{ name: string/);
  assert.match(skillsIpc, /readSubagentIcon\(dataDir, name\)/);
  assert.match(skillsIpc, /generateSubagentIcon\(\{/);
});

test("generated icons stay bounded, name-scoped, and overwrite in place", () => {
  assert.match(iconService, /SAFE_NAME = \/.*\//);
  assert.match(iconService, /MAX_ICON_BYTES/);
  assert.match(iconService, /"subagent-icons", `\$\{name\}\.png`/);
  // The default SVG needs no configuration; generation reuses the exact
  // endpoint resolution the GenerateImages tool uses.
  assert.match(iconService, /resolveImageGenerationEndpoint/);
  // And it must forward the tool's OAuth + native image-model resolvers:
  // a signed-in vendor account is the only credential an OAuth image
  // provider has, and without them every generation fails auth.
  assert.match(iconService, /resolveAuth: options\.resolveAuth/);
  assert.match(iconService, /resolveImageModel: options\.resolveImageModel/);
  assert.match(skillsIpc, /resolveAuth: resolveAuth as never/);
  assert.match(skillsIpc, /resolveImageModel: resolveImageModel as never/);
});

test("the avatar component prefers the PNG and falls back to the deterministic SVG", () => {
  assert.match(avatarComponent, /subagentAvatarDataUrl\(name\)/);
  assert.match(avatarComponent, /api\s*\n?\s*\.subagentIcon\(name\)/);
  assert.match(avatarComponent, /pngCache/);
});

test("the @ menu offers subagents above the file index", () => {
  assert.match(autocomplete, /kind: "subagent"; agent: SubagentDefinition/);
  assert.match(autocomplete, /filterSubagents\(subagents, trigger\.query\)/);
  // Delegation mention inserts plain @name text the model's Task catalog knows.
  assert.match(
    autocomplete,
    /applyCompletion\(value, trigger, formatFileInsert\(item\.agent\.name, "file"\)\)/,
  );
  assert.match(autocompleteView, /chat\.atGroupAgents/);
  assert.match(autocompleteView, /<SubagentAvatar name=\{item\.agent\.name\}/);
});

test("every subagent surface shows the identity mark", () => {
  assert.match(settingsPage, /<SubagentAvatar name=\{handle\}/);
  assert.match(settingsPage, /<SubagentAvatar name=\{subagent\.name\}/);
  assert.match(toolRow, /subagent-topology-avatar[\s\S]*?<SubagentAvatar/);
  assert.match(editorSheet, /<AvatarField name=\{slug\} description=\{draft\.description\} \/>/);
  assert.match(editorSheet, /subagentGenerateIcon/);
  assert.match(editorSheet, /subagentDeleteIcon/);
});
