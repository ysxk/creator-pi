import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo, TodoStatus } from "@pi-desktop/shared";
import { Button } from "./ui";
import { IconChevronDown, IconChevronUp } from "./icons";
import {
  checklistSummary,
  checklistVisible,
  latestPromptTime,
} from "../features/chat/todos/finished-checklist";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { useAppStore } from "../stores/app-store";

/**
 * One status mark per row (D683): a filled circle with a check for done work,
 * a turning arc for the item in progress, a dashed ring for work not started,
 * and a struck ring for cancelled work. The row text stays one colour, so the
 * mark alone carries the state.
 */
function TodoStatusMark({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.1 8.2 7.1 10.1 10.9 6.1"
            fill="none"
            stroke="var(--todo-dock-mark-ink)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "in_progress":
      return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="todo-dock-mark-spinner">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.22" />
          <path
            d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "cancelled":
      return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M3.6 12.4 12.4 3.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeDasharray="2.1 2.1"
          />
        </svg>
      );
  }
}

export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const running = useAppStore((state) => state.runningSessions[sessionId] ?? false);
  const turnStartedAt = useAppStore((state) =>
    state.activeSessionId === sessionId ? latestPromptTime(state.messages) : undefined,
  );
  // The checklist is open by default, as a plan the user reads while the
  // agent works (D683); collapsing it is the user's choice for this session.
  const [expanded, setExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const currentIndex = snapshot?.todos.findIndex((todo) => todo.status === "in_progress") ?? -1;

  useEffect(() => {
    setExpanded(true);
  }, [sessionId]);

  // Keep the item in progress inside the scrollport of a long list without
  // moving focus or the transcript behind it.
  useEffect(() => {
    const list = listRef.current;
    if (!expanded || !list || currentIndex < 0) return;
    const row = list.children[currentIndex] as HTMLElement | undefined;
    if (!row) return;
    // One row of context either side, so the next step shows too.
    const top = Math.max(0, row.offsetTop - row.offsetHeight);
    const bottom = row.offsetTop + row.offsetHeight * 2;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [expanded, currentIndex]);

  useSessionTodosRecovery(sessionId);
  if (!snapshot || snapshot.todos.length === 0) return null;
  // The checklist leaves with the turn that wrote it (D672, D699).
  if (!checklistVisible({ running, updatedAt: snapshot.updatedAt, turnStartedAt })) {
    return null;
  }
  const summary = checklistSummary(snapshot);
  const { completed, total, allCancelled, finished, current } = summary;
  const summaryLabel = allCancelled
    ? t("chat.todo.status.cancelled")
    : finished
      ? t("chat.todo.completed", { completed, total })
      : current
        ? current.content
        : t("chat.todo.progress", { completed, total });

  return (
    <div className={`todo-dock${expanded ? " is-expanded" : ""}`}>
      <Button
        type="button"
        variant="ghost"
        className="todo-dock-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
        title={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
        onClick={() => setExpanded((value) => !value)}
      >
        {allCancelled ? null : (
          <span className="todo-dock-progress">
            {completed}/{total}
          </span>
        )}
        {expanded ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
      </Button>
      {expanded ? (
        // The open dock lists every row (#1319): the list scrolls inside its
        // own box instead of truncating to a static "N more" line.
        <div ref={listRef} className="todo-dock-list" role="list" tabIndex={0}>
          {snapshot.todos.map((todo, index) => (
            <TodoRow key={`${index}:${todo.content}`} todo={todo} />
          ))}
        </div>
      ) : (
        <div className={`todo-dock-row todo-dock-summary todo-dock-row-${summary.status}`}>
          <span className="todo-dock-row-mark" aria-hidden>
            <TodoStatusMark status={summary.status} />
          </span>
          <span className="todo-dock-row-content" title={summaryLabel}>
            {summaryLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function TodoRow({ todo }: { todo: SessionTodo }) {
  const { t } = useTranslation();
  const label = t(`chat.todo.status.${todo.status}`);
  return (
    <div className={`todo-dock-row todo-dock-row-${todo.status}`} role="listitem">
      <span className="todo-dock-row-mark" role="img" aria-label={label} title={label}>
        <TodoStatusMark status={todo.status} />
      </span>
      <span className="todo-dock-row-content" title={todo.content}>
        {todo.content}
      </span>
    </div>
  );
}
