import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
const i18n = createInstance();
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModelInfo, ProviderPublic, SessionThinkingLevel } from "@pi-desktop/shared";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "./fixtures/composer-model-selection-store";

declare global {
  var composerModelSelectionProbe: () => Promise<{
    model: string;
    switchedLevel: string;
    level: string;
    writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }>;
  }>;
}

const provider: ProviderPublic = {
  id: "fixture-provider",
  name: "Fixture provider",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  authKind: "none",
  hasSecret: false,
  models: [
    { id: "model-c", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-d", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-a", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
    { id: "model-b", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
  ],
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "high"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const models: ModelInfo[] = ["model-a", "model-b"].map((modelId) => ({
  modelId,
  displayName: modelId === "model-a" ? "Model A" : "Model B",
  providerId: provider.id,
  reasoning: true,
  supportedThinkingLevels: ["low", "high"],
  capabilities: ["text", "reasoning"],
  source: "user",
}));

useAppStore.setState({ providers: [provider], providerModels: { [provider.id]: models },
  recentModels: ["model-d", "model-c", "model-b", "model-a"].map(modelId => ({ providerId: provider.id, modelId })),
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }> = [];

function Fixture() {
  const [modelId, setModelId] = useState("model-a");
  // Start with a manual value that differs from Model A's default.
  const [thinkingLevel, setThinkingLevel] = useState<SessionThinkingLevel>("low");
  const controller = useComposerModelMenu({
    mode: "agent",
    activeSessionId: "fixture-session",
    provider,
    modelId,
    thinkingProvider: undefined,
    thinkingLevel,
    controlsBlocked: false,
    configureActiveSession: async (configuration) => {
      writes.push(configuration);
      setModelId(configuration.modelId ?? "model-a");
      setThinkingLevel(configuration.thinkingLevel);
    },
  });
  return (
    <div className="composer-stack" style={{ position: "absolute", left: 120, top: 300, width: 640 }}>
      <ComposerModelPicker
        t={i18n.t} controller={controller} modelLabel={modelId}
        thinkingLabel={thinkingLevel} thinkingLevel={thinkingLevel}
        selectedProviderId={provider.id} selectedModelId={modelId}
        controlsBlocked={false} onCloseOtherMenus={() => {}}
      />
      <span className="selected-model">{modelId}</span>
      <span className="selected-thinking-level">{thinkingLevel}</span>
    </div>
  );
}

const settle = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

globalThis.composerModelSelectionProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  flushSync(() => root.render(<Fixture />));
  await settle();
  const trigger = document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!;
  flushSync(() => trigger.click());
  await settle();
  const menu = () => document.querySelector<HTMLElement>('.composer-model-menu[data-surface-state="open"]')!;
  const rows = () => Array.from(menu().querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  const recentRows = () => Array.from(menu().querySelectorAll<HTMLButtonElement>(
    '[role="group"][aria-label="' + i18n.t("chat.recentModels") + '"] [role="menuitemradio"]',
  ));
  const recentIds = () => recentRows().map((row) => row.querySelector(".composer-model-label")?.textContent);
  if (JSON.stringify(recentIds()) !== JSON.stringify(["model-d", "model-c", "model-b"])) {
    throw new Error("The recent group must show exactly the three most recently used models in order");
  }
  if (rows().length !== 4 || !rows()[3].textContent?.includes("model-a")) {
    throw new Error("All configured models must be visible once without a disclosure step");
  }
  recentRows()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await settle();
  if (menu().querySelector(".kb-active")) throw new Error("Pointer navigation must clear stale keyboard highlight");
  const keyboardSearch = menu().querySelector<HTMLInputElement>(".composer-model-search input")!;
  keyboardSearch.focus();
  keyboardSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle();
  if (!menu().querySelector(".kb-active")) throw new Error("Arrow navigation must highlight a model");
  trigger.focus();
  keyboardSearch.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: trigger }));
  await settle();
  if (menu().querySelector(".kb-active")) throw new Error("Leaving search must clear keyboard highlight");
  flushSync(() => recentRows()[2].click());
  await settle();
  if (JSON.stringify(recentIds()) !== JSON.stringify(["model-d", "model-c", "model-b"])) {
    throw new Error("Selecting without sending must preserve actual usage order");
  }
  const switchedLevel = document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "";
  const low = menu().querySelector<HTMLButtonElement>('.composer-thinking-tick[title="low"]')!;
  if (!low) throw new Error("The selected model must offer its supported reasoning levels");
  flushSync(() => low.click());
  await settle();
  const allRows = rows();
  const recentStyle = getComputedStyle(allRows[0]);
  const otherStyle = getComputedStyle(allRows[3]);
  if (recentStyle.fontSize !== otherStyle.fontSize || recentStyle.fontWeight !== otherStyle.fontWeight) {
    throw new Error(`Model typography differs: recent ${recentStyle.fontSize}/${recentStyle.fontWeight}, other ${otherStyle.fontSize}/${otherStyle.fontWeight}`);
  }
  const search = menu().querySelector<HTMLInputElement>(".composer-model-search input")!;
  const setSearch = (value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  setSearch("model-b");
  await settle();
  if (rows().length !== 1 || !rows()[0].textContent?.includes("model-b")) {
    throw new Error("Search must narrow the configured models without duplicates");
  }
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  const restored = useAppStore.getState().recentModels;
  if (restored[0]?.modelId !== "model-d") throw new Error("Menu interactions alone must not record usage");
  setSearch("");
  flushSync(() => useAppStore.setState({ recentModels: [] }));
  await settle();
  if (rows().length !== 4 || recentRows().length !== 0) {
    throw new Error("Without history all configured models must remain directly visible");
  }
  flushSync(() => useAppStore.setState({ recentModels: restored }));
  await settle();
  return {
    model: document.querySelector(".selected-model")?.textContent?.trim() ?? "",
    switchedLevel,
    level: document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "",
    writes: [...writes],
  };
};
