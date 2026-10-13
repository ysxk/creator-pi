/** Host-owned API-key setup for a provider selected from a plugin catalog. */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  bindingFromModelInfo,
  normalizeApiStyle,
  type CatalogApiStyle,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input } from "../ui";
import { ProviderConnectionFields } from "./ProviderConnectionFields";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  API_STYLE_LABEL_KEYS,
  CUSTOM_PROVIDER_API_STYLES,
} from "./provider-api-style";

/** Styles a plugin row may be switched between, including account-only ones
 * (a proxy endpoint serves them without a vendor account). */
const PLUGIN_EDITABLE_API_STYLES: CatalogApiStyle[] = [
  ...CUSTOM_PROVIDER_API_STYLES,
  "openai_codex_responses",
];

export type PluginProviderKeySetupFormProps = {
  provider: ProviderPublic;
  pluginName: string;
  onClose: () => void;
  onSaved: (provider: ProviderPublic) => void | Promise<void>;
};

export function PluginProviderKeySetupForm({
  provider,
  pluginName,
  onClose,
  onSaved,
}: PluginProviderKeySetupFormProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const baseUrlEditable = provider.baseUrlEditable === true;
  const apiStyleEditable = provider.apiStyleEditable === true;
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    normalizeApiStyle(provider.apiStyle),
  );
  const showToast = useAppStore((state) => state.showToast);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    try {
      // Endpoint edits land first: the model discovery that follows must ask
      // the address the user actually runs, not the declared default.
      if (
        baseUrlEditable &&
        baseUrl.trim() &&
        baseUrl.trim() !== (provider.baseUrl ?? "")
      ) {
        await api.setProviderPluginEndpoint({ id: provider.id, baseUrl: baseUrl.trim() });
      }
      if (
        apiStyleEditable &&
        apiStyle !== normalizeApiStyle(provider.apiStyle)
      ) {
        await api.setProviderPluginEndpoint({ id: provider.id, apiStyle });
      }
      const result = await api.setProviderSecret({ id: provider.id, secretValue: apiKey });
      if (!result.provider) {
        showToast(t("settings.providerUnavailable"), { variant: "error" });
        return;
      }
      let savedProvider = result.provider;
      let modelDiscoveryMessage: string | null = null;
      try {
        const discovery = await api.listProviderModels({
          providerId: provider.id,
          source: "refresh",
        });
        if (discovery.source === "remote" && discovery.models.length > 0) {
          savedProvider = {
            ...savedProvider,
            models: discovery.models.map(bindingFromModelInfo),
          };
        } else {
          modelDiscoveryMessage = t("settings.modelsFetchNotFound");
        }
      } catch {
        modelDiscoveryMessage = t("settings.modelsFetchFailed");
      }
      await onSaved(savedProvider);
      if (modelDiscoveryMessage) {
        showToast(modelDiscoveryMessage, { variant: "warning" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {t("settings.addProviderTitle")}
        </h3>
        <div className="provider-setup-head-actions">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !apiKey.trim()}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.saveProvider")}
          </Button>
        </div>
      </div>

      <div className="provider-setup-body">
        <div className="text-sm text-text-secondary">
          {t("settings.pluginProviderBy", { plugin: pluginName })}
        </div>
        <ProviderConnectionFields
          named
          custom={false}
          editing={false}
          saving={saving}
          serviceLabel={provider.name}
          serviceBaseUrl={baseUrl.trim() || (provider.baseUrl ?? "")}
          apiKeyHint={t("settings.pluginProviderKeyHint")}
          lockedService
          onChangeService={() => {}}
          apiKeyRef={apiKeyRef}
          nameRef={nameRef}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          authKind="api_key_and_base_url"
          onAuthKindChange={() => {}}
          name={provider.name}
          onNameChange={() => {}}
          baseUrl={provider.baseUrl ?? ""}
          onBaseUrlChange={() => {}}
          commitBaseUrl={() => {}}
          apiStyle={normalizeApiStyle(provider.apiStyle)}
          onApiStyleChange={() => {}}
          accountOnlyApiStyle={false}
          requiresApiStyleChoice={false}
        />
        {baseUrlEditable || apiStyleEditable ? (
          <div className="provider-setup-field-row">
            {baseUrlEditable ? (
              <div className="provider-setup-base-url">
                <Field
                  label={t("settings.pluginProviderEndpoint")}
                  hint={t("settings.pluginProviderEndpointHint")}
                >
                  <Input
                    value={baseUrl}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    className="font-mono text-sm-plus"
                    placeholder="http://127.0.0.1:8317/v1"
                    disabled={saving}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}
            {apiStyleEditable ? (
              <Field label={t("settings.apiStyle")}>
                <SettingsMenuSelect
                  fullWidth
                  label={t("settings.apiStyle")}
                  value={apiStyle}
                  disabled={saving}
                  onChange={(id) => setApiStyle(id as CatalogApiStyle)}
                  options={PLUGIN_EDITABLE_API_STYLES.map((style) => ({
                    id: style,
                    label: t(API_STYLE_LABEL_KEYS[style]),
                  }))}
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
