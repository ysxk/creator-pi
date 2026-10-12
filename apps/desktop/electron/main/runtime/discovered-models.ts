import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { DiscoveredModelRow, ModelsDevCatalog } from "../models-dev-catalog";

/**
 * Hand the catalog the host's model cache: what each endpoint listed for its
 * own models when it was last discovered. Nothing is fetched from a provider.
 *
 * A failed read keeps what the catalog already holds, so a model the endpoint
 * described stays described; the failure is logged where a logger is given.
 */
export async function syncDiscoveredModels(
  host: Pick<HostProcess, "call">,
  catalog: Pick<ModelsDevCatalog, "configureDiscoveredModels">,
  logger?: Pick<Logger, "app">,
): Promise<void> {
  try {
    const cached = await host.call<{ models?: DiscoveredModelRow[] }>(
      "providers.listModels",
      {},
    );
    if (Array.isArray(cached?.models)) catalog.configureDiscoveredModels(cached.models);
  } catch (error) {
    logger?.app("provider", "warn", "endpoint model cache could not be read", {
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
