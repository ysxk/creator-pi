import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageGenerationBinding } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { imageGenerationPickerCandidates, isImageGenerationPickerCandidate } from "./image-generation-default";
import { ImageGenerationModelRow } from "./ImageGenerationModelRow";

export function ModelImageSettings() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const [busy, setBusy] = useState(false);
  const setDefault = async (binding: ImageGenerationBinding) => {
    setBusy(true);
    try {
      const current = await api.getSettings();
      const candidates = imageGenerationPickerCandidates(current.imageGenerationModels, current.imageGeneration, providers);
      if (!isImageGenerationPickerCandidate(candidates, binding.providerId, binding.modelId)) return;
      const nextSettings = { ...current, imageGeneration: binding };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      useAppStore.getState().showToast(t("settings.imageModelSelected"), { variant: "success" });
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally { setBusy(false); }
  };
  if (!settings || imageGenerationPickerCandidates(settings.imageGenerationModels, settings.imageGeneration, providers).length === 0) return null;
  return <div className="settings-panel model-default-panel">
    <ImageGenerationModelRow settings={settings} providers={providers} busy={busy} onChange={(binding) => void setDefault(binding)} />
  </div>;
}
