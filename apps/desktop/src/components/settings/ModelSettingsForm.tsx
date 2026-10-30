import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  THINKING_LEVELS,
  bindingDefaultThinkingMenuLevels,
  modelMatchesFilter,
  modelSettingSource,
  nativeWebSearchSupportedOn,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
  type ModelBinding,
  type ModelInfo,
  type ModelSettingField,
  type ModelSettingsValues,
  type SessionThinkingLevel,
  type ThinkingLevel,
  type ThinkingProtocol,
} from "@pi-desktop/shared";
import {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  matchPresetIndex,
} from "../../lib/model-limit-presets";
import { Button, Checkbox, HelpIcon, Input, Textarea, Tooltip, TooltipButton, cx } from "../ui";
import { IconHelp } from "../icons";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export type ModelSettingsFormProps = {
  imageModelSelected?: boolean;
  onImageModelChange?: (selected: boolean) => void;
  binding: ModelBinding;
  values: ModelSettingsValues;
  info?: ModelInfo;
  scope?: "model" | "channel";
  onChange: (set: ModelSettingsValues, unset?: ModelSettingField[]) => void;
  disabled?: boolean;
  apiStyle?: string;
  baseUrl?: string;
};

export function ModelSettingsForm({
  binding,
  values,
  info,
  scope = "channel",
  onChange,
  disabled = false,
  apiStyle,
  baseUrl,
  imageModelSelected = false,
  onImageModelChange,
}: ModelSettingsFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const explicit = (key: ModelSettingField) => Object.hasOwn(values, key);
  const source = (key: ModelSettingField) =>
    explicit(key) ? scope : binding.settings ? modelSettingSource(binding.settings, key) : "catalog";

  const effective = (key: ModelSettingField) => {
    const value = binding[key] ?? binding.settings?.baseline[key];
    if (value === undefined || value === null || value === "") return t("settings.modelPrefs.none");
    if (typeof value === "boolean") return t(value ? "settings.modelPrefs.on" : "settings.modelPrefs.off");
    return Array.isArray(value) ? value.join(", ") || t("settings.modelPrefs.none") : String(value);
  };

  const levelChoices = THINKING_LEVELS;
  const enabledLevels = sortThinkingLevels(binding.thinkingLevels);
  const publishedLevels = info?.supportedThinkingLevels ?? [];

  const publishedImages = info ? modelMatchesFilter(info, "vision") : false;
  const publishedVideos = info
    ? info.capabilities.includes("video") ||
      (info.modalities?.input?.includes("video") ?? false)
    : false;
  const publishedAudio = info
    ? info.modalities
      ? info.modalities.input.includes("audio")
      : info.capabilities.includes("audio")
    : false;
  const publishedDocuments = info ? modelMatchesFilter(info, "pdf") : false;

  const followsCatalog =
    binding.contextWindowSource !== "user" && info?.limit?.context !== undefined;

  const nativeWebSearchWireCapable =
    scope === "model" || nativeWebSearchSupportedOn(apiStyle, baseUrl);

  const resetBtn = (key: ModelSettingField, label: string) => (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled || !explicit(key)}
      aria-label={t("settings.modelPrefs.resetField", { field: label })}
      onClick={() => onChange({}, [key])}
    >
      {t("settings.modelPrefs.inherit")}
    </Button>
  );

  const sourceNotice = (key: ModelSettingField) => (
    <div className="model-pref-source" aria-live="polite">
      {t(explicit(key) ? "settings.modelPrefs.explicit" : "settings.modelPrefs.inherited")}
      {" · "}
      {t(`settings.modelPrefs.source.${source(key)}`)}
      {key !== "systemPrompt" && <span className="model-pref-effective">{effective(key)}</span>}
    </div>
  );

  const promptMode = !explicit("systemPrompt")
    ? "inherit"
    : values.systemPrompt === ""
      ? "disabled"
      : "custom";

  return (
    <div className="model-settings-form">
      <div className="model-pref-field" data-model-field="alias">
        <label className="provider-chosen-field">
          <span className="provider-chosen-field-label">
            <span>{t("settings.modelAlias")}</span>
            <HelpIcon label={t("settings.modelAliasHint")} />
            {resetBtn("alias", t("settings.modelAlias"))}
          </span>
          <Input
            id={`${id}-alias`}
            value={binding.alias ?? ""}
            placeholder={t("settings.modelAliasPlaceholder")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={disabled}
            onChange={(event) =>
              onChange({ alias: [...event.target.value].slice(0, 60).join("") })
            }
          />
        </label>
        {sourceNotice("alias")}
      </div>

      <div className="provider-chosen-limits">
        <div className="model-pref-field" data-model-field="contextWindow">
          <label className="provider-chosen-field">
            <span className="provider-chosen-field-label">
              <span>{t("settings.contextWindow")}</span>
              {followsCatalog ? <HelpIcon label={t("settings.contextWindowCatalogHint")} /> : null}
              {resetBtn("contextWindow", t("settings.contextWindow"))}
            </span>
            <div
              className="provider-limit-presets"
              role="group"
              aria-label={t("settings.contextWindow")}
            >
              {CONTEXT_WINDOW_PRESETS.map((preset, index) => {
                const on =
                  matchPresetIndex(CONTEXT_WINDOW_PRESETS, binding.contextWindow) === index;
                return (
                  <TooltipButton
                    key={preset.label}
                    type="button"
                    className={cx("provider-thinking-chip", on && "selected")}
                    ariaLabel={preset.label}
                    tooltip={preset.label}
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => onChange({ contextWindow: preset.tokens })}
                  >
                    {preset.label}
                  </TooltipButton>
                );
              })}
            </div>
            <Input
              id={`${id}-contextWindow`}
              type="number"
              min={1}
              inputMode="numeric"
              value={binding.contextWindow}
              disabled={disabled}
              onChange={(event) => {
                const num = Number(event.target.value) || 0;
                if (num > 0) onChange({ contextWindow: num });
              }}
            />
          </label>
          {sourceNotice("contextWindow")}
        </div>

        <div className="model-pref-field" data-model-field="maxTokens">
          <label className="provider-chosen-field">
            <span className="provider-chosen-field-label">
              <span>{t("settings.maxOutput")}</span>
              {resetBtn("maxTokens", t("settings.maxOutput"))}
            </span>
            <div
              className="provider-limit-presets"
              role="group"
              aria-label={t("settings.maxOutput")}
            >
              {MAX_OUTPUT_PRESETS.map((preset, index) => {
                const on = matchPresetIndex(MAX_OUTPUT_PRESETS, binding.maxTokens) === index;
                return (
                  <TooltipButton
                    key={preset.label}
                    type="button"
                    className={cx("provider-thinking-chip", on && "selected")}
                    ariaLabel={preset.label}
                    tooltip={preset.label}
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => onChange({ maxTokens: preset.tokens })}
                  >
                    {preset.label}
                  </TooltipButton>
                );
              })}
            </div>
            <Input
              id={`${id}-maxTokens`}
              type="number"
              min={1}
              inputMode="numeric"
              value={binding.maxTokens}
              disabled={disabled}
              onChange={(event) => {
                const num = Number(event.target.value) || 0;
                if (num > 0) onChange({ maxTokens: num });
              }}
            />
          </label>
          {sourceNotice("maxTokens")}
        </div>
      </div>

      <div className="provider-chosen-thinking">
        <div className="provider-chosen-thinking-head">
          <span className="provider-chosen-thinking-label">
            <span>{t("settings.supportedThinkingLevels")}</span>
            {publishedLevels.length === 0 ? (
              <HelpIcon label={t("settings.thinkingManualOverrideHint")} />
            ) : null}
            {resetBtn("thinkingLevels", t("settings.supportedThinkingLevels"))}
          </span>
          <div className="provider-chosen-thinking-controls">
            <div className="provider-chosen-thinking-protocol">
              <span className="provider-chosen-thinking-label">
                <span>{t("settings.thinkingProtocol")}</span>
                {resetBtn("thinkingProtocol", t("settings.thinkingProtocol"))}
              </span>
              <SettingsMenuSelect
                className="provider-chosen-thinking-select"
                label={t("settings.thinkingProtocol")}
                disabled={disabled}
                value={binding.thinkingProtocol ?? info?.thinkingProtocol ?? "legacy"}
                onChange={(id) => onChange({ thinkingProtocol: id as ThinkingProtocol })}
                options={[
                  { id: "legacy", label: t("settings.thinkingProtocolLegacy") },
                  { id: "adaptive", label: t("settings.thinkingProtocolAdaptive") },
                ]}
              />
            </div>
            {bindingDefaultThinkingMenuLevels(enabledLevels).length > 1 ? (
              <div className="provider-chosen-thinking-default">
                <span className="provider-chosen-thinking-label">
                  <span>{t("settings.defaultThinkingLevel")}</span>
                  {resetBtn("defaultThinkingLevel", t("settings.defaultThinkingLevel"))}
                </span>
                <SettingsMenuSelect
                  className="provider-chosen-thinking-select"
                  label={t("settings.defaultThinkingLevel")}
                  disabled={disabled}
                  value={
                    resolveBindingDefaultThinkingLevel(
                      binding.defaultThinkingLevel,
                      enabledLevels,
                    ) ?? ""
                  }
                  onChange={(id) =>
                    onChange({
                      defaultThinkingLevel: id as SessionThinkingLevel || null,
                    })
                  }
                  options={bindingDefaultThinkingMenuLevels(enabledLevels).map((level) => ({
                    id: level,
                    label: level,
                  }))}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div
          className="provider-chosen-thinking-chips"
          role="group"
          aria-label={t("settings.supportedThinkingLevels")}
        >
          {levelChoices.map((level) => {
            const on = binding.thinkingLevels.includes(level);
            return (
              <TooltipButton
                key={level}
                type="button"
                className={cx("provider-thinking-chip", on && "selected")}
                ariaLabel={level}
                tooltip={level}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => {
                  const next: ThinkingLevel[] = on
                    ? binding.thinkingLevels.filter((entry) => entry !== level)
                    : [...binding.thinkingLevels, level];
                  onChange({
                    thinkingLevels: next,
                    defaultThinkingLevel: resolveBindingDefaultThinkingLevel(
                      binding.defaultThinkingLevel,
                      sortThinkingLevels(next),
                    ),
                  });
                }}
              >
                {level}
              </TooltipButton>
            );
          })}
        </div>
        {sourceNotice("thinkingLevels")}
      </div>

      <div className="provider-chosen-capabilities">
        <span className="provider-chosen-thinking-label">
          {t("settings.modelCapabilities")}
        </span>
        <div className="provider-chosen-capability-rows">
          <CapabilityToggle
            label={t("settings.imageInput")}
            published={publishedImages}
            value={binding.supportsImages}
            onChange={(next) => onChange({ supportsImages: next })}
          />
          <CapabilityToggle
            label={t("settings.videoInput")}
            published={publishedVideos}
            value={binding.supportsVideos}
            onChange={(next) => onChange({ supportsVideos: next })}
          />
          <CapabilityToggle
            label={t("settings.audioInput")}
            published={publishedAudio}
            value={binding.supportsAudio}
            onChange={(next) => onChange({ supportsAudio: next })}
          />
          <CapabilityToggle
            label={t("settings.documentInput")}
            published={publishedDocuments}
            value={binding.supportsDocuments}
            onChange={(next) => onChange({ supportsDocuments: next })}
          />
          {onImageModelChange ? (
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={imageModelSelected}
                disabled={disabled}
                aria-label={t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
                onChange={(event) => onImageModelChange(event.target.checked)}
              />
              <span>
                {t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
              </span>
            </label>
          ) : null}

          <span className="provider-chosen-delegation">
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={binding.availableForSubagents ?? false}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ availableForSubagents: event.target.checked })
                }
              />
              <span>{t("settings.availableForSubagents")}</span>
            </label>
            <Tooltip
              className="provider-chosen-delegation-help"
              label={t("settings.availableForSubagentsHint")}
              ariaLabel={t("settings.availableForSubagentsHint")}
            >
              <IconHelp size={13} />
            </Tooltip>
            {resetBtn("availableForSubagents", t("settings.availableForSubagents"))}
          </span>

          <span className="provider-chosen-delegation">
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={binding.nativeWebSearch === true}
                disabled={disabled || !nativeWebSearchWireCapable}
                onChange={(event) =>
                  onChange({ nativeWebSearch: event.target.checked })
                }
              />
              <span>{t("settings.nativeWebSearch")}</span>
            </label>
            <Tooltip
              className="provider-chosen-delegation-help"
              label={t(
                nativeWebSearchWireCapable
                  ? "settings.nativeWebSearchHint"
                  : "settings.nativeWebSearchUnsupported",
              )}
              ariaLabel={t(
                nativeWebSearchWireCapable
                  ? "settings.nativeWebSearchHint"
                  : "settings.nativeWebSearchUnsupported",
              )}
            >
              <IconHelp size={13} />
            </Tooltip>
            {resetBtn("nativeWebSearch", t("settings.nativeWebSearch"))}
          </span>
        </div>
      </div>

      <div className="model-pref-field" data-model-field="systemPrompt">
        <div className="model-pref-label">
          <label htmlFor={`${id}-systemPrompt`}>{t("settings.modelPrefs.prompt")}</label>
          {resetBtn("systemPrompt", t("settings.modelPrefs.prompt"))}
        </div>
        <SettingsMenuSelect
          label={t("settings.modelPrefs.promptMode")}
          value={promptMode}
          disabled={disabled}
          fullWidth
          options={[
            { id: "inherit", label: t("settings.modelPrefs.inherit") },
            { id: "custom", label: t("settings.modelPrefs.customPrompt") },
            { id: "disabled", label: t("settings.modelPrefs.disabledPrompt") },
          ]}
          onChange={(mode) =>
            mode === "inherit"
              ? onChange({}, ["systemPrompt"])
              : onChange({ systemPrompt: mode === "disabled" ? "" : binding.systemPrompt || " " })
          }
        />
        {promptMode === "custom" && (
          <Textarea
            id={`${id}-systemPrompt`}
            aria-label={t("settings.modelPrefs.prompt")}
            rows={5}
            value={values.systemPrompt ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        )}
        {promptMode === "inherit" && binding.systemPrompt && (
          <p className="model-pref-prompt selectable">{binding.systemPrompt}</p>
        )}
        <p className="model-pref-source">{t("settings.modelPrefs.promptHint")}</p>
        {sourceNotice("systemPrompt")}
      </div>
    </div>
  );
}

type CapabilityToggleProps = {
  label: string;
  published: boolean;
  value: boolean | null | undefined;
  onChange: (next: boolean) => void;
};

function CapabilityToggle({ label, published, value, onChange }: CapabilityToggleProps) {
  const effective = typeof value === "boolean" ? value : published;
  return (
    <label className="provider-chosen-capability">
      <input
        type="checkbox"
        checked={effective}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
