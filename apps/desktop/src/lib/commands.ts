import i18n from "i18next";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";
import { trustedExtensionCommandName, type Mode } from "@pi-desktop/shared";

type FastModeState = Pick<
  ReturnType<typeof useAppStore.getState>,
  "activeSessionId" | "sessions" | "providerModels"
>;

/** Whether the model the next prompt will use can take the priority tier. */
export function fastModeApplies(store: FastModeState): boolean {
  const session = store.activeSessionId
    ? store.sessions.find((entry) => entry.id === store.activeSessionId)
    : undefined;
  if (!session?.providerId || !session.modelId) return false;
  return (
    store.providerModels[session.providerId]?.some(
      (model) => model.modelId === session.modelId && model.supportsPriorityTier === true,
    ) ?? false
  );
}

/**
 * First-party command execution shared by the command palette and the
 * composer "/" dispatch (D123). Builtin ids run app actions locally; other
 * ids round-trip to the plugin runtime via commandPalette/execute.
 */
export async function runPaletteCommand(commandId: string): Promise<void> {
  const store = useAppStore.getState();
  switch (commandId) {
    case "builtin.session.new":
      await store.newSession();
      break;
    case "builtin.agent.compact":
      await store.compactContext();
      break;
    case "builtin.mode.agent":
    case "builtin.mode.plan":
    case "builtin.mode.goal": {
      const mode: Mode = commandId.endsWith("plan")
        ? "plan"
        : commandId.endsWith("goal")
          ? "goal"
          : "agent";
      const activeSession = store.activeSessionId
        ? store.sessions.find((session) => session.id === store.activeSessionId)
        : undefined;
      if (activeSession) {
        await store.configureActiveSession({
          mode,
          providerId: activeSession.providerId,
          modelId: activeSession.modelId,
          thinkingLevel: activeSession.thinkingLevel,
        });
      } else if (store.settings) {
        // Keep the command useful from the empty home, where no session has
        // been created yet. The next session will inherit this default.
        const next = { ...store.settings, defaultMode: mode };
        await api.setSettings(next);
        useAppStore.setState({ settings: next });
      }
      break;
    }
    case "builtin.agent.fast": {
      // One switch for the whole app, as `/fast` is in the terminal: it stays
      // on across sessions until it is run again. A request only carries the
      // priority tier when its provider and model can take it, so turning it
      // on with another model selected is allowed and says so.
      if (!store.settings) break;
      const fastMode = store.settings.fastMode !== true;
      const next = { ...store.settings, fastMode };
      await api.setSettings(next);
      useAppStore.setState({ settings: next });
      const applies = fastModeApplies(store);
      store.showToast(
        i18n.t(
          !fastMode
            ? "chat.fastModeOff"
            : applies
              ? "chat.fastModeOn"
              : "chat.fastModeOnUnsupported",
        ),
      );
      break;
    }
    default: {
      // Trusted extension commands run inside the active session's sidecar
      // (spec 16 §8); without a session there is nothing to run them in.
      const extensionCommand = trustedExtensionCommandName(commandId);
      if (extensionCommand !== undefined) {
        await runExtensionCommand(extensionCommand, "");
        return;
      }
      await api.executeCommand(commandId);
    }
  }
}

export async function runExtensionCommand(name: string, args: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.activeSessionId) {
    throw new Error(i18n.t("plugins.agentExtension.commandNeedsSession"));
  }
  await api.runExtensionCommand({ sessionId: store.activeSessionId, name, args });
}
