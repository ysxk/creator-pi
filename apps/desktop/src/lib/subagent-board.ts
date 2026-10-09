import type { UiMessage } from "@pi-desktop/shared";
import { buildTranscriptEntries, type AssistantActivityItem } from "./assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationIsCreating,
  isDelegationActivityItem,
  subagentOutcome,
  type SubagentOutcome,
} from "./subagent-topology";
import { getToolDisplayName, getToolSummary, isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

/**
 * The session's subagents as a board: what the main agent delegated in the
 * current turn, what each delegate is doing right now, and when each one ran.
 *
 * The runtime has one level of delegation and no delegate-to-delegate edges
 * (ADR 0062), so the honest picture is a trunk with one lane per delegate, not
 * a graph. Everything is derived from transcript rows the renderer already
 * holds; there is no board state to keep in sync.
 */
export type SubagentBoardRow = {
  /** Work-panel tab id: the delegation id once known, else the Task call id. */
  id: string;
  /** Definition handle, or "" when the runtime attributed none. */
  agentName: string;
  outcome: SubagentOutcome;
  /** Still spawning: running, but with no delegation handle yet. */
  creating: boolean;
  /** The tool the delegate is running, or ran last, as one line. */
  activity: string;
  /** Rows the delegate has produced so far. */
  steps: number;
  startedAt?: number;
  completedAt?: number;
};

export type SubagentBoard = {
  rows: SubagentBoardRow[];
  running: number;
  /** Earliest delegate start: the left edge of every time lane. */
  startedAt?: number;
  /** Latest finish, present only once nothing is running. */
  completedAt?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** `Bash · pnpm test`: the running tool if there is one, else the last one. */
function delegateActivity(item: Extract<AssistantActivityItem, { kind: "tool" }>): string {
  const tools = (item.delegate?.items ?? []).filter((entry) => entry.kind === "tool");
  const current =
    [...tools].reverse().find((entry) => entry.message.toolStatus === "running") ??
    tools.at(-1);
  if (!current) return "";
  const name = getToolDisplayName(current.message.toolName);
  const summary = getToolSummary(current.message.toolName, current.message.toolArgs);
  return [name, summary].filter(Boolean).join(" · ");
}

/**
 * The board for the latest turn that delegated anything, or null when no turn
 * in `messages` did. `turnLive` says whether that turn is still running: a
 * delegate left `running` by a turn that already ended was aborted with it.
 */
export function buildSubagentBoard(
  messages: readonly UiMessage[],
  options: { turnLive: boolean },
): SubagentBoard | null {
  const { entries } = buildTranscriptEntries(messages as UiMessage[]);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== "assistant-turn") continue;
    const items = entry.parts.flatMap((part) => (part.kind === "activity" ? part.items : []));
    const delegations = items.filter(isDelegationActivityItem);
    if (delegations.length === 0) continue;

    const latestTurn = !entries.slice(index + 1).some((later) => later.kind === "assistant-turn");
    const statuses = collectDelegationStatuses(items, {
      turnLive: latestTurn && options.turnLive,
    });
    const timings = collectDelegationTimings(items);

    const rows = delegations.map((item): SubagentBoardRow => {
      const { message } = item;
      const payload = record(toolResultPayload(message));
      const delegationId =
        typeof payload?.delegationId === "string" && payload.delegationId
          ? payload.delegationId
          : undefined;
      const outcome = subagentOutcome(message, statuses);
      const creating = outcome === "running" && delegationIsCreating(message);
      const timing = delegationId ? timings.get(delegationId) : undefined;
      const startedAt =
        timing?.startedAt ?? timestamp(payload?.startedAt) ?? timestamp(message.createdAt);
      const completedAt = timing?.completedAt ?? timestamp(payload?.completedAt);
      const args = record(message.toolArgs);
      return {
        id: delegationId ?? message.toolCallId ?? message.id,
        agentName:
          item.delegate?.agentName ?? (typeof args?.agent === "string" ? args.agent : ""),
        outcome,
        creating,
        activity: delegateActivity(item),
        steps: item.delegate?.items.length ?? 0,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(outcome !== "running" && completedAt !== undefined ? { completedAt } : {}),
      };
    });

    const starts = rows.flatMap((row) => (row.startedAt !== undefined ? [row.startedAt] : []));
    const running = rows.filter((row) => row.outcome === "running").length;
    const ends = rows.flatMap((row) => (row.completedAt !== undefined ? [row.completedAt] : []));
    return {
      rows,
      running,
      ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
      ...(running === 0 && ends.length ? { completedAt: Math.max(...ends) } : {}),
    };
  }
  return null;
}

/**
 * Whether the current turn has a delegate in flight — the one fact the topbar
 * button needs, answered without building transcript entries.
 *
 * It runs as a store selector on every streamed update, so it only walks back
 * to the user message that started the turn and reads each `Task` row's own
 * status: `Task` returns `running` when the delegate starts and the runtime
 * rewrites that row when the delegate settles.
 */
export function hasRunningDelegation(messages: readonly UiMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return false;
    if (message.role !== "tool" || message.parentToolCallId) continue;
    if (!isDelegationStartTool(message.toolName)) continue;
    if (message.toolStatus === "running") return true;
    if (record(toolResultPayload(message))?.status === "running") return true;
  }
  return false;
}

/**
 * Where a row's lane starts and how wide it is, as fractions of the board span.
 * A row with no finish runs to the board's end: that is "now" for a running
 * delegate, and the honest reading of one the turn took down with it.
 */
export function laneGeometry(
  row: Pick<SubagentBoardRow, "startedAt" | "completedAt">,
  board: Pick<SubagentBoard, "startedAt" | "completedAt">,
  now: number,
): { offset: number; width: number } {
  const origin = board.startedAt;
  if (origin === undefined || row.startedAt === undefined) return { offset: 0, width: 0 };
  const end = board.completedAt ?? now;
  const span = Math.max(1, end - origin);
  const rowEnd = row.completedAt ?? end;
  // A lane that has started is never invisible, however short it is so far.
  const width = Math.min(1, Math.max(0.02, (rowEnd - row.startedAt) / span));
  const offset = Math.min(1 - width, Math.max(0, (row.startedAt - origin) / span));
  return { offset, width };
}
