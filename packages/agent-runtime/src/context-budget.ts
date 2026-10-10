/**
 * Context thresholds derived from the active model's window.
 *
 * The session runtime and its subagents must arrive at the same numbers: a
 * child that computed a looser budget than its parent would keep issuing
 * requests the parent already considers unsafe. Both therefore read the
 * formula from here instead of each owning a copy that can drift.
 *
 * Deliberately dependency-light — token estimation uses the pi-ai utility
 * boundary through the desktop-owned compatibility adapter, so this module
 * stays usable from any runtime context and can never form a cycle with
 * `runtime.ts`.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "./pi-runtime-estimates.js";
import {
  COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
  contextBudgetLimitsFor,
  type ContextBudgetLimits,
  type ContextBudgetModel,
} from "@pi-desktop/shared";

export {
  AUTO_COMPACTION_TRIGGER_RATIO,
  COMPACTION_KEEP_RECENT_RATIO,
  COMPACTION_MAX_KEEP_RECENT_TOKENS,
  COMPACTION_MIN_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_FLOOR_TOKENS,
  COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
  automaticCompactionThresholdFor,
  contextBudgetLimitsFor,
  type ContextBudgetLimits,
  type ContextBudgetModel,
} from "@pi-desktop/shared";

/** Context limits derived from the active model's window, with the estimated
 * size of the context they are being applied to.
 *
 * `hardLimit` is the safety boundary: the next provider request must not be
 * issued while the context is at or above it. Automatic compaction starts at
 * 90% of that budget, inline at the next turn boundary; there is no
 * off-critical-path variant. The formula lives in `@pi-desktop/shared`, where
 * the renderer reads the same thresholds it draws.
 */
export type ContextBudget = ContextBudgetLimits & {
  /** Estimated tokens in the reconstructed model context. */
  tokens: number;
};

/**
 * Estimation input. A full pi-ai `Model` additionally carries the replay
 * identity (`api`/`provider`/`id`) that hosted-search token estimation needs,
 * which is why it is named on its own next to the partial window facts above.
 */
export type ContextBudgetModelInput = ContextBudgetModel | Model<Api>;

/**
 * Token estimate of `messages` as the target model will carry them.
 *
 * Hosted search is model-dependent: the Responses adapter replays a
 * `web_search_call` only for the model that produced it, so `api` is the
 * discriminant that says whether a target model is known at all. A caller with
 * partial model facts (a catalog entry, a caller test) has no target and keeps
 * the conservative estimate — every search block is charged rather than
 * assumed away.
 */
function estimateContextTokensFor(
  model: ContextBudgetModelInput,
  messages: AgentMessage[],
): ReturnType<typeof estimateContextTokens> {
  return "api" in model
    ? estimateContextTokens(messages, model)
    : estimateContextTokens(messages);
}

/** Thresholds for a model window, plus the estimated size of `messages`. */
export function contextBudgetFor(
  model: ContextBudgetModelInput,
  messages: AgentMessage[],
): ContextBudget {
  return {
    tokens: estimateContextTokensFor(model, messages).tokens,
    ...contextBudgetLimitsFor(model),
  };
}

/**
 * Cap on the active user message a checkpoint carries forward. Codex uses a
 * flat 20k; the clamp keeps a small model window from being filled by
 * retention alone, which would leave the summary no room.
 */
export function retainedUserMessageBudget(
  budget: Pick<ContextBudget, "hardLimit">,
): number {
  return Math.max(
    1,
    Math.min(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
      Math.floor(budget.hardLimit * 0.5),
    ),
  );
}
