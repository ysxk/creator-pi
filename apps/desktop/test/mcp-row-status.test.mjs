import assert from "node:assert/strict";
import test from "node:test";
import { mcpRowKey, mcpRowStatus } from "../src/lib/mcp-row-status.ts";

const status = (serverId, toolCount) => ({ serverId, state: "ready", toolCount, updatedAt: 1 });
const server = (id) => ({ id, transport: "stdio", enabled: true });

test("a runtime status belongs only to the project the runtime is running", () => {
  const view = {
    statuses: [status("files", 7)],
    statusProjectPath: "/work/a",
    statusProjectServerIds: ["files"],
    rowStatuses: {},
  };
  assert.equal(mcpRowStatus(view, server("files"), "project", "/work/a")?.toolCount, 7);
  assert.equal(
    mcpRowStatus(view, server("files"), "project", "/work/b"),
    undefined,
    "another project's server of the same name is not connected here",
  );
  assert.equal(
    mcpRowStatus(view, server("files"), "global"),
    undefined,
    "a global server shadowed by the running project's own is not the one connected",
  );
});

test("a global server takes the runtime status unless the running project shadows it", () => {
  const view = {
    statuses: [status("search", 3)],
    statusProjectPath: "/work/a",
    statusProjectServerIds: [],
    rowStatuses: {},
  };
  assert.equal(mcpRowStatus(view, server("search"), "global")?.toolCount, 3);
  assert.equal(mcpRowStatus({ ...view, statusProjectPath: null }, server("search"), "global")?.toolCount, 3);
});

test("a row's own test or sign-in result wins, keyed by project and level", () => {
  const view = {
    statuses: [status("files", 7)],
    statusProjectPath: "/work/a",
    statusProjectServerIds: ["files"],
    rowStatuses: { [mcpRowKey("project", "files", "/work/b")]: status("files", 2) },
  };
  assert.equal(mcpRowStatus(view, server("files"), "project", "/work/b")?.toolCount, 2);
  assert.equal(mcpRowStatus(view, server("files"), "project", "/work/a")?.toolCount, 7);
  assert.notEqual(mcpRowKey("project", "files", "/work/a"), mcpRowKey("project", "files", "/work/b"));
  assert.notEqual(mcpRowKey("global", "files"), mcpRowKey("project", "files", "/work/a"));
});

test("project paths match with or without a trailing separator", () => {
  const view = {
    statuses: [status("files", 7)],
    statusProjectPath: "/work/a/",
    statusProjectServerIds: ["files"],
    rowStatuses: {},
  };
  assert.equal(mcpRowStatus(view, server("files"), "project", "/work/a")?.toolCount, 7);
  assert.equal(mcpRowStatus(view, server("files"), "global"), undefined);
});

test("the open project's own servers come with the statuses, not from the filtered list", () => {
  // The page is narrowed to project B, so project A (the one running) is not
  // among the listed groups; its own `files` still shadows the global one.
  const view = {
    statuses: [status("files", 7)],
    statusProjectPath: "/work/a",
    statusProjectServerIds: ["files"],
    rowStatuses: {},
  };
  assert.equal(mcpRowStatus(view, server("files"), "global"), undefined);
  assert.equal(mcpRowStatus({ ...view, statusProjectServerIds: [] }, server("files"), "global")?.toolCount, 7);
});
