import {
  fallbackBuiltinDefinitions,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

/**
 * One shipped default plus whether this installation still offers it.
 *
 * A switched-off builtin stays in the list on purpose: it has no document to
 * delete, so its row and its switch are the only way back on.
 */
export type BuiltinSubagentRow = SubagentDefinition & { enabled: boolean };

/**
 * The global documents, the selected project's documents, and the shipped
 * defaults, switched off ones included.
 */
export type SubagentPageData = {
  global: UserSubagentRecord[];
  project: UserSubagentRecord[];
  builtins: BuiltinSubagentRow[];
};

export const EMPTY_SUBAGENT_PAGE: SubagentPageData = {
  global: [],
  project: [],
  builtins: [],
};

/**
 * Settings lists three sources: the writable global directory, the selected
 * project's own directory, and the shipped defaults `Task` offers. Catalog load
 * failures must not hide the document lists, so builtins fall back to the
 * shared preset catalog — reported enabled, because a failed read cannot say
 * which handles the user turned off.
 *
 * A builtin row is listed only while it still answers for its handle on the
 * selected project: the catalog is resolved for that project, so a project
 * document that shadows `explorer` hides the shipped `explorer` exactly as a
 * global one does.
 */
export async function fetchSubagentPageData(
  projectPath?: string | null,
): Promise<SubagentPageData> {
  const [globalResult, projectResult] = await Promise.all([
    api.listUserSubagents({ level: "global" }),
    projectPath
      ? api.listUserSubagents({ level: "project", projectPath })
      : Promise.resolve({ subagents: [] as UserSubagentRecord[] }),
  ]);
  const global = globalResult.subagents ?? [];
  const project = projectResult.subagents ?? [];
  // A project document claims its handle even while switched off; a global one
  // gives it back to the builtin when it is off.
  const claimed = new Set([
    ...project.map((row) => row.id),
    ...global.filter((row) => row.enabled).map((row) => row.id),
  ]);
  try {
    const catalog = await api.subagentCatalog(projectPath ?? undefined);
    // Older main processes answer without `builtins`; derive the group from the
    // effective catalog then, which is how this page read it before builtins
    // could be switched off at all.
    const builtins =
      catalog.builtins ??
      (catalog.subagents ?? [])
        .filter((item) => item.source === "builtin")
        .map((item) => ({ ...item, enabled: true }));
    return {
      global,
      project,
      builtins: builtins.filter(
        (item) => item.source === "builtin" && !claimed.has(item.name),
      ),
    };
  } catch {
    return {
      global,
      project,
      builtins: fallbackBuiltinDefinitions()
        .map((item) => ({ ...item, enabled: true }))
        .filter((item) => !claimed.has(item.name)),
    };
  }
}
