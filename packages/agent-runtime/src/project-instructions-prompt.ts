import type { ProjectInstruction, ProjectInstructions } from "./project-instructions.js";

export function projectInstructionsPrompt(
  instructions?: ProjectInstructions,
  modelPrompt?: string,
): string | undefined {
  const entries = instructions?.entries ?? [];
  const prompt = modelPrompt?.trim();
  if (!entries.length && !prompt) return undefined;
  const isGlobal = (entry: ProjectInstruction) =>
    entry.scope === "global" ||
    (entry.scope === undefined && entry.source === "~/.pi/agent/AGENTS.md");
  const ordered = prompt
    ? [
        ...entries.filter(isGlobal),
        { source: "Model instructions", content: prompt },
        ...entries.filter((entry) => !isGlobal(entry)),
      ]
    : entries;
  return [
    "# Project instructions",
    "",
    "The following instructions are loaded by PI-Desktop. Follow them when they apply to the task; entries later in this section are closer to the file being worked on and take precedence.",
    "",
    ...ordered.flatMap((entry) => [
      `## ${entry.source}`,
      "",
      entry.content,
      "",
    ]),
  ].join("\n").trimEnd();
}
