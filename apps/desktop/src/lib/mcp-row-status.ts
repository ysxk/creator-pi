import type { AgentCapabilityLevel, McpServerRecord, McpServerStatus } from "@pi-desktop/shared";

/**
 * Which status a row on the MCP settings page may show. The page lists every
 * project's servers, but connection status only exists for the runtime of
 * the project that is open (`statusProjectPath`); a server of the same name in
 * another project must not borrow it. Test and sign-in results of a row the
 * runtime does not run are kept per row instead.
 */
export type McpStatusView = {
  /** Statuses reported by the open project's MCP runtime. */
  statuses: readonly McpServerStatus[];
  /** The project that runtime belongs to; null when no project is open. */
  statusProjectPath: string | null;
  /**
   * Ids of the project-level servers the open project defines, reported with
   * the statuses. It must not be read from the page's own lists: those are
   * filtered to the projects the user picked, which may leave the open one out.
   */
  statusProjectServerIds: readonly string[];
  /** Results of test / sign-in on rows the runtime does not run. */
  rowStatuses: Readonly<Record<string, McpServerStatus>>;
};

/** Project paths compare without a trailing separator. */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  return Boolean(a) && Boolean(b) && trim(a!) === trim(b!);
}

/** A row is one server at one level, in one project for project servers. */
export function mcpRowKey(level: AgentCapabilityLevel, id: string, projectPath?: string): string {
  return level === "project" ? `${level}:${projectPath ?? ""}:${id}` : `${level}:${id}`;
}

/**
 * Whether the open project's runtime is running this row. A project server
 * shadows a global one of the same id, so the global row is the runtime's only
 * while the open project has no server of that id.
 */
export function mcpRowIsRuntimeOwned(
  view: Pick<McpStatusView, "statusProjectPath" | "statusProjectServerIds">,
  id: string,
  level: AgentCapabilityLevel,
  projectPath?: string,
): boolean {
  if (level === "project") {
    return samePath(projectPath, view.statusProjectPath);
  }
  if (!view.statusProjectPath) return true;
  return !view.statusProjectServerIds.includes(id);
}

export function mcpRowStatus(
  view: McpStatusView,
  server: Pick<McpServerRecord, "id">,
  level: AgentCapabilityLevel,
  projectPath?: string,
): McpServerStatus | undefined {
  const own = view.rowStatuses[mcpRowKey(level, server.id, projectPath)];
  if (own) return own;
  if (!mcpRowIsRuntimeOwned(view, server.id, level, projectPath)) return undefined;
  return view.statuses.find((status) => status.serverId === server.id);
}
