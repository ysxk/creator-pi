import { describe, expect, it } from "vitest";
import { withPriorityServiceTier } from "./service-tier.js";

const model = {} as never;
type Options = { onPayload?: (payload: unknown, model: never) => unknown };

describe("withPriorityServiceTier", () => {
  it("adds the tier to the body of an OpenAI-style request", async () => {
    for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"]) {
      const options = withPriorityServiceTier<Options>({}, api, true);
      expect(await options.onPayload?.({ model: "gpt", input: [] }, model)).toEqual({
        model: "gpt",
        input: [],
        service_tier: "priority",
      });
    }
  });

  it("leaves the options alone when the tier is off or the API has no such field", () => {
    const options: Options = { onPayload: () => undefined };
    expect(withPriorityServiceTier(options, "openai-responses", false)).toBe(options);
    expect(withPriorityServiceTier(options, "anthropic-messages", true)).toBe(options);
    expect(withPriorityServiceTier(options, "google-generative-ai", true)).toBe(options);
  });

  it("runs after an earlier hook and keeps what it settled on", async () => {
    const options = withPriorityServiceTier<Options>(
      { onPayload: (payload: unknown) => ({ ...(payload as object), store: false }) },
      "openai-responses",
      true,
    );
    expect(await options.onPayload?.({ model: "gpt" }, model)).toEqual({
      model: "gpt",
      store: false,
      service_tier: "priority",
    });
  });

  it("does not touch a body an earlier hook replaced with a non-object", async () => {
    const options = withPriorityServiceTier<Options>(
      { onPayload: () => "raw" },
      "openai-responses",
      true,
    );
    expect(await options.onPayload?.({ model: "gpt" }, model)).toBe("raw");
  });
});
