import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("TodoDock renders bounded session progress and cancelled state", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = () =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TodoDock, { sessionId: "session-todo-test" }),
        ),
      );

    // The checklist is on screen only while a turn runs (D672, D699).
    Object.assign(useAppStore.getInitialState(), {
      runningSessions: { "session-todo-test": true },
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 3,
          updatedAt: 100,
          todos: [
            { content: "first", status: "completed", priority: "medium" },
            { content: "second", status: "in_progress", priority: "high" },
            ...Array.from({ length: 10 }, (_, index) => ({
              content: `extra-${index}`,
              status: "pending",
              priority: "low",
            })),
          ],
        },
      },
    });
    const html = render();
    // The checklist opens by default, the way the agent's plan is read (D683).
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /aria-label="Collapse checklist"/);
    assert.match(html, /class="todo-dock-progress">1\/12</);
    assert.match(html, /extra-0/);
    // The open dock lists every row (#1319): the whole list is mounted, and
    // the dock scrolls inside instead of printing a static overflow line.
    assert.equal((html.match(/role="listitem"/g) ?? []).length, 12, "every ordered row renders");
    assert.doesNotMatch(html, /more items/);
    assert.match(html, /class="todo-dock-list" role="list" tabindex="0"/);
    // One status mark per row, no tinted tiles: done, turning, waiting.
    assert.match(html, /todo-dock-row-completed[\s\S]*?aria-label="Completed"/);
    assert.equal((html.match(/todo-dock-mark-spinner/g) ?? []).length, 1);
    assert.equal((html.match(/stroke-dasharray/g) ?? []).length, 10);

    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 4,
          updatedAt: 101,
          todos: [
            { content: "cancelled work", status: "cancelled", priority: "low" },
          ],
        },
      },
    });
    assert.match(render(), /Cancelled/);
    assert.doesNotMatch(render(), /0\/0/);
  } finally {
    await server.close();
  }
});

test("a finished checklist leaves with the turn that finished it", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const sessionId = "session-finished-todos";
    const prompt = (createdAt, extra = {}) => ({
      id: `m-${createdAt}`, role: "user", content: "go", status: "complete", createdAt, ...extra,
    });
    const render = (state) => {
      Object.assign(useAppStore.getInitialState(), {
        activeSessionId: sessionId,
        runningSessions: {},
        messages: [],
        ...state,
      });
      return renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(TodoDock, { sessionId })),
      );
    };
    const checklist = (todos, updatedAt) => ({
      sessionTodos: { [sessionId]: { sessionId, revision: 7, updatedAt, todos } },
    });
    const finishedAt = Date.parse("2026-10-12T08:00:30.000Z");
    const finished = checklist(
      [
        { content: "audit", status: "completed", priority: "medium" },
        { content: "skipped scan", status: "cancelled", priority: "low" },
      ],
      finishedAt,
    );
    const promptBefore = prompt("2026-10-12T08:00:00.000Z");
    const promptAfter = prompt("2026-10-12T08:05:00.000Z");

    // Still running the turn that finished it: the last tick is visible.
    const live = render({ ...finished, runningSessions: { [sessionId]: true }, messages: [promptBefore] });
    assert.match(live, /1\/1/);
    // Steering is input to the same turn, so it does not retire the checklist.
    assert.notEqual(
      render({
        ...finished,
        runningSessions: { [sessionId]: true },
        messages: [promptBefore, prompt("2026-10-12T08:01:00.000Z", { steering: true })],
      }),
      "",
    );
    // The turn ended: nothing is left hanging above the composer.
    assert.equal(render({ ...finished, messages: [promptBefore] }), "");
    // The next turn does not bring the old checklist back.
    assert.equal(
      render({ ...finished, runningSessions: { [sessionId]: true }, messages: [promptBefore, promptAfter] }),
      "",
    );
  } finally {
    await server.close();
  }
});

test("a checklist with open work leaves when its turn stops (D699)", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const sessionId = "session-open-todos";
    const prompt = (createdAt) => ({
      id: `m-${createdAt}`, role: "user", content: "go", status: "complete", createdAt,
    });
    const render = (state) => {
      Object.assign(useAppStore.getInitialState(), {
        activeSessionId: sessionId,
        runningSessions: {},
        messages: [],
        ...state,
      });
      return renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(TodoDock, { sessionId })),
      );
    };
    const open = (updatedAt) => ({
      sessionTodos: {
        [sessionId]: {
          sessionId,
          revision: 3,
          updatedAt,
          todos: [
            { content: "audit", status: "completed", priority: "medium" },
            { content: "render", status: "in_progress", priority: "medium" },
            { content: "report", status: "pending", priority: "medium" },
          ],
        },
      },
    });
    const promptBefore = prompt("2026-10-23T08:00:00.000Z");
    const promptAfter = prompt("2026-10-23T08:05:00.000Z");
    const writtenInFirstTurn = open(Date.parse("2026-10-23T08:00:30.000Z"));
    const running = { runningSessions: { [sessionId]: true } };

    // The turn that wrote it is running: the plan is read as it advances.
    assert.match(render({ ...writtenInFirstTurn, ...running, messages: [promptBefore] }), /1\/3/);
    // The turn was interrupted, failed or ended with work left: the plan
    // does not hang above the composer with a step still turning.
    assert.equal(render({ ...writtenInFirstTurn, messages: [promptBefore] }), "");
    // A later turn does not bring it back on its own...
    assert.equal(
      render({ ...writtenInFirstTurn, ...running, messages: [promptBefore, promptAfter] }),
      "",
    );
    // ...but does once the agent picks the plan up again in that turn.
    assert.match(
      render({
        ...open(Date.parse("2026-10-23T08:05:10.000Z")),
        ...running,
        messages: [promptBefore, promptAfter],
      }),
      /1\/3/,
    );
  } finally {
    await server.close();
  }
});

test("the collapsed dock summarises the checklist by its item in progress", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { checklistSummary } = await server.ssrLoadModule("/src/features/chat/todos/finished-checklist.ts");
    const item = (content, status) => ({ content, status, priority: "medium" });
    const open = checklistSummary({
      todos: [item("audit", "completed"), item("write report", "in_progress"), item("ship", "pending")],
    });
    assert.equal(open.status, "in_progress");
    assert.equal(open.current?.content, "write report");
    assert.deepEqual([open.completed, open.total], [1, 3]);

    const waiting = checklistSummary({ todos: [item("audit", "completed"), item("ship", "pending")] });
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.current, undefined);

    const done = checklistSummary({ todos: [item("audit", "completed"), item("skip", "cancelled")] });
    assert.equal(done.status, "completed");
    assert.deepEqual([done.completed, done.total, done.finished], [1, 1, true]);

    const dropped = checklistSummary({ todos: [item("skip", "cancelled")] });
    assert.equal(dropped.status, "cancelled");
    assert.equal(dropped.allCancelled, true);
  } finally {
    await server.close();
  }
});

test("TodoDock is a quiet card with status marks and a bounded scrollport", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");
  assert.match(css, /\.todo-dock-toggle:active:not\(:disabled\)\s*\{[\s\S]*?transform:\s*none;/);
  // No tinted tiles behind rows: the mark carries the state.
  assert.doesNotMatch(css, /\.todo-dock-row[^{]*\{[^}]*background/);
  assert.match(css, /\.todo-dock-row-cancelled \.todo-dock-row-content\s*\{[\s\S]*?line-through/);
  // The list is the scrollport (#1319): bounded height, internal scroll, no
  // chaining into the transcript, and reachable from the keyboard.
  assert.match(
    css,
    /\.todo-dock-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/,
  );
  assert.match(css, /\.todo-dock-list:focus-visible\s*\{[\s\S]*?outline:/);
  assert.doesNotMatch(css, /\.todo-dock-more\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.todo-dock-mark-spinner\s*\{\s*animation:\s*none;/);
});
