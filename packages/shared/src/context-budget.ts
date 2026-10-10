/**
 * Context thresholds derived from a model's window.
 *
 * The session runtime compacts by these numbers and the renderer draws them,
 * so both read the one formula from here: a threshold line the UI computed on
 * its own would be a second opinion about when the runtime acts.
 */

import { CATALOG_DEFAULT_CONTEXT_WINDOW, CATALOG_DEFAULT_MAX_TOKENS } from "./model-catalog.js";

/** Safety thresholds for one model window. */
export type ContextBudgetLimits = {
  /** Point where an uncompacted provider request is no longer allowed. */
  hardLimit: number;
  /** Tokens reserved for the request's own prompt and output. */
  requestHeadroom: number;
  /** Approximate recent-context tokens a checkpoint should retain. */
  keepRecentTokens: number;
};

/**
 * Tokens held back from the context window for the summary prompt and the
 * model's own output. Compaction thresholds are derived from the active model's
 * window rather than configured, and this floor reproduces the reserve that
 * used to be the default setting, so the hard safety boundary is unchanged.
 */
export const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;
/**
 * Retained-tail target as a share of the safe budget, bounded so a 32K window
 * still keeps a usable tail and a 1M window does not carry the whole session
 * forward. A single fixed token count cannot serve both.
 */
export const COMPACTION_KEEP_RECENT_RATIO = 0.2;
export const COMPACTION_MIN_KEEP_RECENT_TOKENS = 8_000;
export const COMPACTION_MAX_KEEP_RECENT_TOKENS = 64_000;
/**
 * Cap on the user messages carried across a compaction boundary, matching
 * Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`. Clamped against the safe budget so
 * a small model window is not filled by retention alone.
 */
export const COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000;

/** Fraction of the safe request budget that starts automatic compaction. */
export const AUTO_COMPACTION_TRIGGER_RATIO = 0.9;

/**
 * Start compaction before the hard boundary so estimator drift and one-turn
 * growth do not leave the provider request as the first overflow detector.
 */
export function automaticCompactionThresholdFor(
  budget: Pick<ContextBudgetLimits, "hardLimit">,
): number {
  return Math.max(1, Math.floor(budget.hardLimit * AUTO_COMPACTION_TRIGGER_RATIO));
}

/**
 * The only model facts the budget depends on. Kept structural and optional so a
 * pi-ai `Model` passes directly, while a catalog entry that never reported a
 * window still falls back to the package defaults instead of producing NaN.
 */
export type ContextBudgetModel = {
  contextWindow?: number;
  maxTokens?: number;
};

/**
 * Derive the safety thresholds for a model window, without estimating tokens.
 *
 * Headroom is the larger of the reserve floor, the model's own output budget,
 * and 5% of the window: a model that can emit 32K tokens needs at least that
 * much room, and a very large window needs proportionally more than the floor.
 * Every bound is clamped so a pathologically small window still yields a
 * positive limit rather than zero or a negative one.
 */
export function contextBudgetLimitsFor(
  model: ContextBudgetModel,
): ContextBudgetLimits {
  const contextWindow = Math.max(
    1,
    Math.round(model.contextWindow || CATALOG_DEFAULT_CONTEXT_WINDOW),
  );
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(model.maxTokens || CATALOG_DEFAULT_MAX_TOKENS)),
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const reserveFloor = Math.min(
    COMPACTION_RESERVE_FLOOR_TOKENS,
    Math.max(1, Math.floor(contextWindow * 0.5)),
  );
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(reserveFloor, modelOutputBudget, Math.ceil(contextWindow * 0.05)),
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  const keepRecentTokens = Math.min(
    Math.max(
      COMPACTION_MIN_KEEP_RECENT_TOKENS,
      Math.min(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
        Math.floor(hardLimit * COMPACTION_KEEP_RECENT_RATIO),
      ),
    ),
    // A retained tail wider than half the safe budget would leave the summary
    // no room, so the min/max clamp above never wins on a small window.
    Math.max(1, Math.floor(hardLimit * 0.5)),
  );
  return { hardLimit, requestHeadroom, keepRecentTokens };
}
