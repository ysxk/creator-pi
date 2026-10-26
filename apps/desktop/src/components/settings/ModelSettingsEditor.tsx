import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  modelSettingsKey, modelSettingsPatch, resolveModelBinding, withInheritedModelSettings,
  type ModelBinding, type ModelSettingField, type ModelSettingsSnapshot, type ModelSettingsValues, type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { ModelSettingsForm } from "./ModelSettingsForm";
import { useModelSettingsGuard } from "./useModelSettingsGuard";

export function ModelSettingsEditor({ binding, provider, snapshot, onSaved }: {
  binding: ModelBinding;
  provider?: ProviderPublic;
  snapshot: ModelSettingsSnapshot;
  onSaved: (snapshot: ModelSettingsSnapshot) => void;
}) {
  const { t } = useTranslation();
  const key = modelSettingsKey(binding.id);
  const readValues = (current: ModelSettingsSnapshot) => provider
    ? current.channels[provider.id]?.[key] ?? {} : current.defaults[key] ?? {};
  const [before, setBefore] = useState(() => readValues(snapshot));
  const [draft, setDraft] = useState(before);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  const saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const patch = modelSettingsPatch(before, draft);
  const dirty = patch.unset.length > 0 || Object.keys(patch.set).length > 0;
  const { confirmation } = useModelSettingsGuard(dirty, busy);
  const layers = withInheritedModelSettings(binding).settings!;
  const effective = resolveModelBinding({ ...binding, settings: {
    baseline: layers.baseline,
    defaults: provider ? snapshot.defaults[key] ?? {} : draft,
    overrides: provider ? draft : {},
  } });
  const change = (set: ModelSettingsValues, unset: ModelSettingField[] = []) => {
    setDraft((current) => {
      const next = { ...current, ...set };
      for (const field of unset) delete next[field];
      return next;
    });
    setSaved(false);
  };
  const save = async () => {
    if (saving.current || !dirty) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await api.updateModelSettings({ modelId: binding.id, ...(provider ? { providerId: provider.id } : {}), ...modelSettingsPatch(before, draft) });
      if (mounted.current) {
        const values = readValues(current);
        setBefore(values);
        setDraft(values);
        setSaved(true);
        onSaved(current);
      }
      await useAppStore.getState().refreshProviders();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <>
    <ModelSettingsForm binding={effective} values={draft} scope={provider ? "channel" : "model"}
      disabled={busy} apiStyle={provider?.apiStyle} baseUrl={provider?.baseUrl} onChange={change} />
    {error && <p role="alert" className="model-pref-error selectable">{error}</p>}
    <div className="model-pref-actions">
      <span role="status" className="model-pref-source">{dirty ? t("settings.modelPrefs.unsaved") : saved ? t("settings.modelPrefs.saved") : ""}</span>
      <Button variant="secondary" disabled={busy || !dirty} onClick={() => { setDraft(before); setError(""); setSaved(false); }}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
        {busy ? t("common.saving") : error ? t("settings.modelPrefs.retrySave") : t("common.save")}
      </Button>
    </div>
    {confirmation}
  </>;
}
