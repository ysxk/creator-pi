import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  modelListRequest,
  normalizeModelList,
} from "../electron/main/model-discovery.ts";

test("openai-style lists normalize, dedupe, and sort", () => {
  const models = normalizeModelList("chat_completions", {
    object: "list",
    data: [
      { id: "gpt-4.1", object: "model" },
      { id: "deepseek-chat" },
      { id: "gpt-4.1" },
      { object: "model" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "deepseek-chat", displayName: "deepseek-chat" },
    { modelId: "gpt-4.1", displayName: "gpt-4.1" },
  ]);
  // Bare-array gateways parse the same way.
  assert.equal(normalizeModelList("responses", [{ id: "o4-mini" }]).length, 1);
});

test("a models[] response with slug rows is read as a list too", () => {
  /*
    Zhipu publishes three model-list shapes on one host: OpenAI Responses serves
    `{ models: [{ slug }] }`, Anthropic and the coding plan serve `{ data: [{ id }] }`.
    Reading only `data[].id` left the Responses row with an empty list, and the
    larger sweep then looked for the models somewhere else entirely.
  */
  assert.deepEqual(
    normalizeModelList("responses", {
      models: [
        { slug: "glm-5.3", display_name: "glm-5.3", context_window: 1_048_576, supported_in_api: true },
        { slug: "glm-5.3" },
      ],
    }),
    // The row's own context_window is now carried with it.
    [{ modelId: "glm-5.3", displayName: "glm-5.3", contextWindow: 1_048_576 }],
  );
  // The two id keys are mutually exclusive; `id` wins if a gateway publishes both.
  assert.deepEqual(normalizeModelList("chat_completions", { models: [{ id: "m", slug: "s" }] }), [
    { modelId: "m", displayName: "m" },
  ]);
  // A Google list still takes its own branch and keeps the `models/` prefix off.
  assert.deepEqual(normalizeModelList("google_generative_ai", { models: [{ name: "models/gemini-3" }] }), [
    { modelId: "gemini-3", displayName: "gemini-3" },
  ]);
  // A data list still wins over a models wrapper when both are present.
  assert.deepEqual(normalizeModelList("responses", { data: [{ id: "a" }], models: [{ slug: "b" }] }), [
    { modelId: "a", displayName: "a" },
  ]);
});
test("anthropic lists keep display names", () => {
  const models = normalizeModelList("anthropic_messages", {
    data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
  });
  assert.deepEqual(models, [
    { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  ]);
});

test("google lists strip the models/ prefix", () => {
  const models = normalizeModelList("google_generative_ai", {
    models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { name: "models/gemini-2.5-flash" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "gemini-2.5-flash", displayName: "gemini-2.5-flash" },
    { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
  ]);
});

test("requests use per-style endpoints and auth headers", () => {
  const openai = modelListRequest({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
  });
  assert.equal(openai.url, "https://api.example.com/v1/models");
  assert.equal(openai.headers.Authorization, "Bearer sk-x");

  const anthropic = modelListRequest({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-a",
    apiStyle: "anthropic_messages",
  });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(anthropic.headers["x-api-key"], "sk-a");
  assert.ok(anthropic.headers["anthropic-version"]);
  // A base already ending in /v1 is not doubled.
  assert.match(
    modelListRequest({ baseUrl: "https://gw.example/v1", apiStyle: "anthropic_messages" }).url,
    /^https:\/\/gw\.example\/v1\/models/,
  );

  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "g-key",
    apiStyle: "google_generative_ai",
  });
  assert.match(google.url, /\/v1beta\/models\?/);
  assert.match(google.url, /key=g-key/);
  assert.deepEqual(google.headers, {});
});

test("OpenCode Go uses its fixed OpenAI-compatible model endpoint", () => {
  const request = modelListRequest({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "go-key",
    apiStyle: "opencode_go",
  });
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/models");
  assert.equal(request.headers.Authorization, "Bearer go-key");
});

test("optional custom headers are attached to discovery requests", () => {
  const request = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { "User-Agent": "Custom/1.0", "X-Gateway": "1" },
  });
  assert.equal(request.headers.Authorization, "Bearer sk-x");
  assert.equal(request.headers["User-Agent"], "Custom/1.0");
  assert.equal(request.headers["X-Gateway"], "1");
  const smashed = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { Authorization: "Bearer other" },
  });
  assert.equal(smashed.headers.Authorization, "Bearer sk-x");
  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google_generative_ai",
  });
  assert.equal(google.headers["User-Agent"], undefined);
});

test("a Gemini-style list carries the modalities a proxy publishes", () => {
  // CLIProxyAPI's /v1beta/models names them `supportedInputModalities`; without
  // them a video-capable row was recorded as text-only and its clips went to
  // the model as file paths.
  assert.deepEqual(
    normalizeModelList("google_generative_ai", {
      models: [
        {
          name: "models/gemini-flash",
          displayName: "Gemini Flash",
          supportedInputModalities: ["text", "image", "audio", "video"],
          supportedOutputModalities: ["text"],
        },
      ],
    }),
    [
      {
        modelId: "gemini-flash",
        displayName: "Gemini Flash",
        input: ["text", "image", "audio", "video"],
        capabilities: ["vision", "audio", "video"],
      },
    ],
  );
});

test("proxy-style rows carry context window, modalities, and effort metadata", () => {
  const models = normalizeModelList("chat_completions", {
    object: "list",
    data: [
      {
        id: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash",
        context_window: 1_048_576,
        input_modalities: ["text", "image", "video"],
        supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }],
      },
      {
        id: "gemini-3-pro-image-preview",
        input_modalities: ["text"],
        output_modalities: ["image"],
      },
      { id: "plain-model" },
      { id: "hidden-model", visibility: "hide" },
    ],
  });
  assert.deepEqual(models, [
    {
      modelId: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      contextWindow: 1_048_576,
      input: ["text", "image", "video"],
      capabilities: ["vision", "video"],
      reasoningLevels: ["high", "low"],
    },
    {
      modelId: "gemini-3-pro-image-preview",
      displayName: "gemini-3-pro-image-preview",
      input: ["text"],
      capabilities: ["imagegen"],
    },
    { modelId: "plain-model", displayName: "plain-model" },
  ]);
});

test("the provider cache payload carries displayName and decorated metadata", async () => {
  const source = await readFile(new URL("../electron/main/ipc/provider-ipc.ts", import.meta.url), "utf8");
  // The host requires displayName; a payload without it fails INVALID_PARAMS
  // and silently leaves the cache empty.
  assert.match(source, /displayName: \(model\.displayName as string \| undefined\) \|\| \(model\.modelId as string\)/);
  // The input carries decorated ModelInfo records: modalities.input and
  // supportedThinkingLevels are where the endpoint-published metadata lives.
  assert.match(source, /model\.modalities as \{ input\?: string\[\] \}/);
  assert.match(source, /supportedThinkingLevels as string\[\] \| undefined/);
  // `text` is implied by the reader; storing it would duplicate the entry.
  assert.match(source, /filter\(\(modality\) => modality !== "text"\)/);
});

test("a CLIProxyAPI row asks for the pi catalogue at the server root", async () => {
  const { cliProxyCatalogUrl, isCliProxyProvider } = await import(
    "../electron/main/model-discovery.ts"
  );
  // Whichever API path the row names, the catalogue is the root's /v1/models.
  for (const base of [
    "http://127.0.0.1:8317",
    "http://127.0.0.1:8317/",
    "http://127.0.0.1:8317/v1",
    "http://127.0.0.1:8317/v1beta/",
    "http://127.0.0.1:8317/backend-api",
  ]) {
    assert.equal(cliProxyCatalogUrl(base), "http://127.0.0.1:8317/v1/models?client_version=pi");
  }
  // A path that is not one of the API suffixes is part of the deployment.
  assert.equal(
    cliProxyCatalogUrl("https://gw.example/proxy/v1"),
    "https://gw.example/proxy/v1/models?client_version=pi",
  );

  // One bearer-authenticated request whatever wire API the row speaks.
  for (const apiStyle of ["responses", "anthropic_messages", "google_generative_ai"]) {
    const request = modelListRequest({
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "sk-x",
      apiStyle,
      cliProxyCatalog: true,
    });
    assert.equal(request.url, "http://127.0.0.1:8317/v1/models?client_version=pi");
    assert.deepEqual(request.headers, { Authorization: "Bearer sk-x" });
  }
  // Every other provider's request is what it was.
  assert.equal(
    modelListRequest({ baseUrl: "https://api.example.com/v1", apiStyle: "responses" }).url,
    "https://api.example.com/v1/models",
  );

  assert.equal(isCliProxyProvider({ vendorKey: "cliproxyapi" }), true);
  assert.equal(isCliProxyProvider({ vendorKey: "custom", ownerPluginId: "pi.cliproxyapi" }), true);
  assert.equal(isCliProxyProvider({ vendorKey: "custom" }), false);
  assert.equal(isCliProxyProvider(undefined), false);
});

test("the catalogue's rows carry their limits, modalities, efforts and service tiers", () => {
  const models = normalizeModelList("openai_models", {
    models: [
      {
        slug: "gpt-fast",
        display_name: "GPT Fast",
        context_window: 400000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        service_tiers: ["priority"],
      },
      { slug: "plain", display_name: "Plain", service_tiers: [] },
      { slug: "hidden", visibility: "hide", service_tiers: ["priority"] },
    ],
  });
  assert.deepEqual(models, [
    {
      modelId: "gpt-fast",
      displayName: "GPT Fast",
      contextWindow: 400000,
      input: ["text", "image"],
      capabilities: ["vision"],
      reasoningLevels: ["low", "high"],
      serviceTiers: ["priority"],
    },
    // An empty tier list is a model the server does not serve on a tier.
    { modelId: "plain", displayName: "Plain" },
  ]);
});

test("a server without the catalogue is asked for the plain list instead", async () => {
  const { probeModelList } = await import("../electron/main/model-discovery.ts");
  const realFetch = globalThis.fetch;
  const asked = [];
  const answer = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    // The catalogue answers: one request.
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return answer({ models: [{ slug: "a", context_window: 1000 }] });
    };
    const catalogue = await probeModelList({
      baseUrl: "http://127.0.0.1:8317/v1",
      apiStyle: "responses",
      cliProxyCatalog: true,
    });
    assert.deepEqual(asked, ["http://127.0.0.1:8317/v1/models?client_version=pi"]);
    assert.deepEqual(catalogue.models, [{ modelId: "a", displayName: "a", contextWindow: 1000 }]);

    // The catalogue is refused, or empty: the plain list is asked next.
    for (const first of [() => answer({ error: "nope" }, 404), () => answer({ models: [] })]) {
      asked.length = 0;
      globalThis.fetch = async (url) => {
        asked.push(String(url));
        return asked.length === 1 ? first() : answer({ data: [{ id: "b" }] });
      };
      const plain = await probeModelList({
        baseUrl: "http://127.0.0.1:8317/v1",
        apiStyle: "responses",
        cliProxyCatalog: true,
      });
      assert.deepEqual(asked, [
        "http://127.0.0.1:8317/v1/models?client_version=pi",
        "http://127.0.0.1:8317/v1/models",
      ]);
      assert.deepEqual(plain.models, [{ modelId: "b", displayName: "b" }]);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the priority-tier fact survives the model cache and gates /fast at launch", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [ipc, launch, commands, picker] = await Promise.all([
    read("../electron/main/ipc/provider-ipc.ts"),
    read("../electron/main/runtime/session-launch.ts"),
    read("../src/lib/commands.ts"),
    read("../src/features/chat/composer/ComposerModelPicker.tsx"),
  ]);
  // Both places that reach the endpoint ask a CLIProxyAPI row for its catalogue.
  assert.equal([...ipc.matchAll(/isCliProxyProvider\((?:provider|detail\.provider)\) \? \{ cliProxyCatalog: true \} : \{\}/g)].length, 2);
  // Written to the cache as a capability, taken back out on the way to ModelInfo.
  assert.match(ipc, /model\.supportsPriorityTier === true \? \[PRIORITY_TIER_CAPABILITY\] : \[\]/);
  assert.match(ipc, /capability !== PRIORITY_TIER_CAPABILITY/);
  assert.match(ipc, /model\.serviceTiers\?\.length \? \{ supportsPriorityTier: true \} : \{\}/);
  // The launch asks for the tier only with the switch on, on such a server,
  // for a model the cache marks.
  assert.match(
    launch,
    /if \(settings\.fastMode === true && isCliProxyProvider\(provider\)\) \{[\s\S]*?model\.modelId === modelId &&\s*model\.capabilities\?\.includes\(PRIORITY_TIER_CAPABILITY\) === true/,
  );
  assert.match(launch, /priorityServiceTier,\n/);
  // `/fast` flips one app-wide setting and reports the new state.
  assert.match(commands, /case "builtin\.agent\.fast": \{[\s\S]*?const fastMode = store\.settings\.fastMode !== true;[\s\S]*?await api\.setSettings\(next\);/);
  // The chip marks it only when it is in effect for the selected model.
  assert.match(picker, /state\.settings\?\.fastMode === true &&[\s\S]*?model\.supportsPriorityTier === true/);
  assert.match(picker, /\{fast \? \(/);
});
