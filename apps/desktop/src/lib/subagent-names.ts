import type { TFunction } from "i18next";
import type { SubagentDefinition } from "@pi-desktop/shared";

/**
 * Localized copy for the subagents PI-Desktop ships. A definition's own
 * `description` is written for the model, in English; these are the same
 * delegates described for the person choosing one. A user's or a project's
 * subagent has no catalog entry and is shown as its author wrote it.
 */
const SHIPPED_COPY: Record<string, { name: string; desc: string }> = {
  explorer: { name: "presetExplorerName", desc: "presetExplorerDesc" },
  "code-reviewer": { name: "presetReviewerName", desc: "presetReviewerDesc" },
  "test-runner": { name: "presetTestRunnerName", desc: "presetTestRunnerDesc" },
  fixer: { name: "presetFixerName", desc: "presetFixerDesc" },
  "ui-designer": { name: "presetUiDesignerName", desc: "presetUiDesignerDesc" },
};

/** The name to show for a handle; the handle itself when it is not shipped. */
export function subagentDisplayName(t: TFunction, handle: string): string {
  if (!handle) return t("chat.subagentUnnamed");
  const copy = SHIPPED_COPY[handle];
  return copy ? t(`extensions.subagents.${copy.name}`) : handle;
}

/** What a subagent is for, localized when it is an unmodified shipped one. */
export function subagentDisplayDescription(
  t: TFunction,
  definition: Pick<SubagentDefinition, "name" | "description" | "source">,
): string {
  const copy = definition.source === "builtin" ? SHIPPED_COPY[definition.name] : undefined;
  return copy ? t(`extensions.subagents.${copy.desc}`) : definition.description;
}

/** How far a subagent's tool grant reaches, as the catalog key that says so. */
export function subagentReachKey(
  definition: Pick<SubagentDefinition, "tools" | "inheritTools">,
): "chat.atAgentCanEdit" | "chat.atAgentCanRun" | "chat.atAgentReadOnly" {
  if (definition.inheritTools) return "chat.atAgentCanEdit";
  if (definition.tools.some((tool) => tool === "Edit" || tool === "Write")) {
    return "chat.atAgentCanEdit";
  }
  return definition.tools.includes("Bash") ? "chat.atAgentCanRun" : "chat.atAgentReadOnly";
}
