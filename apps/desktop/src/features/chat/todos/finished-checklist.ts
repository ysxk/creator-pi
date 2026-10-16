import type { SessionTodo, SessionTodoSnapshot, TodoStatus, UiMessage } from "@pi-desktop/shared";

/** Whether nothing on the checklist is left to do: every item completed or cancelled. */
export function checklistFinished(snapshot: Pick<SessionTodoSnapshot, "todos">): boolean {
  return snapshot.todos.every(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  );
}

/**
 * When the turn in progress began: the time of the latest prompt in the
 * transcript. Steering is input to a turn already running, so it does not
 * start one. Returns undefined when the transcript holds no prompt.
 */
export function latestPromptTime(messages: readonly UiMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.steering) continue;
    const time = Date.parse(message.createdAt);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

/**
 * Whether a finished checklist still belongs on screen (D672).
 *
 * It stays while the turn that finished it is running, so its last item is
 * seen being ticked off, and leaves when that turn ends. A checklist finished
 * in an earlier turn does not come back when the next turn starts: it was
 * last written before the prompt that began it.
 */
export function finishedChecklistVisible(input: {
  running: boolean;
  updatedAt: number;
  turnStartedAt: number | undefined;
}): boolean {
  if (!input.running) return false;
  return input.turnStartedAt === undefined || input.updatedAt >= input.turnStartedAt;
}

export interface ChecklistSummary {
  /** Items completed. */
  completed: number;
  /** Items that count toward progress: everything not cancelled. */
  total: number;
  /** The status mark the collapsed dock shows for the whole list. */
  status: TodoStatus;
  /** The item in progress, when there is one and work is still open. */
  current: SessionTodo | undefined;
  allCancelled: boolean;
  finished: boolean;
}

/** What the collapsed dock says about the checklist as a whole (D683). */
export function checklistSummary(snapshot: Pick<SessionTodoSnapshot, "todos">): ChecklistSummary {
  const completed = snapshot.todos.filter((todo) => todo.status === "completed").length;
  const cancelled = snapshot.todos.filter((todo) => todo.status === "cancelled").length;
  const allCancelled = cancelled === snapshot.todos.length;
  const finished = checklistFinished(snapshot);
  const current = snapshot.todos.find((todo) => todo.status === "in_progress");
  const status: TodoStatus = allCancelled
    ? "cancelled"
    : finished
      ? "completed"
      : current
        ? "in_progress"
        : "pending";
  return {
    completed,
    total: snapshot.todos.length - cancelled,
    status,
    current: finished ? undefined : current,
    allCancelled,
    finished,
  };
}
