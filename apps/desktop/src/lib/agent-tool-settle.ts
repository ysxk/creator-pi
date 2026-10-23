import type { AgentEventEnvelope, FsReadResult } from "@pi-desktop/shared";

/** How long after a finished tool call the Files tab re-reads what it shows. */
export const TOOL_SETTLE_DELAY_MS = 300;

type AgentEventSubscribe = (
  listener: (envelope: AgentEventEnvelope) => void,
) => () => void;

/**
 * Call `onSettle` shortly after an agent tool call finishes, in any session.
 * Any tool may write the workspace (a shell command as much as Write or
 * Edit), so every `tool_end` counts. Calls that finish while one is already
 * scheduled ride along with it: their writes are done by then, and a steady
 * stream of tool calls still refreshes every `delayMs` instead of starving.
 */
export function subscribeToolSettled(
  subscribe: AgentEventSubscribe,
  onSettle: () => void,
  delayMs = TOOL_SETTLE_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribe((envelope) => {
    if (envelope.event.type !== "tool_end" || timer) return;
    timer = setTimeout(() => {
      timer = null;
      onSettle();
    }, delayMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
  };
}

/** Whether a re-read returned what the viewer already shows. */
export function sameFsRead(a: FsReadResult, b: FsReadResult): boolean {
  return (
    a.kind === b.kind &&
    a.size === b.size &&
    a.content === b.content &&
    a.dataUrl === b.dataUrl
  );
}
