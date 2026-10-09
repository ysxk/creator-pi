import { useTranslation } from "react-i18next";
import { globalSubagentsInProjectPolicy, type AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

/**
 * What shipped and global subagents do inside a project.
 *
 * Two switches, because they answer different questions: whether a project
 * session may delegate to them at all, and — when it may — whether the `@`
 * panel lists them. Turning the first off makes the second moot, so it is
 * shown off and locked instead of keeping a state that does nothing.
 */
export function ProjectSubagentPolicyCard() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  if (!settings) return null;
  const policy = globalSubagentsInProjectPolicy(settings);

  const save = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    try {
      await api.setSettings(next);
      useAppStore.setState({ settings: next });
    } catch (error) {
      showToast((error as Error)?.message || String(error));
    }
  };

  return (
    <SettingsCard title={t("settings.projectGlobalSubagents")}>
      <SettingsRow
        title={t("settings.projectGlobalSubagentsAvailable")}
        description={t("settings.projectGlobalSubagentsAvailableDesc")}
      >
        <SettingsToggle
          checked={policy.available}
          label={t("settings.projectGlobalSubagentsAvailable")}
          onChange={() => void save({ globalSubagentsInProjects: !policy.available })}
        />
      </SettingsRow>
      <SettingsRow
        title={t("settings.projectGlobalSubagentsShown")}
        description={t("settings.projectGlobalSubagentsShownDesc")}
      >
        <SettingsToggle
          checked={policy.listed}
          disabled={!policy.available}
          label={t("settings.projectGlobalSubagentsShown")}
          onChange={() => void save({ showGlobalSubagentsInProjects: !policy.listed })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
