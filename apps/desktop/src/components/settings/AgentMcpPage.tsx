import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type McpServerRecord,
  type McpServerStatus,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
import {
  AgentCapabilityPage,
  AgentProjectPicker,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  projectDisplayName,
  useAgentProjects,
  useArmedDelete,
  type CapabilityFilter,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import {
  draftFromRecord,
  draftToInput,
  emptyMcpDraft,
  McpEditorSheet,
  type McpDraft,
} from "../extensions/McpEditorSheet";
import { McpMarketPanel } from "./McpMarketPanel";
import { AgentMcpImportPanel } from "../../features/settings/imports/AgentMcpImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";
import {
  mcpRowIsRuntimeOwned,
  mcpRowKey,
  mcpRowStatus,
  type McpStatusView,
} from "../../lib/mcp-row-status";
import {
  IconArrowUpDown,
  IconKey,
  IconPencil,
  IconPlay,
  IconPlus,
  IconServer,
  IconTerminal,
  IconTrash,
} from "../icons";
import { TooltipButton, cx } from "../ui";

const GLOBAL_MCP_PATH = "~/.agents/servers";

function projectMcpPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/servers` : "<project-root>/.agents/servers";
}


type McpEditorState = {
  draft: McpDraft;
  editing: McpServerRecord | null;
  level: AgentCapabilityLevel;
  /** The project a project-level server lives in; unset for global. */
  projectPath?: string;
};

/** One project's own servers, listed under that project's group header. */
type McpProjectGroup = {
  projectPath: string;
  servers: McpServerRecord[];
};

type McpCollection = {
  global: McpServerRecord[];
  projects: McpProjectGroup[];
  statuses: McpServerStatus[];
  /** The open project whose runtime reported `statuses`. */
  statusProjectPath: string | null;
};

const EMPTY_MCP_COLLECTION: McpCollection = {
  global: [],
  projects: [],
  statuses: [],
  statusProjectPath: null,
};

export function AgentMcpPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  // No selected project means every project: the page lists each recent
  // project's own servers until the user narrows it to one.
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects({
    allProjects: true,
  });
  const listedProjectPaths = useMemo(
    () => (selectedProjectPath ? [selectedProjectPath] : options.map((project) => project.path)),
    [options, selectedProjectPath],
  );
  const fetchServers = useCallback(async (): Promise<McpCollection> => {
    const [global, ...projects] = await Promise.all([
      api.listMcpServers({
        level: "global",
        ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
      }),
      ...listedProjectPaths.map((projectPath) =>
        api.listMcpServers({ level: "project", projectPath }),
      ),
    ]);
    return {
      global: global.servers ?? [],
      projects: listedProjectPaths.map((projectPath, index) => ({
        projectPath,
        servers: projects[index]?.servers ?? [],
      })),
      // Status comes from the open window's runtime, so every list call
      // returns the same set; the global call's copy is enough.
      statuses: global.statuses ?? [],
      statusProjectPath: global.statusProjectPath ?? null,
    };
  }, [listedProjectPaths, selectedProjectPath]);
  const {
    data: { global: globalServers, projects: projectGroups, statuses, statusProjectPath },
    setData: setServers,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchServers, EMPTY_MCP_COLLECTION, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const setStatuses = (update: (current: McpServerStatus[]) => McpServerStatus[]) =>
    setServers((current) => ({ ...current, statuses: update(current.statuses) }));
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Test and sign-in results of rows the open project's runtime does not run.
  const [rowStatuses, setRowStatuses] = useState<Record<string, McpServerStatus>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<McpEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const pendingOAuthRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    return () => {
      pendingOAuthRef.current?.unsubscribe();
      pendingOAuthRef.current = null;
    };
  }, []);
  const [view, setView] = useState<"servers" | "market">("servers");
  const { armed, setArmed } = useArmedDelete();

  const projectServers = useMemo(
    () => projectGroups.flatMap((group) => group.servers),
    [projectGroups],
  );
  const rowKey = mcpRowKey;
  const statusView: McpStatusView = useMemo(
    () => ({
      statuses,
      statusProjectPath,
      projectServerIds: Object.fromEntries(
        projectGroups.map((group) => [group.projectPath, group.servers.map((row) => row.id)]),
      ),
      rowStatuses,
    }),
    [projectGroups, rowStatuses, statusProjectPath, statuses],
  );
  /** Record a fresh status where this row reads it from. */
  const storeRowStatus = (
    status: McpServerStatus,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    if (mcpRowIsRuntimeOwned(statusView, status.serverId, level, projectPath)) {
      setStatuses((current) => [
        ...current.filter((entry) => entry.serverId !== status.serverId),
        status,
      ]);
    } else {
      setRowStatuses((current) => ({
        ...current,
        [mcpRowKey(level, status.serverId, projectPath)]: status,
      }));
    }
  };
  /**
   * A project row names its own project; a global row borrows the selected
   * project, if any, the way the page always queried it.
   */
  const levelQuery = (level: AgentCapabilityLevel, projectPath?: string) => {
    const path = level === "project" ? projectPath : selectedProjectPath;
    return { level, ...(path ? { projectPath: path } : {}) };
  };

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<McpServerRecord>,
    projectPath?: string,
  ) => {
    const patchList = (rows: McpServerRecord[]) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    setServers((current) =>
      level === "global"
        ? { ...current, global: patchList(current.global) }
        : {
            ...current,
            projects: current.projects.map((group) =>
              group.projectPath === projectPath
                ? { ...group, servers: patchList(group.servers) }
                : group,
            ),
          },
    );
  };

  /** New servers land at whichever level the filter is pointing at. */
  const targetLevel: AgentCapabilityLevel = filter === "project" ? "project" : "global";

  const openCreate = () => {
    if (targetLevel === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setEditor({
      draft: {
        ...emptyMcpDraft(),
        scope:
          targetLevel === "global"
            ? GLOBAL_SCOPE
            : { mode: "projects", projects: [selectedProjectPath!] },
      },
      editing: null,
      level: targetLevel,
      ...(targetLevel === "project" ? { projectPath: selectedProjectPath! } : {}),
    });
  };

  const openEdit = (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    setMenuFor(null);
    setEditor({ draft: draftFromRecord(server), editing: server, level, projectPath });
  };

  const save = async () => {
    if (!editor) return;
    const projectPath = editor.level === "project" ? editor.projectPath : undefined;
    const candidateId = editor.draft.id.trim();
    const candidateLabel = editor.draft.label.trim().toLocaleLowerCase();
    const levelServers =
      editor.level === "global"
        ? globalServers
        : projectGroups.find((group) => group.projectPath === projectPath)?.servers ?? [];
    const sameLevel = levelServers.some(
      (server) =>
        server.id !== editor.editing?.id &&
        (server.id === candidateId ||
          (!!candidateLabel && server.label.trim().toLocaleLowerCase() === candidateLabel)),
    );
    if (sameLevel) {
      showToast(t("settings.mcpDuplicate"), { variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await api.upsertMcpServer(draftToInput(editor.draft, { level: editor.level, projectPath }));
      await load();
      showToast(
        t(editor.editing ? "settings.mcpSaved" : "settings.mcpAdded", {
          name: editor.draft.label || editor.draft.id,
        }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    const key = rowKey(level, server.id, projectPath);
    if (busyId) return;
    const next = !server.enabled;
    setBusyId(key);
    // Flip locally first: the host is the authority, but a round-trip of latency
    // on a switch reads as a broken control.
    patchRow(level, server.id, { enabled: next }, projectPath);
    try {
      await api.setMcpServerEnabled(server.id, next, levelQuery(level, projectPath));
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: server.label || server.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(level, server.id, { enabled: server.enabled }, projectPath);
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const testConnection = async (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    if (testingId) return;
    setTestingId(rowKey(level, server.id, projectPath));
    try {
      const result = await api.testMcpServer(server.id, {
        level,
        ...(level === "project" && projectPath ? { projectPath } : {}),
      });
      storeRowStatus(result.status, level, projectPath);
      if (result.status.state === "ready") {
        showToast(t("extensions.mcp.testReady", { count: result.status.toolCount }), {
          variant: "success",
        });
      } else if (result.status.authRequired) {
        showToast(t("extensions.mcp.authRequired"), { variant: "error" });
      } else if (result.status.state === "failed") {
        showToast(result.status.message || t("extensions.mcp.testFailed"), { variant: "error" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setTestingId(null);
    }
  };

  const authorizeServer = async (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    if (authorizingId || pendingOAuthRef.current) return;
    setAuthorizingId(rowKey(level, server.id, projectPath));
    let activeLoginId: string | null = null;
    let unsubscribed = false;
    let unsubscribe = () => {};

    const finish = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubscribe();
      if (pendingOAuthRef.current?.unsubscribe === unsubscribe) {
        pendingOAuthRef.current = null;
      }
    };

    const cleanup = () => {
      finish();
      setAuthorizingId(null);
    };

    unsubscribe = api.onMcpOAuth((event) => {
      if (activeLoginId && event.loginId !== activeLoginId) return;
      if (event.serverId !== server.id) return;

      if (event.kind === "done") {
        storeRowStatus(event.status, level, projectPath);
        showToast(t("extensions.mcp.authReady", { count: event.status.toolCount }), {
          variant: "success",
        });
        cleanup();
      } else if (event.kind === "error") {
        showToast(event.message || t("extensions.mcp.authFailed"), { variant: "error" });
        cleanup();
      } else if (event.kind === "cancelled") {
        cleanup();
      }
    });
    pendingOAuthRef.current = { unsubscribe };

    try {
      showToast(t("extensions.mcp.authorizing"), { variant: "info" });
      const result = await api.startMcpOAuth(server.id, {
        level,
        ...(level === "project" && projectPath ? { projectPath } : {}),
      });
      activeLoginId = result.loginId;
      if (!result.ok) {
        showToast(t("extensions.mcp.authFailed"), { variant: "error" });
        cleanup();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      cleanup();
    }
  };

  const remove = async (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    const key = rowKey(level, server.id, projectPath);
    setBusyId(key);
    try {
      await api.removeMcpServer(server.id, levelQuery(level, projectPath));
      await load();
      showToast(t("settings.capabilityDeleted", { name: server.label || server.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const visible = useMemo(() => {
    const match = (server: McpServerRecord) =>
      matchesCapabilitySearch(
        search,
        server.label,
        server.id,
        server.description,
        server.transport === "http" ? server.url : server.command,
      );
    const projects = projectGroups.map((group) => ({
      ...group,
      servers: group.servers.filter(match),
    }));
    return {
      global: globalServers.filter(match),
      projects,
      projectCount: projects.reduce((sum, group) => sum + group.servers.length, 0),
    };
  }, [globalServers, projectGroups, search]);

  const counts = {
    all: visible.global.length + visible.projectCount,
    global: visible.global.length,
    project: visible.projectCount,
  };

  const nameOfProject = (path: string) =>
    options.find((project) => project.path === path)?.name ?? projectDisplayName(path);
  const projectName = selectedProjectPath ? nameOfProject(selectedProjectPath) : undefined;

  /** Where a move sends a row, named the way the toast should say it. */
  const moveTarget: Partial<Record<AgentCapabilityLevel, string>> = {
    global: t("settings.globalLevel"),
    project: selectedProjectPath
      ? `${t("settings.projectLevel")} · ${projectName ?? projectDisplayName(selectedProjectPath)}`
      : undefined,
  };

  /**
   * Move one row to the other level. The project picker owns the destination,
   * so the same action reads "Move into <project>" on a global row and "Move to
   * Global" on a project one.
   *
   * The host moves the document rather than copying it, and a destination that
   * already holds the id or name renames the arriving server, so the toast
   * reports the new name instead of pretending the id survived.
   */
  const move = async (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    const to: AgentCapabilityLevel = level === "global" ? "project" : "global";
    const target = moveTarget[to];
    if (!target) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const key = rowKey(level, server.id, projectPath);
    setBusyId(key);
    try {
      const result = await api.transferMcpServer({
        id: server.id,
        from: levelQuery(level, projectPath),
        to: levelQuery(to, selectedProjectPath ?? undefined),
      });
      await load();
      const name = server.label || server.id;
      const arrived = result.server;
      showToast(
        arrived && arrived.id !== server.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target,
              newName: arrived.label || arrived.id,
            })
          : t("settings.capabilityMoved", { name, target }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = (
    server: McpServerRecord,
    level: AgentCapabilityLevel,
    projectPath?: string,
  ) => {
    const key = rowKey(level, server.id, projectPath);
    const name = server.label || server.id;
    const status = mcpRowStatus(statusView, server, level, projectPath);
    const busy = busyId === key;
    const testing = testingId === key;
    const authorizing = authorizingId === key;
    const isArmed = armed === key;
    const isHttp = server.transport === "http";
    const hasAuthHeader = Boolean(
      server.headers &&
      Object.keys(server.headers).some((k) => k.toLowerCase() === "authorization"),
    );
    const isOAuth = isHttp && (Boolean(status?.hasOauth) || !hasAuthHeader);
    const needsAuth =
      isHttp &&
      !hasAuthHeader &&
      Boolean(status?.authRequired);
    const items: CapabilityMenuItem[] = [
      {
        key: "test",
        label: t("extensions.mcp.test"),
        icon: <IconPlay size={14} />,
        disabled: testing || authorizing,
        onSelect: () => {
          setMenuFor(null);
          void testConnection(server, level, projectPath);
        },
      },
      ...(isOAuth
        ? [
            {
              key: "authorize",
              label: status?.hasOauth
                ? t("extensions.mcp.reauthorize")
                : t("extensions.mcp.authorize"),
              icon: <IconKey size={14} />,
              disabled: testing || authorizing,
              onSelect: () => {
                setMenuFor(null);
                void authorizeServer(server, level, projectPath);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      /**
       * A move needs a destination, so a global row offers it only while the
       * picker names a project; a project row always has Global to go back to.
       */
      ...(moveTarget[level === "global" ? "project" : "global"]
        ? [
            {
              key: "move",
              label:
                level === "global"
                  ? t("settings.capabilityMoveToProject", {
                      project:
                        projectName ?? projectDisplayName(selectedProjectPath ?? ""),
                    })
                  : t("settings.capabilityMoveToGlobal"),
              icon: <IconArrowUpDown size={14} />,
              onSelect: () => {
                setMenuFor(null);
                void move(server, level, projectPath);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.mcp.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(server, level, projectPath);
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={server.transport === "http" ? <IconServer size={16} /> : <IconTerminal size={16} />}
        glyphState={status?.state}
        name={name}
        off={!server.enabled}
        menuOpen={menuFor === key}
        command={server.transport === "http" ? server.url : server.command}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {level === "global"
                ? t("settings.capabilityFilterGlobal")
                : t("settings.capabilityFilterProject")}
            </span>
            <span className="agent-capability-badge">
              {server.transport === "http"
                ? t("settings.transportHttp")
                : t("settings.transportStdio")}
            </span>
            {status && status.state !== "idle" ? (
              <span className={cx("agent-capability-badge", "is-status", `is-${status.state}`)}>
                <span className="agent-capability-status-dot" aria-hidden="true" />
                {status.state === "ready"
                  ? t("extensions.mcp.toolCount", { count: status.toolCount })
                  : t(`extensions.mcp.state.${status.state}`)}
              </span>
            ) : null}
            {needsAuth ? (
              <span className="agent-capability-badge is-status is-failed">
                {t("extensions.mcp.authRequired")}
              </span>
            ) : status?.hasOauth ? (
              <span className="agent-capability-badge is-status is-ready">
                {t("extensions.mcp.oauthBadge")}
              </span>
            ) : null}
          </>
        }
        description={server.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            {needsAuth ? (
              <TooltipButton
                type="button"
                className="settings-icon-button is-action-highlight"
                ariaLabel={t("extensions.mcp.authorize")}
                tooltip={authorizing ? t("extensions.mcp.authorizing") : t("extensions.mcp.authorize")}
                disabled={busy || authorizing}
                onClick={() => void authorizeServer(server, level, projectPath)}
              >
                <IconKey size={15} />
              </TooltipButton>
            ) : null}
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("settings.editMcpOf", { name })}
              tooltip={t("settings.editMcp")}
              disabled={busy}
              onClick={() => openEdit(server, level, projectPath)}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.mcp.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={server.enabled}
              busy={busy || testing}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(server, level, projectPath)}
            />
          </>
        }
      />
    );
  };

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const addButton = (
    <CapabilityButton
      variant="primary"
      title={
        targetLevel === "project"
          ? t("settings.capabilityCreateInProject")
          : t("settings.capabilityCreateInGlobal")
      }
      onClick={openCreate}
    >
      <IconPlus size={14} />
      {t("settings.addMcp")}
    </CapabilityButton>
  );

  const marketButton = (
    <CapabilityButton
      onClick={() => setView("market")}
    >
      <IconServer size={14} />
      {t("settings.mcpMarket.browse")}
    </CapabilityButton>
  );

  if (view === "market") {
    return (
      <McpMarketPanel
        installedIds={[...globalServers, ...projectServers].map((server) => server.id)}
        onBack={() => {
          setView("servers");
          void load();
        }}
        onInstalled={() => {
          setView("servers");
          void load();
        }}
      />
    );
  }

  return (
    <AgentCapabilityPage
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.mcp.searchPlaceholder")}
          projectPicker={
            <AgentProjectPicker
              value={selectedProjectPath}
              options={options}
              label={t("settings.selectProject")}
              allLabel={t("settings.allProjects")}
              onChange={setSelectedProjectPath}
            />
          }
          actions={
            <>
              <ImportToggleButton
                open={importOpen}
                controls="agent-mcp-import-panel"
                label={t("settings.importMcpFromTools")}
                disabled={targetLevel === "project" && !selectedProjectPath}
                onClick={() => setImportOpen((current) => !current)}
              />
              {addButton}
              {marketButton}
            </>
          }
        />
      }
    >
      <section
        id="agent-mcp-import-panel"
        className="settings-card-block import-inline-section"
        hidden={!importOpen}
      >
        <div className="settings-card-heading-line">
          <h3 className="settings-card-heading">
            {t("settings.importAgentMcpTitle")}
          </h3>
        </div>
        <div className="import-inline-workbench">
          <AgentMcpImportPanel
            key={`${targetLevel}:${targetLevel === "project" ? selectedProjectPath ?? "" : ""}`}
            level={targetLevel}
            projectPath={targetLevel === "project" ? selectedProjectPath ?? undefined : undefined}
            onImported={load}
          />
        </div>
      </section>

      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.all === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconServer size={18} />}
          />
        ) : (
          <>
            {showGlobal ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_MCP_PATH}
                  count={visible.global.length}
                />
                {visible.global.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.mcpEmpty")}
                    icon={<IconServer size={18} />}
                    action={addButton}
                  />
                ) : (
                  visible.global.map((server) => renderRow(server, "global"))
                )}
              </>
            ) : null}
            {showProject ? (
              selectedProjectPath ? (
                <>
                  <CapabilityGroupHeader
                    label={t("settings.projectLevel")}
                    path={projectMcpPath(selectedProjectPath)}
                    count={visible.projectCount}
                  />
                  {visible.projectCount === 0 ? (
                    <CapabilityEmpty
                      message={t("settings.mcpEmpty")}
                      icon={<IconServer size={18} />}
                    />
                  ) : (
                    visible.projects.flatMap((group) =>
                      group.servers.map((server) =>
                        renderRow(server, "project", group.projectPath),
                      ),
                    )
                  )}
                </>
              ) : visible.projectCount === 0 ? (
                <>
                  <CapabilityGroupHeader
                    label={t("settings.projectLevel")}
                    path={projectMcpPath(null)}
                    count={0}
                  />
                  <CapabilityEmpty
                    message={t("settings.mcpEmpty")}
                    icon={<IconServer size={18} />}
                  />
                </>
              ) : (
                // Every project at once: one group per project that has servers,
                // so a row's project is always named by the header above it.
                visible.projects
                  .filter((group) => group.servers.length > 0)
                  .map((group) => (
                    <Fragment key={group.projectPath}>
                      <CapabilityGroupHeader
                        label={`${t("settings.projectLevel")} · ${nameOfProject(group.projectPath)}`}
                        path={projectMcpPath(group.projectPath)}
                        count={group.servers.length}
                      />
                      {group.servers.map((server) =>
                        renderRow(server, "project", group.projectPath),
                      )}
                    </Fragment>
                  ))
              )
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <McpEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          status={
            editor.editing
              ? mcpRowStatus(statusView, editor.editing, editor.level, editor.projectPath)
              : undefined
          }
          testing={
            editor.editing
              ? testingId === rowKey(editor.level, editor.editing.id, editor.projectPath)
              : false
          }
          projects={[]}
          currentProjectPath={editor.projectPath ?? selectedProjectPath}
          managementLevel={editor.level}
          managementProjectName={editor.projectPath ? nameOfProject(editor.projectPath) : projectName}
          onClose={() => {
            if (!saving && !testingId) setEditor(null);
          }}
          onSave={() => void save()}
          onTest={() => {
            if (editor.editing) {
              void testConnection(editor.editing, editor.level, editor.projectPath);
            }
          }}
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
