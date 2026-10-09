import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { SubagentAvatar } from "../../../components/SubagentAvatar";
import { IconWorkflow, IconX } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { useTranscriptView } from "../../../hooks/use-transcript-view";
import {
  buildSubagentBoard,
  hasRunningDelegation,
  laneGeometry,
  type SubagentBoard,
  type SubagentBoardRow,
} from "../../../lib/subagent-board";
import { subagentDisplayName } from "../../../lib/subagent-names";
import { formatToolDuration } from "../../../lib/tool-display";
import { useAppStore } from "../../../stores/app-store";

function elapsedLabel(startedAt: number | undefined, end: number | undefined): string {
  if (startedAt === undefined || end === undefined) return "";
  return formatToolDuration(Math.max(0, Math.round((end - startedAt) / 1000)));
}

/** A settled delegate with no recorded finish has no duration to claim. */
function rowEnd(row: SubagentBoardRow, now: number): number | undefined {
  return row.completedAt ?? (row.outcome === "running" ? now : undefined);
}

function rowStatus(t: TFunction, row: SubagentBoardRow): string {
  if (row.creating) return t("chat.subagentCreating");
  if (row.outcome === "running") return row.activity || t("chat.running");
  const status = t(`chat.subagentStatus.${row.outcome}`);
  return row.steps > 0
    ? `${status} · ${t("chat.processingSteps", { count: row.steps })}`
    : status;
}

const BoardRow = memo(function BoardRow({
  t,
  row,
  board,
  now,
  onOpen,
  onFocusRow,
}: {
  t: TFunction;
  row: SubagentBoardRow;
  board: SubagentBoard;
  now: number;
  onOpen: (row: SubagentBoardRow) => void;
  onFocusRow: (row: SubagentBoardRow | null) => void;
}) {
  const lane = laneGeometry(row, board, now);
  const name = subagentDisplayName(t, row.agentName);
  return (
    <li className="subagent-board-row" data-outcome={row.outcome}>
      <button
        type="button"
        className="subagent-board-row-hit"
        onClick={() => onOpen(row)}
        onPointerEnter={() => onFocusRow(row)}
        onPointerLeave={() => onFocusRow(null)}
        onFocus={() => onFocusRow(row)}
        onBlur={() => onFocusRow(null)}
      >
        <span className="subagent-board-avatar" aria-hidden="true">
          <SubagentAvatar name={row.agentName || "agent"} size={22} />
        </span>
        <span className="subagent-board-row-copy">
          <span className="subagent-board-row-head">
            <span className="subagent-board-row-name">{name}</span>
            <span className="subagent-board-row-status">{rowStatus(t, row)}</span>
            <span className="subagent-board-row-time">
              {elapsedLabel(row.startedAt, rowEnd(row, now))}
            </span>
          </span>
          <span className="subagent-board-lane" aria-hidden="true">
            <span
              className="subagent-board-lane-fill"
              style={{
                marginInlineStart: `${(lane.offset * 100).toFixed(2)}%`,
                width: `${(lane.width * 100).toFixed(2)}%`,
              }}
            />
          </span>
        </span>
      </button>
    </li>
  );
});

function BoardPanel({
  sessionId,
  running,
  onClose,
}: {
  sessionId: string;
  running: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { messages } = useTranscriptView(sessionId);
  const openSubagentTab = useAppStore((state) => state.openSubagentTab);
  const board = useMemo(
    () => buildSubagentBoard(messages, { turnLive: running }),
    [messages, running],
  );
  const live = (board?.running ?? 0) > 0;
  const [now, setNow] = useState(() => Date.now());
  // One clock for the whole board, and only while something is still running.
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const [focused, setFocused] = useState<SubagentBoardRow | null>(null);
  const detail = focused ? board?.rows.find((row) => row.id === focused.id) ?? null : null;
  const end = board?.completedAt ?? now;

  return (
    <div className="subagent-board">
      <header className="subagent-board-header">
        <span className="subagent-board-title">{t("chat.subagentBoard")}</span>
        {live ? (
          <span className="subagent-board-live">
            <span className="subagent-board-live-dot" aria-hidden="true" />
            {t("chat.subagentBoardRunning", { count: board?.running ?? 0 })}
          </span>
        ) : null}
        <button
          type="button"
          className="subagent-board-close"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <IconX size={13} />
        </button>
      </header>
      {!board ? (
        <p className="subagent-board-empty">{t("chat.subagentBoardEmpty")}</p>
      ) : (
        <>
          <div className="subagent-board-root">
            <span className="subagent-board-root-mark" aria-hidden="true" />
            <span className="subagent-board-root-name">{t("chat.subagentCoordinator")}</span>
            <span className="subagent-board-row-time">{elapsedLabel(board.startedAt, end)}</span>
          </div>
          <ul className="subagent-board-rows" aria-label={t("chat.subagentTopology")}>
            {board.rows.map((row) => (
              <BoardRow
                key={row.id}
                t={t}
                row={row}
                board={board}
                now={now}
                onFocusRow={setFocused}
                onOpen={(target) => {
                  openSubagentTab(target.id, target.agentName || undefined);
                  onClose();
                }}
              />
            ))}
          </ul>
          <footer className="subagent-board-footer">
            {detail ? (
              <>
                <span className="subagent-board-detail-name">
                  {detail.agentName || t("chat.subagentUnnamed")}
                </span>
                <span className="subagent-board-detail-text">
                  {detail.activity || rowStatus(t, detail)}
                </span>
              </>
            ) : (
              t("chat.subagentBoardFooter", {
                count: board.rows.length,
                elapsed: elapsedLabel(board.startedAt, end),
              })
            )}
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * The topbar entry to the subagent board.
 *
 * The button subscribes to one boolean — is a delegate running in the open
 * session — so streamed tokens never re-render the topbar. The board itself
 * mounts only while it is open, and that is the only time the transcript is
 * read and the clock ticks.
 */
export const SubagentBoardButton = memo(function SubagentBoardButton() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const running = useAppStore(
    (state) =>
      Boolean(state.activeSessionId && state.runningSessions[state.activeSessionId]) &&
      hasRunningDelegation(state.messages),
  );
  const sessionRunning = useAppStore((state) =>
    Boolean(state.activeSessionId && state.runningSessions[state.activeSessionId]),
  );
  const [open, setOpen] = useState(false);
  const lastSession = useRef(sessionId);
  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId;
      setOpen(false);
    }
  }, [sessionId]);
  if (!sessionId) return null;

  return (
    <AnchoredMenu
      className="subagent-board-anchor"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="subagent-board-popover"
      label={t("chat.subagentBoard")}
      role="dialog"
      align="end"
      side="bottom"
      initialFocus="none"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`ct-icon-btn subagent-board-button${open ? " active" : ""}`}
          tooltip={t("chat.subagentBoard")}
          ariaLabel={t("chat.subagentBoard")}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-running={running ? "true" : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <IconWorkflow size={15} />
          {running ? <span className="subagent-board-button-dot" aria-hidden="true" /> : null}
        </TooltipButton>
      )}
    >
      {open ? (
        <BoardPanel
          sessionId={sessionId}
          running={sessionRunning}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </AnchoredMenu>
  );
});
