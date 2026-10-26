import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { ProjectInstructions } from "./project-instructions.js";
import { projectInstructionsPrompt } from "./project-instructions-prompt.js";
import { composeSubagentSystemPrompt, SubagentRun } from "./subagent.js";

type Request = { model: string; messages: Array<{ role: string; content: unknown; name?: string }> };
type RuntimeOptions = ConstructorParameters<typeof DesktopAgentRuntime>[0];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const instructions: ProjectInstructions = {
  entries: [
    { source: "~/.pi/agent/AGENTS.md", content: "GLOBAL_SENTINEL" },
    { source: "AGENTS.md", content: "PROJECT_SENTINEL" },
  ],
};
const shell = { id: "bash" as const, label: "Bash", dialect: "posix" as const, available: true, isDefault: true };

function answer(res: ServerResponse, model: string, tools?: Array<{ name: string; args: object }>) {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  const delta = tools
    ? { role: "assistant", tool_calls: tools.map((tool, index) => ({ index, id: `call-${index}`, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }
    : { role: "assistant", content: "The requested work is complete." };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function fixture(handle?: (request: Request, res: ServerResponse) => boolean) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as Request;
    requests.push(request);
    if (!handle?.(request, res)) answer(res, request.model);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const provider = (modelId: string, systemPrompt = `${modelId}_MODEL_SENTINEL`): RuntimeProviderConfig => ({
    id: `account-${modelId}`, name: modelId, modelId, systemPrompt,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", authKind: "none", apiStyle: "chat_completions",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  const persisted: UiMessage[] = [];
  const events: AgentEventEnvelope[] = [];
  const options = (overrides: Partial<RuntimeOptions> = {}): RuntimeOptions => ({
    sessionId: "model-prompt-session", mode: "agent", thinkingLevel: "off", provider: provider("parent"),
    commandShell: shell, projectInstructions: instructions, onEvent: (event) => events.push(event),
    host: { call: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === "session.appendMessage") { persisted.push(params?.message as UiMessage); return undefined as T; }
      if (method === "project.instructions.resolve") return { entries: [instructions.entries[0],
        { source: "nested/AGENTS.md", content: "NESTED_SENTINEL" }] } as T;
      if (method === "tool.execute") return { ok: true, content: "File fixture contents" } as T;
      throw new Error(`Unexpected host call ${method}`);
    } },
    ...overrides,
  });
  const runtime = (overrides: Partial<RuntimeOptions> = {}) => {
    const opts = options(overrides);
    const instance = new DesktopAgentRuntime(opts);
    cleanups.push(() => instance.dispose());
    return { instance, opts };
  };
  return { requests, provider, options, runtime, persisted, events };
}

function system(request: Request): string {
  return request.messages.filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

function assertOrder(prompt: string, markers: string[]) {
  let previous = -1;
  for (const marker of markers) {
    expect(prompt.split(marker), marker).toHaveLength(2);
    const index = prompt.indexOf(marker);
    expect(index, marker).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("model instructions on the actual request wire", () => {
  it.each([[true, true], [false, true], [true, false], [false, false]])(
    "orders global=%s, selected model, project=%s without mutating the source entries", async (global, project) => {
      const f = await fixture();
      const chain = { entries: instructions.entries.filter((_, index) => index === 0 ? global : project) };
      const before = structuredClone(chain);
      const { instance } = f.runtime({ projectInstructions: chain });
      await instance.prompt("Hello", "user-1", "turn-1");
      expect(f.requests).toHaveLength(1);
      assertOrder(system(f.requests[0]), [
        ...(global ? ["GLOBAL_SENTINEL"] : []), "parent_MODEL_SENTINEL", ...(project ? ["PROJECT_SENTINEL"] : []),
      ]);
      expect(chain).toEqual(before);
    },
  );

  it("omits an empty model section and supports typed global scope with a custom source", async () => {
    const f = await fixture();
    const { instance } = f.runtime({ provider: f.provider("parent", "  "), projectInstructions: undefined });
    await instance.prompt("Hello", "user-1", "turn-1");
    expect(system(f.requests[0])).not.toContain("## Model instructions");
    expect(projectInstructionsPrompt(undefined, "")).toBeUndefined();
    const chain: ProjectInstructions = { entries: [
      { scope: "global", source: "custom-global", content: "GLOBAL_SENTINEL" }, instructions.entries[1],
    ] };
    assertOrder(projectInstructionsPrompt(chain, "model")!, ["GLOBAL_SENTINEL", "model", "PROJECT_SENTINEL"]);
  });

  it.each(["model", "provider"])("replaces the previous instructions on resume after changing %s identity", async (identity) => {
    const f = await fixture();
    const { instance, opts } = f.runtime();
    expect(instance.matches(opts)).toBe(true);
    expect(instance.matches({ ...opts, provider: { ...opts.provider, systemPrompt: "UPDATED_MODEL_SENTINEL" } })).toBe(false);
    expect(instance.matches({ ...opts, provider: { ...opts.provider, id: "other-account" } })).toBe(false);
    await instance.prompt("First", "user-1", "turn-1");
    const history = [...f.persisted];
    const selected = identity === "model"
      ? { ...f.provider("other", "UPDATED_MODEL_SENTINEL"), id: opts.provider.id }
      : { ...opts.provider, id: "other-account", systemPrompt: "UPDATED_MODEL_SENTINEL" };
    const next = f.runtime({ provider: selected, history });
    await next.instance.prompt("Continue", "user-2", "turn-2");
    assertOrder(system(f.requests.at(-1)!), ["GLOBAL_SENTINEL", "UPDATED_MODEL_SENTINEL", "PROJECT_SENTINEL"]);
    expect(system(f.requests.at(-1)!)).not.toContain("parent_MODEL_SENTINEL");
  });

  it("a changed next-turn prompt does not change or interrupt a request already in flight", async () => {
    let release: () => void = () => { throw new Error("fixture has not received a request"); };
    let started: () => void = () => undefined;
    const received = new Promise<void>((resolve) => { started = resolve; });
    const f = await fixture((request, res) => {
      release = () => answer(res, request.model);
      started();
      return true;
    });
    const { instance, opts } = f.runtime();
    const running = instance.prompt("Hello", "user-1", "turn-1");
    await received;
    expect(instance.matches({ ...opts, provider: { ...opts.provider, systemPrompt: "NEXT_PROMPT" } })).toBe(false);
    expect((instance as any).isIdle()).toBe(false);
    expect(system(f.requests[0])).toContain("parent_MODEL_SENTINEL");
    expect(system(f.requests[0])).not.toContain("NEXT_PROMPT");
    release();
    await running;
    expect((instance as any).isIdle()).toBe(true);
  });

  it("keeps exactly the current model prompt when file-tool path rules refresh", async () => {
    let sentRead = false;
    const f = await fixture((request, res) => {
      if (sentRead) return false;
      sentRead = true;
      answer(res, request.model, [{ name: "Read", args: { path: "nested/file.ts" } }]);
      return true;
    });
    const { instance } = f.runtime({ projectPath: "/fixture/project" });
    await instance.prompt("Read the file", "user-1", "turn-1");
    expect(f.requests).toHaveLength(2);
    assertOrder(system(f.requests[1]), ["GLOBAL_SENTINEL", "parent_MODEL_SENTINEL", "NESTED_SENTINEL"]);
    expect(system(f.requests[1])).not.toContain("PROJECT_SENTINEL");
  });

  it("composes a delegate's own model, switches on fallback, and resumes without old model text", async () => {
    const f = await fixture((request, res) => {
      if (request.model !== "primary") return false;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not found" } }));
      return true;
    });
    const definition = { name: "worker", description: "Fixture worker", tools: [], prompt: "CUSTOM_DEFINITION_SENTINEL", source: "user" as const };
    const framing = composeSubagentSystemPrompt({ definition, guidance: ["CORE_GUIDANCE_SENTINEL"] });
    const run = (provider: RuntimeProviderConfig, initialMessages?: ConstructorParameters<typeof SubagentRun>[0]["initialMessages"]) => new SubagentRun({
      sessionId: "child", parentToolCallId: "task", definition, task: "Do the task", systemPrompt: framing,
      provider, projectInstructions: instructions, thinkingLevel: "off", tools: [], onEvent: () => undefined,
      fallbackModels: [{ key: "backup/backup", provider: f.provider("backup") }], initialMessages,
    }).run();
    expect((await run(f.provider("primary"))).status).toBe("completed");
    for (const request of f.requests) {
      assertOrder(system(request), ["CUSTOM_DEFINITION_SENTINEL", "CORE_GUIDANCE_SENTINEL", "GLOBAL_SENTINEL",
        `${request.model}_MODEL_SENTINEL`, "PROJECT_SENTINEL"]);
      expect(system(request)).not.toContain("parent_MODEL_SENTINEL");
    }
    expect(system(f.requests[1])).not.toContain("primary_MODEL_SENTINEL");
    expect((await run(f.provider("resumed"), [{ role: "system", content: framing, timestamp: 1,
      sections: { runtime: `${framing}\n\n${projectInstructionsPrompt(instructions, "backup_MODEL_SENTINEL")}` } }])).status).toBe("completed");
    assertOrder(system(f.requests.at(-1)!), ["GLOBAL_SENTINEL", "resumed_MODEL_SENTINEL", "PROJECT_SENTINEL"]);
    expect(system(f.requests.at(-1)!)).not.toContain("backup_MODEL_SENTINEL");
  });

  it("Task uses its selected provider's prompt rather than inheriting the parent model text", async () => {
    let delegated = false;
    const f = await fixture((request, res) => {
      if (request.model !== "parent" || delegated) return false;
      delegated = true;
      answer(res, request.model, [
        { name: "Task", args: { agent: "worker", task: "Do the task" } },
        { name: "TaskWait", args: {} },
      ]);
      return true;
    });
    const { instance } = f.runtime({
      subagents: [{ name: "worker", description: "Fixture worker", tools: ["Read"], prompt: "CUSTOM_DEFINITION_SENTINEL", source: "user",
        model: { providerId: "child", modelId: "child" } }],
      subagentProviders: { "child/child": f.provider("child") },
    });
    await instance.prompt("Delegate the task", "user-1", "turn-1");
    const child = f.requests.find((request) => request.model === "child");
    expect(child, JSON.stringify(f.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool")))).toBeDefined();
    assertOrder(system(child!), ["CUSTOM_DEFINITION_SENTINEL", "GLOBAL_SENTINEL", "child_MODEL_SENTINEL", "PROJECT_SENTINEL"]);
    expect(system(child!)).not.toContain("parent_MODEL_SENTINEL");
  });
});
