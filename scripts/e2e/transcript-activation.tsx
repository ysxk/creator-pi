import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import { IPC, type SessionSummary, type UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { Button } from "../../apps/desktop/src/components/ui";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const a = "browser-activation-a";
const b = "browser-activation-b";
const createdAt = "2026-10-20T00:00:00Z";
const row = (id: string): UiMessage => ({ id, role: "user", content: id, createdAt, status: "complete" });
const summaries: SessionSummary[] = [a, b].map((id) => ({
  id, title: id, mode: "agent", providerId: "fixture", modelId: "fixture",
  messageCount: 200, createdAt, updatedAt: createdAt,
}));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  for (let count = 0; count < 180; count++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Transcript activation: ${label}`);
}
function Surface() {
  const active = useAppStore((state) => state.activeSessionId);
  return <>
    <nav>
      {[a, b].map((id) => <Button key={id} data-activate={id}
        onClick={() => void useAppStore.getState().selectSession(id)}>{id}</Button>)}
      <Button data-search onClick={() => void useAppStore.getState().navigateTranscript({
        sessionId: a, messageId: "historical-search-hit", query: "historical",
      })}>Search result</Button>
    </nav>
    <div className="chat-surface" style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {[a, b].map((id) => <SessionPane key={id} sessionId={id} visible={active === id} />)}
    </div>
  </>;
}

export async function transcriptActivationProbe(i18n: i18n) {
  const bridge = window.piDesktop!;
  const originalInvoke = bridge.invoke;
  bridge.invoke = async (channel, ...args) => {
    const input = args[0] as { id?: string; messageAround?: string };
    if (channel === IPC.invoke.sessionGet) {
      const summary = summaries.find((item) => item.id === input.id)!;
      return { ok: true, data: { session: {
        ...summary, messages: [row(input.messageAround ?? `${summary.id}-latest`)],
        messageStart: input.messageAround ? 20 : 100,
        messageEnd: input.messageAround ? 80 : 200,
        hasMoreBefore: true, hasMoreAfter: Boolean(input.messageAround),
      } } };
    }
    if (channel === IPC.invoke.pendingPlans) return { ok: true, data: { plans: [], state: "inactive" } };
    if (channel === IPC.invoke.pendingInteractive) return { ok: true, data: { asks: [], permissions: [] } };
    throw new Error(`Unexpected transcript fixture IPC: ${channel}`);
  };
  useAppStore.setState({
    sessions: summaries, activeSessionId: a, messages: [row(`${a}-latest`)],
    workspace: null, activeProjectPath: null, page: "chat", selectingSessionId: undefined,
    retainedSessionIds: [a, b], retainedTranscripts: { [b]: [row(`${b}-latest`)] },
    transcriptViews: {}, sessionHistory: { [a]: { messageStart: 100, hasMoreBefore: true } },
    runningSessions: { [a]: true }, isRunning: true, workPanelFileRequest: null,
  });
  const root = createRoot(document.getElementById("root")!);
  const visibleText = () => document.querySelector('.session-pane[data-visible="true"]')?.textContent ?? "";
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  try {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface /></I18nextProvider>));
    await until(() => visibleText().includes(`${a}-latest`), "initial tail");
    click("[data-search]");
    await until(() => visibleText().includes("historical-search-hit"), "completed search");
    click(`[data-activate="${b}"]`);
    await until(() => visibleText().includes(`${b}-latest`), "sidebar B");
    click(`[data-activate="${a}"]`);
    await until(() => visibleText().includes(`${a}-latest`), "ordinary return shows latest, not historical window");
    const ordinaryReturn = !visibleText().includes("historical-search-hit");
    const runningPreserved = useAppStore.getState().isRunning;
    click("[data-search]");
    await until(() => visibleText().includes("historical-search-hit"), "fresh search still navigates");
    return { ordinaryReturn, runningPreserved, freshSearch: true };
  } finally {
    flushSync(() => root.unmount());
    bridge.invoke = originalInvoke;
  }
}
