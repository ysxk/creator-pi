/**
 * The priority service tier (`/fast`).
 *
 * OpenAI's wire APIs take a `service_tier` on the request body, and a
 * CLIProxyAPI server passes it upstream for the models it lists with service
 * tiers. Whether this request may ask for it is decided before the runtime is
 * launched, where the provider row and the model cache are; here it is one
 * field on the body, placed by a payload hook so it rides both the simple and
 * the explicit stream paths without a change to the provider adapters.
 */
const SERVICE_TIER_APIS: ReadonlySet<string> = new Set([
  "openai-responses",
  "openai-codex-responses",
  "openai-completions",
]);

export const PRIORITY_SERVICE_TIER = "priority";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Request options whose payload hook also asks for the priority tier. Options
 * for another wire API, or with the tier off, come back untouched.
 */
export function withPriorityServiceTier<
  T extends { onPayload?: (payload: unknown, model: never) => unknown },
>(options: T, api: string, enabled: boolean): T {
  if (!enabled || !SERVICE_TIER_APIS.has(api)) return options;
  return {
    ...options,
    onPayload: async (payload: unknown, model: never) => {
      const base = await options.onPayload?.(payload, model);
      const body = base ?? payload;
      // A hook that replaced the body with something that is not a request
      // object has taken the request over; leave what it returned alone.
      if (!isRecord(body)) return base;
      return { ...body, service_tier: PRIORITY_SERVICE_TIER };
    },
  };
}
