import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { transcriptActivationProbe } from "./transcript-activation";

const browserErrors: string[] = [];
window.addEventListener("error", (event) => browserErrors.push(event.message));
window.addEventListener("unhandledrejection", (event) => browserErrors.push(String(event.reason)));
const targetPath = "target.txt";
const notesPath = "notes.txt";
const targetLine = 65;
const lines = (first: string) =>
  [first, ...Array.from({ length: 89 }, (_, index) => `line ${index + 2}`)].join("\n");

const files: Record<string, string> = {
  [targetPath]: lines("line 1"),
  [notesPath]: "notes before",
};
const listings: Record<string, string[]> = { "": [notesPath, targetPath] };
const readPaths: string[] = [];
const listPaths: string[] = [];
const scrollCalls: string[] = [];
/** When set, the next read of this path waits until the probe releases it. */
let heldRead: { path: string; release?: (content: string) => void } | null = null;
let heldList: { path: string; release?: (names: string[]) => void } | null = null;
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

const textResult = (content: string) => ({ kind: "text", content, size: content.length });

window.piDesktop = {
  platform: "darwin",
  channels: IPC,
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  async invoke(channel, ...args) {
    const input = args[0] as Record<string, unknown> | undefined;
    if (channel === IPC.invoke.fsList) {
      const rel = String(input?.path ?? "");
      listPaths.push(rel);
      let names = listings[rel] ?? [];
      if (heldList?.path === rel) {
        const held = heldList;
        heldList = null;
        names = await new Promise<string[]>((resolve) => { held.release = resolve; });
      }
      const entries = names.map((name) => ({ name, kind: "file" }));
      return { ok: true, data: { entries } };
    }
    if (channel === IPC.invoke.fsRead) {
      const path = String(input?.path ?? "");
      readPaths.push(path);
      if (heldRead?.path === path) {
        const held = heldRead;
        heldRead = null;
        const content = await new Promise<string>((resolve) => {
          held.release = resolve;
        });
        return { ok: true, data: textResult(content) };
      }
      return { ok: true, data: textResult(files[path] ?? "") };
    }
    throw new Error(`Unexpected file viewer IPC: ${channel}`);
  },
};

function emitAgentEvent(type: string) {
  for (const listener of listeners.get(IPC.event.agentMessage) ?? []) {
    listener({
      sessionId: "background-session",
      ts: Date.now(),
      event: { type, toolCallId: `call-${Math.random()}`, result: "ok", isError: false },
    });
  }
}

useAppStore.setState({
  workspace: { path: "/workspace", name: "Fixture" },
  activeSessionId: "fixture-session",
  workPanelFileRequest: null,
});

const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
  scrollCalls.push(this.getAttribute("data-line") ?? "");
  nativeScrollIntoView.call(this, options);
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settleTimers = new Map<number, () => void>();
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
let timerId = -1;
window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (delay !== 300 || typeof callback !== "function") return nativeSetTimeout(callback, delay, ...args);
  const id = timerId--;
  settleTimers.set(id, () => callback(...args));
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (id != null && settleTimers.delete(id)) return;
  nativeClearTimeout(id);
};
async function settleTools() {
  const callbacks = [...settleTimers.values()];
  settleTimers.clear();
  callbacks.forEach((callback) => callback());
  await nextFrame();
  await nextFrame();
}

async function until(predicate: () => boolean, label: string) {
  for (let frame = 0; frame < 240; frame++) {
    if (predicate()) return;
    await nextFrame();
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({ readPaths, listPaths, scrollCalls })}`);
}

const viewerText = () => document.querySelector(".file-viewer-body")?.textContent ?? "";
const treeNames = () =>
  [...document.querySelectorAll(".file-tree-name")].map((node) => node.textContent);

const i18n = createInstance();
void i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const root = createRoot(document.getElementById("root")!);
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <FilesTab />
        </I18nextProvider>,
      ),
    );

    window.filesTabAutoRefreshProbe = async () => {
      await until(() => treeNames().includes(targetPath), "workspace tree");

      // Open the target at a line, as a transcript path:line chip does.
      useAppStore.setState({
        workPanelFileRequest: { path: targetPath, seq: 1, line: targetLine },
      });
      await until(() => scrollCalls.length > 0, "initial line jump");
      const viewer = document.querySelector<HTMLElement>(".file-viewer-body")!;
      // The user scrolls back to the top; a refresh must not jump again.
      viewer.scrollTop = 0;
      const readsBeforeEdit = readPaths.length;
      const listsBeforeEdit = listPaths.length;

      // A non-tool event does not refresh anything.
      emitAgentEvent("message_update");
      await settleTools();
      const readsAfterMessage = readPaths.length - readsBeforeEdit;

      // The agent edits the open file and adds one; three tool calls end at once.
      files[targetPath] = lines("line 1 edited by agent");
      listings[""] = [notesPath, targetPath, "added.txt"];
      emitAgentEvent("tool_end");
      emitAgentEvent("tool_end");
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => viewerText().includes("line 1 edited by agent"), "edited file content");
      await nextFrame();
      const editRefresh = {
        reads: readPaths.slice(readsBeforeEdit),
        lists: listPaths.slice(listsBeforeEdit),
        scrollTop: viewer.scrollTop,
        lineJumps: scrollCalls.length,
      };

      // A second tool settles while the first read is held. Its read must trail,
      // not race the older snapshot back into the same file.
      const overlapping: NonNullable<typeof heldRead> = { path: targetPath };
      heldRead = overlapping;
      const overlapStart = readPaths.length;
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => overlapping.release !== undefined, "first overlapping read");
      files[targetPath] = lines("NEWEST SAME FILE");
      emitAgentEvent("tool_end");
      await settleTools();
      const readsWhileHeld = readPaths.length - overlapStart;
      overlapping.release!(lines("OLDER SAME FILE"));
      await nextFrame();
      await nextFrame();
      const overlap = { readsWhileHeld, newestVisible: viewerText().includes("NEWEST SAME FILE") };

      // A re-read still in flight when the user opens another file must not land.
      const held: NonNullable<typeof heldRead> = { path: targetPath };
      heldRead = held;
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => held.release !== undefined, "held re-read");
      document.querySelector<HTMLButtonElement>(".file-viewer-header .icon-btn")!.click();
      await until(() => treeNames().includes("added.txt"), "refreshed tree after back");
      const treeAfterBack = treeNames();
      const notesRow = [...document.querySelectorAll<HTMLButtonElement>(".file-tree-row")]
        .find((row) => row.textContent?.includes(notesPath));
      notesRow!.click();
      await until(() => viewerText().includes("notes before"), "notes file");
      held.release!("STALE TARGET CONTENT");
      await nextFrame();
      await nextFrame();

      const switched = {
        viewerPath: document.querySelector(".file-viewer-path")?.textContent ?? null,
        viewerShowsStale: viewerText().includes("STALE TARGET CONTENT"),
        viewerShowsNotes: viewerText().includes("notes before"),
      };

      const initial: NonNullable<typeof heldRead> = { path: targetPath };
      heldRead = initial;
      const initialStart = readPaths.length;
      useAppStore.setState({ workPanelFileRequest: { path: targetPath, seq: 2 } });
      await until(() => initial.release !== undefined, "held initial open");
      files[targetPath] = lines("NEWEST AFTER OPEN");
      emitAgentEvent("tool_end");
      await settleTools();
      const initialReadsWhileHeld = readPaths.length - initialStart;
      initial.release!("STALE INITIAL OPEN");
      await until(() => viewerText().includes("NEWEST AFTER OPEN"), "refresh trailing initial open");

      const staleOpen: NonNullable<typeof heldRead> = { path: targetPath };
      heldRead = staleOpen;
      useAppStore.setState({ workPanelFileRequest: { path: targetPath, seq: 3 } });
      await until(() => staleOpen.release !== undefined, "open before file switch");
      useAppStore.setState({ workPanelFileRequest: { path: notesPath, seq: 4 } });
      await until(() => viewerText().includes("notes before"), "replacement file open");
      staleOpen.release!("STALE ORIGINAL OPEN");
      await nextFrame();
      await nextFrame();
      const initialSwitchSafe = viewerText().includes("notes before");

      const workspaceRead: NonNullable<typeof heldRead> = { path: notesPath };
      heldRead = workspaceRead;
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => workspaceRead.release !== undefined, "read before workspace switch");
      emitAgentEvent("tool_end");
      await settleTools();
      useAppStore.setState({ workspace: { path: "/other-workspace", name: "Other" }, workPanelFileRequest: null });
      await until(() => treeNames().includes(targetPath), "new workspace tree");
      const readsAtSwitch = readPaths.length;
      workspaceRead.release!("STALE WORKSPACE");
      await nextFrame();
      await nextFrame();
      const workspaceSafe = !document.querySelector(".file-viewer") && readPaths.length === readsAtSwitch;

      const directory: NonNullable<typeof heldList> = { path: "" };
      heldList = directory;
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => directory.release !== undefined, "directory before workspace round trip");
      listings[""] = [notesPath, targetPath, "middle-workspace.txt"];
      useAppStore.setState({ workspace: { path: "/workspace", name: "Fixture" } });
      await until(() => treeNames().includes("middle-workspace.txt"), "intermediate workspace directory");
      listings[""] = [notesPath, targetPath, "latest-directory.txt"];
      useAppStore.setState({ workspace: { path: "/other-workspace", name: "Other" } });
      await until(() => treeNames().includes("latest-directory.txt"), "returned workspace directory");
      directory.release!(["STALE-DIRECTORY.txt"]);
      await nextFrame();
      await nextFrame();
      const directorySwitchSafe = treeNames().includes("latest-directory.txt") && !treeNames().includes("STALE-DIRECTORY.txt");

      useAppStore.setState({ workPanelFileRequest: { path: notesPath, seq: 5 } });
      await until(() => viewerText().includes("notes before"), "open before unmount");
      const unmounted: NonNullable<typeof heldRead> = { path: notesPath };
      heldRead = unmounted;
      emitAgentEvent("tool_end");
      await settleTools();
      await until(() => unmounted.release !== undefined, "read before unmount");
      emitAgentEvent("tool_end");
      await settleTools();
      emitAgentEvent("tool_end");
      flushSync(() => root.unmount());
      const readsAtUnmount = readPaths.length;
      unmounted.release!("STALE UNMOUNT");
      await settleTools();
      const unmountSafe = readPaths.length === readsAtUnmount &&
        (listeners.get(IPC.event.agentMessage)?.size ?? 0) === 0 && settleTimers.size === 0;

      const transcript = await transcriptActivationProbe(i18n);
      return {
        initialReadsWhileHeld, initialSwitchSafe, workspaceSafe, unmountSafe,
        directorySwitchSafe,
        browserErrors,
        transcript,
        ...switched,
        overlap,
        readsAfterMessage,
        editRefresh,
        treeAfterBack,
      };
    };
  })
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  });

declare global {
  interface Window {
    piDesktop?: {
      platform: NodeJS.Platform;
      channels: typeof IPC;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
    filesTabAutoRefreshProbe: () => Promise<{
      transcript: { ordinaryReturn: boolean; runningPreserved: boolean; freshSearch: boolean };
      browserErrors: string[];
      overlap: { readsWhileHeld: number; newestVisible: boolean };
      initialReadsWhileHeld: number;
      initialSwitchSafe: boolean;
      workspaceSafe: boolean;
      directorySwitchSafe: boolean;
      unmountSafe: boolean;
      readsAfterMessage: number;
      editRefresh: { reads: string[]; lists: string[]; scrollTop: number; lineJumps: number };
      treeAfterBack: Array<string | null>;
      viewerPath: string | null;
      viewerShowsStale: boolean;
      viewerShowsNotes: boolean;
    }>;
  }
}
