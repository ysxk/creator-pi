import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { modelSettingsKey, type ModelBinding, type ModelSettingsSnapshot, type ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { requestSettingsNavigation } from "../../lib/settings-navigation-guard";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { ModelSettingsEditor } from "./ModelSettingsEditor";
import { ModelImageSettings } from "./ModelImageSettings";
import "../../styles/model-settings.css";

type ModelGroup = { key: string; id: string; channels: { provider: ProviderPublic; binding: ModelBinding }[] };

export function ModelConfigPage() {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("");
  const [selection, setSelection] = useState({ key: "", scope: "" });
  const revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const current = await api.getModelSettings();
      if (request === revision.current) setSnapshot(current);
    } catch (cause) {
      if (request === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => { revision.current++; }; }, [load]);
  const groups = useMemo(() => {
    const map = new Map<string, ModelGroup>();
    for (const provider of providers) for (const binding of provider.models ?? []) {
      const key = modelSettingsKey(binding.id);
      let group = map.get(key);
      if (!group) { group = { key, id: binding.id, channels: [] }; map.set(key, group); }
      group.channels.push({ provider, binding });
    }
    return [...map.values()];
  }, [providers]);
  const filtered = groups.filter((group) => {
    const needle = query.trim().toLowerCase();
    return (!channel || group.channels.some((entry) => entry.provider.id === channel)) &&
      (!needle || group.id.toLowerCase().includes(needle) || group.channels.some((entry) => entry.binding.alias?.toLowerCase().includes(needle)));
  });
  const selected = groups.find((group) => group.key === selection.key) ?? groups[0];
  const activeChannel = selected?.channels.find((entry) => entry.provider.id === selection.scope);
  const goChannels = () => requestSettingsNavigation(() => useAppStore.getState().setSettingsTab("providers"));
  const select = (key: string, scope = "") => {
    if (selected?.key === key && selection.scope === scope) return;
    requestSettingsNavigation(() => setSelection({ key, scope }));
  };
  return <div className="settings-stack models-settings-page">
    <ModelImageSettings />
    {loading ? <p role="status">{t("common.loading")}</p> : error ? <div className="settings-panel model-pref-empty">
      <p role="alert" className="selectable">{error}</p>
      <Button variant="secondary" onClick={() => void load()}>{t("settings.modelPrefs.retryRead")}</Button>
    </div> : groups.length === 0 ? <div className="settings-panel model-pref-empty">
      <h3 className="settings-card-heading">{t("settings.modelPrefs.empty")}</h3>
      <Button variant="secondary" onClick={goChannels}>{t("settings.modelPrefs.manageChannels")}</Button>
    </div> : snapshot && <>
      <div className="model-pref-toolbar">
        <Input aria-label={t("settings.modelPrefs.search")} placeholder={t("settings.modelPrefs.search")}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <SettingsMenuSelect label={t("settings.modelPrefs.filterChannel")} value={channel}
          options={[{ id: "", label: t("settings.modelPrefs.allChannels") }, ...providers.filter((provider) => provider.models?.length).map((provider) => ({ id: provider.id, label: provider.name }))]}
          onChange={setChannel} />
      </div>
      <div className="model-pref-workspace">
        <nav className="model-pref-list" aria-label={t("settings.models")}>
          <div className="model-pref-list-count">{t("settings.modelPrefs.modelCount", { count: filtered.length })}</div>
          {filtered.length === 0 ? <p role="status" className="model-pref-empty">{t("settings.noModelMatches")}</p> : filtered.map((group) => <Button
            key={group.key} variant="ghost" className="model-pref-list-item" aria-current={selected?.key === group.key ? "true" : undefined}
            onClick={() => select(group.key)}>
            <span className="model-pref-list-name">{snapshot.defaults[group.key]?.alias || group.channels.find((entry) => entry.binding.alias)?.binding.alias || group.id}</span>
            <span className="model-pref-list-id font-mono selectable">{group.id}</span>
            <span className="model-pref-source">{group.channels.map((entry) => entry.provider.name).join(" · ")}</span>
          </Button>)}
        </nav>
        {selected && <section className="model-pref-detail" aria-label={selected.id}>
          <header className="model-pref-detail-head">
            <h3 className="settings-card-heading selectable">{selected.id}</h3>
            <div className="model-pref-channel-badges">{selected.channels.map(({ provider }) => <Badge key={provider.id}>{provider.name}</Badge>)}</div>
            <SettingsMenuSelect label={t("settings.modelPrefs.scope")} value={activeChannel?.provider.id ?? ""} fullWidth
              options={[{ id: "", label: t("settings.modelPrefs.defaults") }, ...selected.channels.map(({ provider }) => ({ id: provider.id, label: t("settings.modelPrefs.channelScope", { name: provider.name }) }))]}
              onChange={(scope) => select(selected.key, scope)} />
            <p className="model-pref-source">{t(activeChannel ? "settings.modelPrefs.channelHint" : "settings.modelPrefs.defaultsHint")}</p>
          </header>
          <ModelSettingsEditor key={`${selected.key}\u0000${activeChannel?.provider.id ?? ""}`}
            binding={activeChannel?.binding ?? selected.channels[0]!.binding} provider={activeChannel?.provider}
            snapshot={snapshot} onSaved={setSnapshot} />
        </section>}
      </div>
      <div className="model-pref-footer"><Button variant="ghost" onClick={goChannels}>{t("settings.modelPrefs.manageChannels")}</Button></div>
    </>}
  </div>;
}
