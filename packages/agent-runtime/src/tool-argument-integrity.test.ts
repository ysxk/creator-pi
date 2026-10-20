import type { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { DesktopAgentRuntime } from "./runtime.js";
import { modelConfigFromPi } from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

// Pi 1.3.0 (4b994d5e5e, 87f9a36419): an invalid `\u` escape is repaired
// instead of truncating the arguments, and a completed call whose arguments
// are not a JSON object fails validation instead of running with the prefix
// that parsed. These drive a Desktop session through the real Chat
// Completions decoder to show the Desktop path keeps both.

function provider(): RuntimeProviderConfig {
  const flash = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash");
  if (!flash) throw new Error("Missing published Flash model");
  return {
    id: "args-fixture", name: "Args fixture", modelId: flash.id, baseUrl: flash.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: [],
    modelConfig: JSON.parse(JSON.stringify(modelConfigFromPi(flash))),
  };
}

const sse = (chunks: unknown[]) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

function toolCallTurn(name: string, rawArguments: string): string {
  return sse([
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: rawArguments } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}
const doneTurn = sse([{ choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: "stop" }] }]);

async function run(name: string, rawArguments: string) {
  const executed: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "args", mode: "agent", provider: provider(), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "project.instructions.resolve") return { entries: [] } as T;
        if (method === "tools.execute") {
          executed.push(params as { toolName: string; args: Record<string, unknown> });
          return { ok: true, content: "found" } as T;
        }
        return undefined as T;
      },
    },
    onEvent: () => {},
  });
  const agent = (runtime as unknown as { agent: Agent }).agent;
  agent.streamFunction = (model, context) => stream(model as Model<"openai-completions">, context, {
    apiKey: "fixture",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const body = requests.length === 1 ? toolCallTurn(name, rawArguments) : doneTurn;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    await runtime.prompt("Search", "user-1", "turn-1");
  } finally {
    await runtime.dispose();
  }
  return { executed, requests };
}

describe("tool argument integrity in a Desktop session (Pi 1.3.0)", () => {
  it("keeps every argument when a string holds an invalid \\u escape", async () => {
    const { executed } = await run("Grep", '{"pattern":"\\usepackage","path":"src"}');
    expect(executed).toHaveLength(1);
    expect(executed[0].toolName).toBe("Grep");
    expect(String(executed[0].args.pattern)).toContain("usepackage");
    expect(executed[0].args.path).toBe("src");
  });

  it("never runs a completed call whose arguments are malformed JSON", async () => {
    const { executed, requests } = await run("Grep", '{"pattern":"foo", "path": }');
    expect(executed).toHaveLength(0);
    // The model is told why, with the text it sent, on the same call id.
    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool") as
      | { tool_call_id?: string; content?: unknown }
      | undefined;
    expect(toolMessage?.tool_call_id).toBe("call_1");
    expect(JSON.stringify(toolMessage?.content)).toContain('\\"path\\": }');
  });
});
