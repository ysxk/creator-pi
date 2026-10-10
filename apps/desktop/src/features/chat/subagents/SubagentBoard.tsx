import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { SubagentAvatar } from "../../../components/SubagentAvatar";
import { IconWorkflow } from "../../../components/icons";
import { useHoverMenu } from "../../../hooks/use-hover-menu";
import { useTranscriptView } from "../../../hooks/use-transcript-view";
import {
  buildSubagentBoard,
  hasRunningDelegation,
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

/** `运行中 · 12s`, `已完成 · 48s`, `已停止`: the state, then how long it took. */
function cardState(t: TFunction, row: SubagentBoardRow, now: number): string {
  const state = row.creating
    ? t("chat.subagentCreating")
    : row.outcome === "running"
      ? t("chat.running")
      : t(`chat.subagentStatus.${row.outcome}`);
  const elapsed = elapsedLabel(row.startedAt, rowEnd(row, now));
  return elapsed ? `${state} · ${elapsed}` : state;
}

/** The line under the name: the live command, or what the delegate got done. */
function cardDetail(t: TFunction, row: SubagentBoardRow): string {
  if (row.outcome === "running" && row.activity) return row.activity;
  return row.steps > 0 ? t("chat.processingSteps", { count: row.steps }) : "";
}

/**
 * One delegate as a card: who it is, what state it is in, and the one thing it
 * is doing. No trunk, no lanes — the board is a roster, and a card opens the
 * delegate's own transcript.
 */
const BoardCard = memo(function BoardCard({
  t,
  row,
  now,
  onOpen,
}: {
  t: TFunction;
  row: SubagentBoardRow;
  now: number;
  onOpen: (row: SubagentBoardRow) => void;
}) {
  const detail = cardDetail(t, row);
  return (
    <li className="subagent-board-card" data-outcome={row.outcome}>
      <button type="button" className="subagent-board-card-hit" onClick={() => onOpen(row)}>
        <span className="subagent-board-avatar" aria-hidden="true">
          <SubagentAvatar name={row.agentName || "agent"} size={28} />
        </span>
        <span className="subagent-board-card-copy">
          <span className="subagent-board-card-head">
            <span className="subagent-board-card-name">
              {subagentDisplayName(t, row.agentName)}
            </span>
            <span className="subagent-board-card-state">{cardState(t, row, now)}</span>
          </span>
          <span
            className={`subagent-board-card-detail${row.outcome === "running" ? " is-command" : ""}`}
            title={detail || undefined}
          >
            {detail || "\u00a0"}
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
      </header>
      {!board ? (
        <p className="subagent-board-empty">{t("chat.subagentBoardEmpty")}</p>
      ) : (
        <>
          <ul
            className="subagent-board-cards"
            data-single={board.rows.length === 1 ? "true" : undefined}
            aria-label={t("chat.subagentTopology")}
          >
            {board.rows.map((row) => (
              <BoardCard
                key={row.id}
                t={t}
                row={row}
                now={now}
                onOpen={(target) => {
                  openSubagentTab(target.id, target.agentName || undefined);
                  onClose();
                }}
              />
            ))}
          </ul>
          <footer className="subagent-board-footer">
            {t("chat.subagentBoardFooter", {
              count: board.rows.length,
              elapsed: elapsedLabel(board.startedAt, end),
            })}
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * The topbar entry to the subagent board.
 *
 * The board opens when the pointer comes to rest on the button and closes when
 * it leaves both; a click or the keyboard pins it open, for a pointer that has
 * nowhere to rest. The button subscribes to one boolean — is a delegate
 * running in the open session — so streamed tokens never re-render the topbar.
 * The board itself mounts only while it is open, and that is the only time the
 * transcript is read and the clock ticks.
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
  const hover = useHoverMenu();
  const [pinned, setPinned] = useState(false);
  const open = hover.open || pinned;
  const close = () => {
    setPinned(false);
    hover.close();
  };
  const lastSession = useRef(sessionId);
  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId;
      setPinned(false);
      hover.close();
    }
  }, [sessionId, hover.close]);
  if (!sessionId) return null;

  return (
    <span className="subagent-board-anchor" {...hover.anchorProps}>
      <AnchoredMenu
        open={open}
        onClose={close}
        menuClassName="subagent-board-popover"
        label={t("chat.subagentBoard")}
        role="dialog"
        align="end"
        side="bottom"
        initialFocus="none"
        restoreFocus={false}
        trigger={(ref) => (
          // No tooltip: the board itself is what resting on the button shows.
          <button
            ref={ref}
            type="button"
            className={`ct-icon-btn subagent-board-button${open ? " active" : ""}`}
            aria-label={t("chat.subagentBoard")}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-running={running ? "true" : undefined}
            onClick={() => setPinned((current) => !current)}
          >
            <IconWorkflow size={15} />
            {running ? <span className="subagent-board-button-dot" aria-hidden="true" /> : null}
          </button>
        )}
      >
        {open ? (
          <div className="subagent-board-hover" {...hover.menuProps}>
            <BoardPanel sessionId={sessionId} running={sessionRunning} onClose={close} />
          </div>
        ) : null}
      </AnchoredMenu>
    </span>
  );
});
