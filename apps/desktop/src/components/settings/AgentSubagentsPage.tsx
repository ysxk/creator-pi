import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentCapabilityLevel,
  SubagentDefinition,
  UserSubagentRecord,
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
  SubagentEditorSheet,
  draftFromDefinition,
  draftFromRecord,
  emptySubagentDraft,
  mergeSubagentToolGrant,
  subagentPresetCopyKey,
  type SubagentDraft,
} from "./SubagentEditorSheet";
import {
  EMPTY_SUBAGENT_PAGE,
  fetchSubagentPageData,
  type BuiltinSubagentRow,
} from "./subagent-settings";
import {
  IconArrowUpDown,
  IconBot,
  IconCopy,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";
import { SubagentAvatar } from "../SubagentAvatar";
import { TooltipButton } from "../ui";
const GLOBAL_SUBAGENTS_PATH = "~/.agents/subagents";

function projectSubagentsPath(projectPath: string | null): string {
  return projectPath
    ? `${projectPath}/.agents/subagents`
    : "<project-root>/.agents/subagents";
}

type SubagentEditorState = {
  draft: SubagentDraft;
  editing: UserSubagentRecord | null;
  /** The directory the document is, or will be, written to. */
  level: AgentCapabilityLevel;
  /** Selected template chip; set when Copy as mine pre-fills a builtin. */
  presetId?: string;
};

function builtinDisplayName(
  id: string,
  t: (key: string) => string,
): string {
  const key = subagentPresetCopyKey(id, "name");
  return key ? t(key) : id;
}

export function AgentSubagentsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const fetchPage = useCallback(
    () => fetchSubagentPageData(selectedProjectPath),
    [selectedProjectPath],
  );
  const {
    data: { global: globalSubagents, project: projectSubagents, builtins },
    setData: setSubagents,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchPage, EMPTY_SUBAGENT_PAGE, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SubagentEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();
  /** Copy as mine writes a global document, so that level decides if it is free. */
  const globalHandles = useMemo(
    () => new Set(globalSubagents.map((row) => row.id)),
    [globalSubagents],
  );

  const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<UserSubagentRecord>,
  ) => {
    setSubagents((current) => ({
      ...current,
      [level]: current[level].map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  /** A project document is addressed by its project; a global one by nothing. */
  const levelQuery = (level: AgentCapabilityLevel) => ({
    level,
    ...(level === "project" && selectedProjectPath
      ? { projectPath: selectedProjectPath }
      : {}),
  });

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, subagent.id);
    if (busyId === key) return;
    const next = !subagent.enabled;
    setBusyId(key);
    patchRow(level, subagent.id, { enabled: next });
    try {
      await api.setUserSubagentEnabled(subagent.id, next, levelQuery(level));
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: subagent.name || subagent.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(level, subagent.id, { enabled: subagent.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * A builtin has no document to switch, so its handle is stored in app-local
   * state instead — but it is the same switch: flip locally first, call the
   * host, and revert the row only if the host refuses.
   */
  const toggleBuiltin = async (builtin: BuiltinSubagentRow) => {
    const handle = builtin.name;
    if (busyId === `builtin:${handle}`) return;
    const next = !builtin.enabled;
    setBusyId(`builtin:${handle}`);
    setSubagents((current) => ({
      ...current,
      builtins: current.builtins.map((row) =>
        row.name === handle ? { ...row, enabled: next } : row,
      ),
    }));
    try {
      await api.setBuiltinSubagentEnabled(handle, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: builtinDisplayName(handle, t),
        }),
        { variant: "success" },
      );
    } catch (error) {
      setSubagents((current) => ({
        ...current,
        builtins: current.builtins.map((row) =>
          row.name === handle ? { ...row, enabled: builtin.enabled } : row,
        ),
      }));
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = async (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    setBusyId(rowKey(level, subagent.id));
    try {
      const result = await api.readUserSubagent(subagent.id, levelQuery(level));
      setEditor({
        draft: draftFromRecord(result.subagent ?? subagent, result.body ?? ""),
        editing: result.subagent ?? subagent,
        level,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const copyBuiltin = (definition: SubagentDefinition) => {
    setEditor({
      draft: draftFromDefinition(definition),
      editing: null,
      level: "global",
      presetId: definition.name,
    });
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing, level } = editor;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      tools: mergeSubagentToolGrant(draft.inheritTools, draft.tools),
      // An empty string clears a pinned model; omitting it would keep the old one.
      model: draft.model.trim(),
      fallbackModels: draft.fallbackModels.map((pin) => pin.trim()),
      thinkingLevel: draft.thinkingLevel,
      // `0` clears the output cap, so the delegate follows the model again.
      maxTokens: draft.maxTokens,
      enabled: draft.enabled,
      scope: draft.scope,
      ...levelQuery(level),
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSubagent(editing.id, payload);
      else await api.createUserSubagent(payload);
      await load();
      showToast(
        t(editing ? "settings.subagentSaved" : "settings.subagentCreated", {
          name: payload.name,
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

  const reveal = async (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    try {
      await api.revealSubagent({ id: subagent.id, ...levelQuery(level) });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    setBusyId(rowKey(level, subagent.id));
    try {
      await api.removeUserSubagent(subagent.id, levelQuery(level));
      await load();
      showToast(t("settings.capabilityDeleted", { name: subagent.name || subagent.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const projectName = useMemo(
    () =>
      options.find((project) => project.path === selectedProjectPath)?.name ??
      (selectedProjectPath ? projectDisplayName(selectedProjectPath) : undefined),
    [options, selectedProjectPath],
  );

  /** Where a move sends a row, named the way the toast should say it. */
  const moveTarget: Partial<Record<AgentCapabilityLevel, string>> = {
    global: t("settings.globalLevel"),
    project: selectedProjectPath
      ? `${t("settings.projectLevel")} · ${projectName ?? projectDisplayName(selectedProjectPath)}`
      : undefined,
  };

  /**
   * Move one row to the other level; the project picker owns the destination.
   *
   * The host moves the document rather than copying it, renames the arrival
   * when the destination already owns the handle, and drops a `permission` key
   * on the way out of a project, so the toast reports the handle it landed on.
   */
  const move = async (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    const to: AgentCapabilityLevel = level === "global" ? "project" : "global";
    const target = moveTarget[to];
    if (!target) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setBusyId(rowKey(level, subagent.id));
    try {
      const result = await api.transferUserSubagent({
        id: subagent.id,
        from: levelQuery(level),
        to: levelQuery(to),
      });
      await load();
      const name = subagent.name || subagent.id;
      const arrived = result.subagent;
      showToast(
        arrived && arrived.id !== subagent.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target,
              newName: arrived.name || arrived.id,
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

  const visible = useMemo(() => {
    const match = (subagent: UserSubagentRecord) =>
      matchesCapabilitySearch(search, subagent.name, subagent.id, subagent.description);
    return {
      global: globalSubagents.filter(match),
      project: projectSubagents.filter(match),
    };
  }, [globalSubagents, projectSubagents, search]);

  const visibleBuiltins = useMemo(
    () =>
      builtins.filter((definition) =>
        matchesCapabilitySearch(
          search,
          builtinDisplayName(definition.name, t),
          definition.name,
          definition.description,
        ),
      ),
    [builtins, search, t],
  );

  /** Where a new document lands: the filtered level, global when both show. */
  const targetLevel: AgentCapabilityLevel = filter === "project" ? "project" : "global";

  const openCreate = () => {
    if (targetLevel === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setEditor({ draft: emptySubagentDraft(), editing: null, level: targetLevel });
  };

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  // The shipped defaults have no directory, so they sit with the global level.
  const shownBuiltins = showGlobal ? visibleBuiltins : [];
  const counts = {
    all: visible.global.length + visible.project.length + visibleBuiltins.length,
    global: visible.global.length + visibleBuiltins.length,
    project: visible.project.length,
  };
  const searching = Boolean(search.trim());
  const noMatches = searching && counts[filter] === 0;

  const renderBuiltin = (definition: BuiltinSubagentRow) => {
    const handle = definition.name;
    const name = builtinDisplayName(handle, t);
    const canCopy = !globalHandles.has(handle);
    const busy = busyId === `builtin:${handle}`;
    return (
      <CapabilityRow
        key={`builtin:${handle}`}
        glyph={<SubagentAvatar name={handle} size={16} />}
        name={name}
        off={!definition.enabled}
        command={t("extensions.subagents.handle", { name: handle })}
        badges={
          <span className="agent-capability-badge">{t("extensions.subagents.sourceBuiltin")}</span>
        }
        description={definition.description || t("settings.noCapabilityDescription")}
        meta={
          definition.tools?.length ? (
            <>
              {definition.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : undefined
        }
        actions={
          <>
            {canCopy ? (
              <TooltipButton
                type="button"
                className="settings-icon-button"
                tooltip={t("extensions.subagents.copy")}
                onClick={() => copyBuiltin(definition)}
              >
                <IconCopy size={15} />
              </TooltipButton>
            ) : null}
            <CapabilityToggle
              checked={definition.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggleBuiltin(definition)}
            />
          </>
        }
      />
    );
  };

  const renderRow = (subagent: UserSubagentRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, subagent.id);
    const name = subagent.name || subagent.id;
    const busy = busyId === key;
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.subagents.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(subagent, level);
        },
      },
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
                void move(subagent, level);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      {
        key: "remove",
        label: isArmed
          ? t("settings.capabilityRemoveConfirm")
          : t("extensions.subagents.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(subagent, level);
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<SubagentAvatar name={subagent.name} size={16} />}
        name={name}
        off={!subagent.enabled}
        menuOpen={menuFor === key}
        badges={
          <span
            className="agent-capability-badge is-level"
            // A project document is repository content; the row that is
            // subject to the limits is the one that states them.
            title={level === "project" ? t("settings.projectSubagentLimits") : undefined}
          >
            {level === "global"
              ? t("settings.capabilityFilterGlobal")
              : t("settings.capabilityFilterProject")}
          </span>
        }
        description={subagent.description || t("settings.noCapabilityDescription")}
        meta={
          subagent.tools?.length ? (
            <>
              {subagent.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : undefined
        }
        actions={
          <>
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.subagents.rowActions", { name })}
              tooltip={t("extensions.subagents.edit")}
              disabled={busy}
              onClick={() => void openEdit(subagent, level)}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.subagents.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={subagent.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(subagent, level)}
            />
          </>
        }
      />
    );
  };

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
      {t("extensions.subagents.add")}
    </CapabilityButton>
  );

  return (
    <AgentCapabilityPage
      className="agent-subagents-page"
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.subagents.searchPlaceholder")}
          projectPicker={
            <AgentProjectPicker
              value={selectedProjectPath}
              options={options}
              label={t("settings.selectProject")}
              onChange={setSelectedProjectPath}
            />
          }
          actions={addButton}
        />
      }
    >
      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {noMatches ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconBot size={18} />}
          />
        ) : (
          <>
            {shownBuiltins.length > 0 ? (
              <>
                <CapabilityGroupHeader
                  label={t("extensions.subagents.sourceBuiltin")}
                  count={shownBuiltins.length}
                />
                {shownBuiltins.map(renderBuiltin)}
              </>
            ) : null}
            {showGlobal && (!searching || visible.global.length > 0) ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_SUBAGENTS_PATH}
                  count={visible.global.length}
                />
                {visible.global.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.subagentsEmpty")}
                    icon={<IconBot size={18} />}
                    action={addButton}
                  />
                ) : (
                  visible.global.map((subagent) => renderRow(subagent, "global"))
                )}
              </>
            ) : null}
            {showProject && (!searching || visible.project.length > 0) ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.projectLevel")}
                  path={projectSubagentsPath(selectedProjectPath)}
                  count={visible.project.length}
                />
                {!selectedProjectPath ? (
                  <CapabilityEmpty message={t("settings.selectProjectFirst")} />
                ) : visible.project.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.projectSubagentsEmpty")}
                    hint={t("settings.projectSubagentLimits")}
                    icon={<IconBot size={18} />}
                  />
                ) : (
                  visible.project.map((subagent) => renderRow(subagent, "project"))
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SubagentEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          initialPresetId={editor.presetId}
          level={editor.level}
          projectName={projectName}
          saving={saving}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
          onReveal={
            editor.editing
              ? () => void reveal(editor.editing!, editor.level)
              : undefined
          }
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
