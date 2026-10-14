import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  subagentModelKey,
  type ComposerCommand,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import {
  subagentDisplayDescription,
  subagentDisplayName,
  subagentReachKey,
} from "../lib/subagent-names";
import type {
  CompletionController,
  CompletionItem,
} from "../features/chat/composer/hooks/useComposerCompletions";
import {
  IconBookOpen,
  IconFileText,
  IconFolder,
  IconPlug,
  IconSlash,
  IconSparkles,
} from "./icons";
import { FileTypeBadge } from "./FileTypeBadge";
import { SubagentAvatar } from "./SubagentAvatar";
import { AnchoredMenu } from "./settings/AnchoredMenu";

/**
 * Composer autocomplete panel (D123–D125, spec 08 §11.8): full composer
 * width above the input, focus stays in the textarea — rows accept on
 * mousedown so the caret never leaves the draft.
 */

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<span key={`t${at}`}>{text.slice(at, start)}</span>);
    parts.push(
      <span key={`h${start}`} className="composer-ac-hl">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

const GROUP_KEYS: Record<ComposerCommand["kind"], string> = {
  template: "chat.slashGroupTemplates",
  builtin: "chat.slashGroupApp",
  plugin: "chat.slashGroupPlugins",
  extension: "chat.slashGroupExtensions",
  skill: "chat.slashGroupSkills",
  mcp: "chat.slashGroupMcp",
};

/**
 * What one subagent is, in the terms its definition is written in: the handle
 * `Task` takes, whether it can change files, the model it runs on, what it is
 * for, and the tools it was granted. It floats above the portrait it describes,
 * outside the panel's flow, so choosing a subagent never moves the strip or
 * the file list.
 */
function AgentDetail({
  t,
  agent,
  position,
}: {
  t: TFunction;
  agent: SubagentDefinition;
  /** The portrait's place in the strip, counted from the left. */
  position: number;
}) {
  const tools = agent.inheritTools ? ["inherit", ...agent.tools] : agent.tools;
  const description = subagentDisplayDescription(t, agent);
  return (
    <div
      className="composer-ac-agent-detail"
      style={{ "--agent-position": position } as React.CSSProperties}
    >
      <div className="composer-ac-agent-detail-head">
        <code className="composer-ac-agent-handle">Task({agent.name})</code>
        <span className="composer-ac-agent-tag">{t(subagentReachKey(agent))}</span>
        {agent.source === "project" ? (
          <span className="composer-ac-agent-tag">{t("settings.capabilityFilterProject")}</span>
        ) : null}
        <span className="composer-ac-agent-model">
          {agent.model ? subagentModelKey(agent.model) : t("chat.atAgentModelInherit")}
        </span>
      </div>
      {description ? <p className="composer-ac-agent-desc">{description}</p> : null}
      <div className="composer-ac-agent-tools">
        {tools.map((tool) => (
          <code key={tool}>{tool}</code>
        ))}
      </div>
    </div>
  );
}

function CommandIcon({ kind }: { kind: ComposerCommand["kind"] }) {
  if (kind === "template") return <IconSlash size={14} />;
  if (kind === "skill") return <IconBookOpen size={14} />;
  if (kind === "plugin" || kind === "extension" || kind === "mcp") return <IconPlug size={14} />;
  return <IconSparkles size={14} />;
}

export function ComposerAutocomplete({
  anchorRef,
  ac,
  onAccept,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  ac: CompletionController;
  onAccept: (index: number) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ac.open) return;
    // The strip and the list are siblings; the highlight can be in either.
    listRef.current?.parentElement
      ?.querySelector(`[data-ac-index="${ac.highlight}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ac.open, ac.highlight]);

  if (!ac.open) return null;

  const renderRow = (item: CompletionItem, index: number) => {
    const active = index === ac.highlight;
    const rowClass = `composer-plus-item composer-ac-item ${active ? "kb-active" : ""}`;
    const commonProps = {
      key:
        item.kind === "command"
          ? `c:${item.command.kind}:${item.command.name}`
          : item.kind === "plugin"
            ? `pl:${item.pluginId}:${index}`
            : item.kind === "subagent"
              ? `a:${item.agent.name}`
              : `p:${item.entry.path}`,
      type: "button" as const,
      role: "option" as const,
      "aria-selected": active,
      "data-ac-index": index,
      className: rowClass,
      // Mousedown keeps focus in the textarea (input-retained overlay).
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        onAccept(index);
      },
      onMouseMove: () => ac.setHighlight(index),
    };
    if (item.kind === "command") {
      return (
        <button {...commonProps}>
          <span className="composer-ac-icon">
            <CommandIcon kind={item.command.kind} />
          </span>
          <span className="composer-ac-name">
            /<Highlighted text={item.command.name} ranges={item.match.ranges} />
          </span>
          {(item.command.kind === "skill" || item.command.kind === "mcp") && item.command.title !== item.command.name ? (
            <span className="composer-ac-hint">{item.command.title}</span>
          ) : null}
          {item.command.argumentHint ? (
            <span className="composer-ac-hint">{item.command.argumentHint}</span>
          ) : null}
          {item.command.description ? (
            <span className="composer-ac-desc">{item.command.description}</span>
          ) : null}
        </button>
      );
    }
    if (item.kind === "plugin") {
      return (
        <button {...commonProps} title={item.row.detail}>
          <span className="composer-ac-icon">
            <IconPlug size={14} />
          </span>
          <span className="composer-ac-name">{item.row.label}</span>
          {item.row.detail ? <span className="composer-ac-desc">{item.row.detail}</span> : null}
        </button>
      );
    }
    if (item.kind === "subagent") {
      return (
        <button
          {...commonProps}
          className={`composer-ac-agent ${active ? "kb-active" : ""}`}
          title={item.agent.description || item.agent.name}
        >
          <span className="composer-ac-agent-avatar subagent-ac-avatar">
            <SubagentAvatar name={item.agent.name} size={30} />
          </span>
          <span className="composer-ac-agent-name">{subagentDisplayName(t, item.agent.name)}</span>
          <span className="composer-ac-agent-handle-line">
            @<Highlighted text={item.agent.name} ranges={item.match.ranges} />
          </span>
        </button>
      );
    }
    const isDir = item.entry.kind === "dir";
    const name = item.entry.path.split("/").pop() ?? item.entry.path;
    const displayName = `${name}${isDir ? "/" : ""}`;
    return (
      <button
        {...commonProps}
        aria-label={item.entry.path}
        title={item.entry.path}
      >
        <span className="composer-ac-icon">
          {isDir ? (
            <IconFolder size={14} />
          ) : (
            <FileTypeBadge path={name} fallback={<IconFileText size={14} />} />
          )}
        </span>
        <span className="composer-ac-name">{displayName}</span>
        <span className="composer-ac-path">{item.entry.path}</span>
      </button>
    );
  };

  // In the `@` panel the leading subagents form a strip above the list; the
  // highlight index still runs through both, strip first.
  const strip: React.ReactNode[] = [];
  const rows: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  ac.items.forEach((item, index) => {
    if (item.kind === "subagent") {
      strip.push(renderRow(item, index));
      return;
    }
    if (item.kind === "command") {
      const group = item.command.kind;
      if (group !== lastGroup) {
        lastGroup = group;
        rows.push(
          <div key={`g:${group}`} className="composer-model-group-label">
            {t(GROUP_KEYS[group])}
          </div>,
        );
      }
    } else if (item.kind === "plugin" && lastGroup !== `plugin:${item.pluginId}`) {
      // A plugin's rows sit under its own name, after the host's.
      lastGroup = `plugin:${item.pluginId}`;
      rows.push(
        <div key={`g:${lastGroup}`} className="composer-model-group-label">
          {item.pluginName}
        </div>,
      );
    }
    rows.push(renderRow(item, index));
  });

  const highlighted = ac.items[ac.highlight];
  const focusedAgent = highlighted?.kind === "subagent" ? highlighted.agent : null;
  // Subagents lead the items, so the highlight index is the strip position.
  const focusedPosition = focusedAgent ? ac.highlight : 0;

  const emptyKey =
    ac.mode === "file"
      ? ac.noWorkspace
        ? "chat.fileNoWorkspace"
        : "chat.fileEmpty"
      : "chat.slashEmpty";

  return (
    <AnchoredMenu
      className="composer-autocomplete-anchor"
      open={ac.open}
      onClose={ac.close}
      anchorRef={anchorRef}
      menuClassName="composer-autocomplete"
      label={t(
        ac.mode === "file"
          ? "chat.fileMenu"
          : ac.mode === "plugin"
            ? "chat.pluginTriggerMenu"
            : "chat.slashMenu",
      )}
      role="listbox"
      side="top"
      matchAnchorWidth
      initialFocus="none"
      trigger={() => null}
    >
      {strip.length > 0 ? (
        <div className="composer-ac-agents">
          {focusedAgent ? (
            <AgentDetail t={t} agent={focusedAgent} position={focusedPosition} />
          ) : null}
          <div className="composer-ac-agents-stage">
            <div className="composer-ac-agents-head">
              <span className="composer-model-group-label">{t("chat.atGroupAgents")}</span>
            </div>
            <div className="composer-ac-agent-strip">{strip}</div>
          </div>
        </div>
      ) : null}
      <div className="composer-ac-card">
        <div className="composer-ac-list" ref={listRef}>
          {rows.length > 0 ? (
            rows
          ) : (
            <div className="composer-model-empty">{t(emptyKey)}</div>
          )}
        </div>
        <div className="composer-ac-footer">
          <span>{t(strip.length > 0 ? "chat.acHintAgents" : "chat.acHint")}</span>
          {ac.truncated ? (
            <span className="composer-ac-truncated">{t("chat.fileTruncated")}</span>
          ) : null}
        </div>
      </div>
    </AnchoredMenu>
  );
}
