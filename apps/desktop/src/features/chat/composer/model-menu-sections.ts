import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import {
  composerModelBinding,
  composerModelMatchesQuery,
  sameComposerModelId,
} from "../../../lib/composer-models";
import { sameRecentModel, type RecentModel } from "../../../lib/recent-models";

/** How many recently used models lead the list. */
export const RECENT_MODEL_ROWS = 3;

/** Model rows on screen before the list scrolls; mirrored by `.composer-model-list`. */
export const MODEL_LIST_VISIBLE_ROWS = 7;

export type ModelMenuGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  providerSearchText: string;
  models: ModelInfo[];
};

export type ModelMenuEntry = { provider: ProviderPublic; model: ModelInfo };

export type ModelMenuSections = {
  /** The recently used models, newest first; empty while searching. */
  recentEntries: ModelMenuEntry[];
  /** Every other model by provider, with the recent ones taken out. */
  groups: ModelMenuGroup[];
  /** The rows in the order they are drawn, which is the keyboard's order. */
  flatModels: ModelMenuEntry[];
};

/**
 * Lay out the Composer's model menu (D676).
 *
 * Nothing is folded away: the recent models lead, every other model follows
 * under its provider, and the list scrolls inside a window of
 * `MODEL_LIST_VISIBLE_ROWS` rows. A search drops the recent section and
 * filters all configured models instead.
 */
export function modelMenuSections(
  groups: readonly ModelMenuGroup[],
  recentModels: readonly RecentModel[] | null | undefined,
  query: string,
): ModelMenuSections {
  const needle = query.trim().toLowerCase();
  if (needle) {
    const matching = groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) =>
          composerModelMatchesQuery(
            model,
            group.providerSearchText,
            needle,
            composerModelBinding(group.provider, model.modelId)?.alias,
          ),
        ),
      }))
      .filter((group) => group.models.length > 0);
    return { recentEntries: [], groups: matching, flatModels: flatten(matching) };
  }
  const entries = flatten(groups);
  const recentEntries = (recentModels ?? [])
    .flatMap((recent) => {
      const entry = entries.find((candidate) =>
        sameRecentModel(recent, {
          providerId: candidate.provider.id,
          modelId: candidate.model.modelId,
        }),
      );
      return entry ? [entry] : [];
    })
    .slice(0, RECENT_MODEL_ROWS);
  const remaining = groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          !recentEntries.some(
            (entry) =>
              entry.provider.id === group.provider.id &&
              sameComposerModelId(entry.model.modelId, model.modelId),
          ),
      ),
    }))
    .filter((group) => group.models.length > 0);
  return {
    recentEntries,
    groups: remaining,
    flatModels: [...recentEntries, ...flatten(remaining)],
  };
}

function flatten(groups: readonly ModelMenuGroup[]): ModelMenuEntry[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({ provider: group.provider, model })),
  );
}
