import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildSubagentBoard, hasRunningDelegation, laneGeometry } = await import(
  "../src/lib/subagent-board.ts"
);

const T0 = Date.parse("2026-10-09T08:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

function user(id, seconds = 0) {
  return { id, role: "user", content: "go", createdAt: at(seconds) };
}

function task(id, agent, status, timing = {}) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: at(1),
    toolName: "Task",
    toolCallId: id,
    toolStatus: status === "creating" ? "running" : "success",
    toolArgs: { agent, description: `work for ${agent}` },
    ...(status === "creating"
      ? {}
      : { toolResult: { details: { delegationId: `d-${id}`, status, ...timing } } }),
  };
}

function childTool(id, parent, agentName, toolName, toolArgs, toolStatus = "success") {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: at(2),
    toolName,
    toolCallId: id,
    toolStatus,
    toolArgs,
    parentToolCallId: parent,
    agentName,
  };
}

test("the board lists the current turn's delegates with what each is doing", () => {
  const messages = [
    user("u1"),
    task("t1", "explorer", "running", { startedAt: at(2) }),
    childTool("c1", "t1", "explorer", "Read", { path: "src/a.ts" }),
    childTool("c2", "t1", "explorer", "Bash", { command: "grep -rn theme src" }, "running"),
    task("t2", "code-reviewer", "completed", { startedAt: at(3), completedAt: at(9) }),
    childTool("c3", "t2", "code-reviewer", "Read", { path: "src/b.ts" }),
  ];
  const board = buildSubagentBoard(messages, { turnLive: true });

  assert.equal(board.rows.length, 2);
  assert.equal(board.running, 1);
  const [explorer, reviewer] = board.rows;
  assert.equal(explorer.id, "d-t1");
  assert.equal(explorer.agentName, "explorer");
  assert.equal(explorer.outcome, "running");
  assert.equal(explorer.steps, 2);
  // The running tool wins over the one that finished before it.
  assert.match(explorer.activity, /grep -rn theme src/);
  assert.equal(explorer.completedAt, undefined);
  assert.equal(reviewer.outcome, "completed");
  assert.equal(reviewer.completedAt - reviewer.startedAt, 6000);
  // The board starts with its first delegate and has no end while one runs.
  assert.equal(board.startedAt, T0 + 2000);
  assert.equal(board.completedAt, undefined);
});

test("a delegate left running by a finished turn was aborted with it", () => {
  const messages = [user("u1"), task("t1", "fixer", "running", { startedAt: at(2) })];
  assert.equal(buildSubagentBoard(messages, { turnLive: true }).rows[0].outcome, "running");
  const settled = buildSubagentBoard(messages, { turnLive: false });
  assert.equal(settled.rows[0].outcome, "aborted");
  assert.equal(settled.running, 0);
});

test("a Task that has no handle yet is still being created", () => {
  const board = buildSubagentBoard([user("u1"), task("t1", "explorer", "creating")], {
    turnLive: true,
  });
  assert.equal(board.rows[0].creating, true);
  assert.equal(board.rows[0].id, "t1");
  assert.equal(board.rows[0].outcome, "running");
});

test("the board follows the latest turn that delegated, and is absent otherwise", () => {
  assert.equal(buildSubagentBoard([user("u1")], { turnLive: true }), null);
  const messages = [
    user("u1"),
    task("t1", "explorer", "completed", { startedAt: at(2), completedAt: at(4) }),
    user("u2", 20),
    { id: "a2", role: "assistant", content: "done", createdAt: at(21) },
  ];
  // A later turn without delegations does not hide the last one that had them.
  const board = buildSubagentBoard(messages, { turnLive: true });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].outcome, "completed");
  assert.equal(board.completedAt, T0 + 4000);
});

test("the topbar's running check stops at the turn's own user message", () => {
  const running = task("t1", "explorer", "running", { startedAt: at(2) });
  assert.equal(hasRunningDelegation([user("u1"), running]), true);
  assert.equal(
    hasRunningDelegation([user("u1"), task("t1", "explorer", "completed")]),
    false,
  );
  // An older turn's leftover snapshot is not this turn's work.
  assert.equal(hasRunningDelegation([user("u1"), running, user("u2", 30)]), false);
  // A delegate's own rows never count as a delegation start.
  assert.equal(
    hasRunningDelegation([
      user("u1"),
      childTool("c1", "t0", "explorer", "Task", {}, "running"),
    ]),
    false,
  );
});

test("lanes sit on the board's own timeline and are never invisible", () => {
  const board = { startedAt: 0, completedAt: 100 };
  assert.deepEqual(laneGeometry({ startedAt: 0, completedAt: 50 }, board, 0), {
    offset: 0,
    width: 0.5,
  });
  assert.deepEqual(laneGeometry({ startedAt: 50, completedAt: 100 }, board, 0), {
    offset: 0.5,
    width: 0.5,
  });
  // A running lane grows to "now" on a board that has not ended.
  assert.deepEqual(laneGeometry({ startedAt: 50 }, { startedAt: 0 }, 200), {
    offset: 0.25,
    width: 0.75,
  });
  // Just started: a sliver, pulled back inside the track.
  const sliver = laneGeometry({ startedAt: 100, completedAt: 100 }, board, 0);
  assert.equal(sliver.width, 0.02);
  assert.equal(sliver.offset, 0.98);
  assert.deepEqual(laneGeometry({}, board, 0), { offset: 0, width: 0 });
});

test("the topbar button costs one boolean and the board mounts only while open", async () => {
  const source = await readFile(
    new URL("../src/features/chat/subagents/SubagentBoard.tsx", import.meta.url),
    "utf8",
  );
  const topbar = await readFile(
    new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /hasRunningDelegation\(state\.messages\)/);
  assert.match(source, /\{open \? \(\s*<div className="subagent-board-hover" \{\.\.\.hover\.menuProps\}>\s*<BoardPanel/);
  // Resting on the button opens the board; a click pins it for the keyboard.
  assert.match(source, /const open = hover\.open \|\| pinned;/);
  assert.match(source, /className="subagent-board-anchor" \{\.\.\.hover\.anchorProps\}/);
  // A roster of cards: no trunk, no lanes.
  assert.match(source, /className="subagent-board-cards"/);
  assert.doesNotMatch(source, /subagent-board-(root|lane|row)\b/);
  // The clock ticks only while something is still running.
  assert.match(source, /if \(!live\) return;\s*setNow\(Date\.now\(\)\);\s*const timer = window\.setInterval/);
  // The topbar itself gains no subscription to the transcript.
  assert.match(topbar, /<SubagentBoardButton \/>/);
  assert.doesNotMatch(topbar, /state\.messages/);
});
