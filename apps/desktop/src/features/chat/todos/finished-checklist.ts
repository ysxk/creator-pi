import type { SessionTodoSnapshot, UiMessage } from "@pi-desktop/shared";

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
