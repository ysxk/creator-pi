import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shared = await import("../../../packages/shared/dist/index.js");
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the threshold the inspector draws is the one the runtime compacts at", async () => {
  const [usage, latest, runtimeBudget] = await Promise.all([
    read("../src/lib/context-usage.ts"),
    read("../src/lib/latest-turn-context.ts"),
    read("../../../packages/agent-runtime/src/context-budget.ts"),
  ]);
  // One formula: the runtime re-exports it from shared instead of owning a copy.
  assert.match(runtimeBudget, /automaticCompactionThresholdFor,\s*contextBudgetLimitsFor,[\s\S]*?\} from "@pi-desktop\/shared";/);
  assert.doesNotMatch(runtimeBudget, /export function contextBudgetLimitsFor/);
  assert.match(usage, /automaticCompactionThresholdFor\(\s*contextBudgetLimitsFor\(\{/);
  assert.match(latest, /compactionThreshold: resolveCompactionThreshold\(/);
});

test("a 1M window with a 64K output cap compacts at 842.4K", () => {
  const limits = shared.contextBudgetLimitsFor({ contextWindow: 1_000_000, maxTokens: 64_000 });
  assert.equal(limits.requestHeadroom, 64_000);
  assert.equal(limits.hardLimit, 936_000);
  assert.equal(shared.automaticCompactionThresholdFor(limits), 842_400);
});

test("a small window still leaves a positive threshold below the window", () => {
  for (const contextWindow of [8_000, 32_000, 128_000, 200_000]) {
    const threshold = shared.automaticCompactionThresholdFor(
      shared.contextBudgetLimitsFor({ contextWindow }),
    );
    assert.ok(threshold > 0 && threshold < contextWindow, `${contextWindow} -> ${threshold}`);
  }
});
