import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type BackgroundTaskOutput,
  type BackgroundTaskSummary,
} from "../lib/api";
import { Button } from "./ui";

/** Characters shown when a finished task produced no output at all. */
const NO_OUTPUT = "—";

/**
 * Shows chat-started background commands (dev servers, watchers) above the
 * composer. The lifecycle lives in host-core — a task survives turn aborts
 * and renderer reloads; this bar only reflects registry state and can stop a
 * task on request. Every task is listed; running ones float to the top.
 */
export function BackgroundTasksBar(): React.JSX.Element | null {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<BackgroundTaskSummary[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      const result = await api.backgroundTasksList();
      setTasks(result.tasks);
    } catch {
      // Host may be mid-restart; keep the last snapshot and retry on the
      // next change event rather than flashing an error bar.
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.onBackgroundTasksChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const toggleOutput = useCallback(async (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    try {
      setOutput(await api.backgroundTasksOutput(id));
    } catch {
      setOutput(null);
    }
  }, []);

  const stop = useCallback(async (id: string) => {
    setStoppingIds((current) => new Set(current).add(id));
    try {
      await api.backgroundTasksStop(id);
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const hasRunning = useMemo(
    () => tasks.some((task) => task.state === "running"),
    [tasks],
  );

  // Elapsed time comes from the host snapshot, so a running task needs a
  // periodic re-list; without it the bar freezes at the last state change.
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  if (tasks.length === 0) return null;

  return (
    <div
      className="background-tasks-bar"
      role="region"
      aria-label={t("backgroundTasks.title")}
    >
      {tasks.map((task) => {
        const isRunning = task.state === "running";
        const stopping = stoppingIds.has(task.id);
        return (
          <div
            key={task.id}
            className="background-task"
            data-state={task.state}
          >
            <span
              className="background-task-state"
              data-state={task.state}
              title={t(`backgroundTasks.${task.state}`)}
            />
            <span className="background-task-command" title={task.command}>
              {task.command}
            </span>
            <span className="background-task-meta">
              {t(`backgroundTasks.${task.state}`)}
              {isRunning ? ` · ${formatElapsed(task.elapsedMs)}` : ""}
              {task.exitCode !== undefined ? ` · ${task.exitCode}` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="background-task-action"
              onClick={() => void toggleOutput(task.id)}
              aria-expanded={expandedId === task.id}
            >
              {t("backgroundTasks.output")}
            </Button>
            {isRunning ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="background-task-action is-stop"
                onClick={() => void stop(task.id)}
                disabled={stopping}
              >
                {stopping ? t("backgroundTasks.stopping") : t("backgroundTasks.stop")}
              </Button>
            ) : null}
            {expandedId === task.id ? (
              <pre className="background-task-output">
                {formatOutput(output, task.id) || NO_OUTPUT}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatOutput(
  output: BackgroundTaskOutput | null,
  id: string,
): string {
  if (!output || output.id !== id) return "";
  const tail = (text: string, limit: number) =>
    text.length > limit ? `…${text.slice(-limit)}` : text;
  return [tail(output.stdout, 8000), tail(output.stderr, 4000)]
    .filter((part) => part.length > 0)
    .join("\n---\n")
    .trim();
}
