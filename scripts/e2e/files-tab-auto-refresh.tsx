import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

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
      const entries = (listings[rel] ?? []).map((name) => ({ name, kind: "file" }));
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      await sleep(600);
      const readsAfterMessage = readPaths.length - readsBeforeEdit;

      // The agent edits the open file and adds one; three tool calls end at once.
      files[targetPath] = lines("line 1 edited by agent");
      listings[""] = [notesPath, targetPath, "added.txt"];
      emitAgentEvent("tool_end");
      emitAgentEvent("tool_end");
      emitAgentEvent("tool_end");
      await until(() => viewerText().includes("line 1 edited by agent"), "edited file content");
      await sleep(600);
      const editRefresh = {
        reads: readPaths.slice(readsBeforeEdit),
        lists: listPaths.slice(listsBeforeEdit),
        scrollTop: viewer.scrollTop,
        lineJumps: scrollCalls.length,
      };

      // A re-read still in flight when the user opens another file must not land.
      const held: NonNullable<typeof heldRead> = { path: targetPath };
      heldRead = held;
      emitAgentEvent("tool_end");
      await until(() => held.release !== undefined, "held re-read");
      document.querySelector<HTMLButtonElement>(".file-viewer-header .icon-btn")!.click();
      await until(() => treeNames().includes("added.txt"), "refreshed tree after back");
      const treeAfterBack = treeNames();
      const notesRow = [...document.querySelectorAll<HTMLButtonElement>(".file-tree-row")]
        .find((row) => row.textContent?.includes(notesPath));
      notesRow!.click();
      await until(() => viewerText().includes("notes before"), "notes file");
      held.release!("STALE TARGET CONTENT");
      await sleep(300);

      return {
        readsAfterMessage,
        editRefresh,
        treeAfterBack,
        viewerPath: document.querySelector(".file-viewer-path")?.textContent ?? null,
        viewerShowsStale: viewerText().includes("STALE TARGET CONTENT"),
        viewerShowsNotes: viewerText().includes("notes before"),
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
      readsAfterMessage: number;
      editRefresh: { reads: string[]; lists: string[]; scrollTop: number; lineJumps: number };
      treeAfterBack: Array<string | null>;
      viewerPath: string | null;
      viewerShowsStale: boolean;
      viewerShowsNotes: boolean;
    }>;
  }
}
