import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { MODEL_LIST_VISIBLE_ROWS, RECENT_MODEL_ROWS, modelMenuSections } = await import(
  "../src/features/chat/composer/model-menu-sections.ts"
);

const group = (id, name, modelIds) => ({
  provider: { id, name, models: modelIds.map((modelId) => ({ id: modelId })) },
  providerDisplayName: name,
  providerSearchText: name.toLowerCase(),
  models: modelIds.map((modelId) => ({ modelId, displayName: modelId, providerId: id })),
});
const groups = [
  group("relay", "Relay", ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]),
  group("lab", "Lab", ["eta", "theta", "iota", "kappa"]),
];
const ids = (entries) => entries.map((entry) => `${entry.provider.id}/${entry.model.modelId}`);
const grouped = (sections) =>
  Object.fromEntries(sections.groups.map((item) => [item.provider.id, item.models.map((model) => model.modelId)]));

test("every model is listed: the recent ones lead and none is folded away", () => {
  const recent = [
    { providerId: "lab", modelId: "theta" },
    { providerId: "relay", modelId: "GAMMA" },
    { providerId: "gone", modelId: "removed" },
    { providerId: "relay", modelId: "alpha" },
    { providerId: "lab", modelId: "eta" },
  ];
  const sections = modelMenuSections(groups, recent, "");

  assert.equal(RECENT_MODEL_ROWS, 3);
  // Newest first, skipping a model that is no longer configured, three at most.
  assert.deepEqual(ids(sections.recentEntries), ["lab/theta", "relay/gamma", "relay/alpha"]);
  // The rest is all there, by provider, without repeating a recent row.
  assert.deepEqual(grouped(sections), {
    relay: ["beta", "delta", "epsilon", "zeta"],
    lab: ["eta", "iota", "kappa"],
  });
  assert.equal(sections.flatModels.length, 10, "ten configured models, ten rows");
  assert.deepEqual(ids(sections.flatModels), [
    "lab/theta", "relay/gamma", "relay/alpha",
    "relay/beta", "relay/delta", "relay/epsilon", "relay/zeta",
    "lab/eta", "lab/iota", "lab/kappa",
  ]);
});

test("with no history the providers' own lists are the whole menu", () => {
  for (const recent of [[], null, undefined]) {
    const sections = modelMenuSections(groups, recent, "  ");
    assert.deepEqual(sections.recentEntries, []);
    assert.deepEqual(grouped(sections), {
      relay: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      lab: ["eta", "theta", "iota", "kappa"],
    });
  }
});

test("a search filters every configured model and drops the recent section", () => {
  const sections = modelMenuSections(groups, [{ providerId: "relay", modelId: "alpha" }], " TA ");
  assert.deepEqual(sections.recentEntries, []);
  assert.deepEqual(grouped(sections), {
    relay: ["beta", "delta", "zeta"],
    lab: ["eta", "theta", "iota"],
  });
  assert.deepEqual(ids(sections.flatModels), [
    "relay/beta", "relay/delta", "relay/zeta", "lab/eta", "lab/theta", "lab/iota",
  ]);
  assert.deepEqual(modelMenuSections(groups, [], "no such model").flatModels, []);
});

test("the list shows seven rows and scrolls for the rest", async () => {
  assert.equal(MODEL_LIST_VISIBLE_ROWS, 7);
  const css = await readFile(new URL("../src/styles/composer-menus.css", import.meta.url), "utf8");
  const rule = css.match(/\n\.composer-model-list \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(rule, new RegExp(`max-height: calc\\(var\\(--composer-model-row\\) \\* ${MODEL_LIST_VISIBLE_ROWS} \\+ 50px\\);`));
  assert.match(rule, /overflow-y: auto;/);
  assert.match(rule, /overscroll-behavior: contain;/);
  const list = await readFile(
    new URL("../src/features/chat/composer/ComposerModelList.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(list, /otherModels|aria-expanded/, "no disclosure hides part of the list");
});
