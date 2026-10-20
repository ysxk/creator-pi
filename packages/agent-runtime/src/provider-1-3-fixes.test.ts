import { describe, expect, it } from "vitest";
import { normalizeContext, type Message, type Model } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";

// Provider fixes Desktop takes with Pi 1.3.0, checked through the real
// decoders with a stubbed transport (no request leaves the process).

const completionsModel: Model<"openai-completions"> = {
  id: "relay-model", name: "Relay", api: "openai-completions", provider: "relay",
  baseUrl: "https://relay.test/v1", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096,
};
const anthropicModel: Model<"anthropic-messages"> = {
  id: "claude-test", name: "Claude", api: "anthropic-messages", provider: "acme",
  baseUrl: "https://api.acme.test", reasoning: false, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096,
};

describe("Pi 1.3.0 provider fixes on the Desktop dependency", () => {
  it("keeps reasoning before the answer when a gateway sends both in one chunk (#10926)", async () => {
    const body = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think first", content: "then answer" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const result = await streamCompletions(completionsModel, normalizeContext({
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }), {
      apiKey: "fixture",
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    }).result();
    expect(result.content.map((block) => block.type)).toEqual(["thinking", "text"]);
  });

  it("moves an error tool result's image after the turn's tool results for Anthropic (#10794)", async () => {
    let sent: { messages: Array<{ role: string; content: Array<{ type: string; is_error?: boolean }> }> } | undefined;
    const messages: Message[] = [
      { role: "user", content: "shoot", timestamp: 1 },
      {
        role: "assistant", api: "anthropic-messages", provider: "acme", model: "claude-test", timestamp: 2,
        stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: "toolu_1", name: "shot", arguments: {} }],
      },
      {
        role: "toolResult", toolCallId: "toolu_1", toolName: "shot", isError: true, timestamp: 3,
        content: [{ type: "text", text: "capture failed" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    ];
    const done = [
      { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    await streamAnthropic(anthropicModel, normalizeContext({ messages }), {
      apiKey: "fixture",
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(done, { headers: { "content-type": "text/event-stream" } });
      },
    }).result();
    const toolTurn = sent!.messages.find((message) =>
      message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"));
    const toolResult = toolTurn!.content.find((block) => block.type === "tool_result") as
      { is_error?: boolean; content?: Array<{ type: string }> };
    expect(toolResult.is_error).toBe(true);
    // The error result itself carries no image block, which Anthropic rejects;
    // the picture still reaches the model after the tool results.
    expect(JSON.stringify(toolResult.content ?? [])).not.toContain('"image"');
    expect(JSON.stringify(sent)).toContain("iVBORw0KGgo=");
  });
});
