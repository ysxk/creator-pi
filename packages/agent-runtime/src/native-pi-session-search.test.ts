import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativePiSessionService } from "./native-pi-session.js";
import { NativePiSessionCatalog } from "./native-pi-session-catalog.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const roots: string[] = [];

beforeEach(() => {
  vi.mocked(readFileSync).mockClear();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in search fixtures"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function source(id: string, cwd: string, text = "alpha needle") {
  return [
    { type: "session", version: 3, id, timestamp: "2026-09-14T00:00:00.000Z", cwd },
    { type: "message", id: "user", parentId: null, timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-native-search-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const sessionRoot = join(agentDir, "sessions");
  const project = join(root, "project");
  mkdirSync(sessionRoot, { recursive: true });
  mkdirSync(project);
  const file = join(sessionRoot, "one.jsonl");
  const text = source("one", project);
  writeFileSync(file, text);
  const service = new NativePiSessionService({
    agentDir, sessionRoot,
    modelRuntimeFactory: async () => { throw new Error("No provider configured in fixture"); },
  });
  return { root, agentDir, sessionRoot, project, file, text, service };
}

function reads(path: string) {
  return vi.mocked(readFileSync).mock.calls.filter(([file]) => file === path).length;
}

describe("native session search projections", () => {
  it("reads each file once on cold search and reuses it across queries and list refreshes", async () => {
    const f = fixture();
    const before = readFileSync(f.file);
    vi.mocked(readFileSync).mockClear();
    const first = await f.service.search("needle");
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0]).toMatchObject({ messageCount: 1, matches: [{ messageId: "user" }] });
    expect(reads(f.file)).toBe(1);

    vi.mocked(readFileSync).mockClear();
    expect(await f.service.search("needle")).toEqual(first);
    expect((await f.service.search("alpha")).hits).toHaveLength(1);
    expect((await f.service.search("missing")).hits).toEqual([]);
    expect((await f.service.list())[0]).toEqual(first.hits[0].session);
    expect(reads(f.file)).toBe(0);
    expect(readFileSync(f.file)).toEqual(before);

    const detail = f.service.detail(first.hits[0].session.id, { messageAround: "user", messageLimit: 1 });
    expect(detail?.messages[0]).toMatchObject({ id: "user", content: "alpha needle" });
  });

  it("refreshes only an appended file and discovers newly added sessions", async () => {
    const f = fixture();
    const other = join(f.sessionRoot, "two.jsonl");
    writeFileSync(other, source("two", f.project));
    expect((await f.service.search("needle")).hits).toHaveLength(2);
    appendFileSync(f.file, JSON.stringify({
      type: "message", id: "later", parentId: "user", timestamp: "2026-09-14T00:00:02.000Z",
      message: { role: "user", content: "fresh needle", timestamp: 2 },
    }) + "\n");
    const added = join(f.sessionRoot, "three.jsonl");
    writeFileSync(added, source("three", f.project, "fresh needle"));
    vi.mocked(readFileSync).mockClear();
    const page = await f.service.search("fresh");
    expect(page.hits).toHaveLength(2);
    expect(page.hits.flatMap((hit) => hit.matches.map((match) => match.messageId))).toContain("later");
    expect(reads(f.file)).toBe(1);
    expect(reads(other)).toBe(0);
    expect(reads(added)).toBe(1);
  });

  it("invalidates a same-size edit even when mtime is restored", async () => {
    const f = fixture();
    const time = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(f.file, time, time);
    await f.service.search("alpha");
    const before = statSync(f.file, { bigint: true });
    writeFileSync(f.file, f.text.replace("alpha", "bravo"));
    utimesSync(f.file, time, time);
    expect(statSync(f.file, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect((await f.service.search("alpha")).hits).toEqual([]);
    expect((await f.service.search("bravo")).hits).toHaveLength(1);
  });

  it("invalidates an atomic replacement with equal size and mtime", async () => {
    const f = fixture();
    const time = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(f.file, time, time);
    const original = (await f.service.search("needle")).hits[0].session.id;
    const replacement = join(f.sessionRoot, "replacement.tmp");
    writeFileSync(replacement, source("two", f.project, "bravo needle"));
    utimesSync(replacement, time, time);
    renameSync(replacement, f.file);
    const page = await f.service.search("bravo");
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0].session.id).not.toBe(original);
    expect((await f.service.search("alpha")).hits).toEqual([]);
  });

  it("does not retain deleted files or a removed scan root", async () => {
    const f = fixture();
    await f.service.search("needle");
    rmSync(f.file);
    expect(await f.service.search("needle")).toEqual({ hits: [], nextOffset: null });
    writeFileSync(f.file, source("two", f.project, "bravo needle"));
    expect((await f.service.search("bravo")).hits).toHaveLength(1);
    rmSync(f.sessionRoot, { recursive: true });
    expect(await f.service.search("needle")).toEqual({ hits: [], nextOffset: null });
  });

  it("rechecks workspace availability without rereading an unchanged transcript", async () => {
    const f = fixture();
    const initial = await f.service.search("needle");
    expect(initial.hits[0].session.readOnlyReason).toBe("provider-unavailable");
    rmSync(f.project, { recursive: true });
    vi.mocked(readFileSync).mockClear();
    const page = await f.service.search("needle");
    expect(page.hits[0].session.readOnlyReason).toBe("missing-cwd");
    expect(page.hits[0].session.projectPath).toBeUndefined();
    expect(reads(f.file)).toBe(0);
  });

  it("does not return matches from a duplicate file discarded by discovery", async () => {
    const f = fixture();
    const copy = join(f.sessionRoot, "z-copy.jsonl");
    writeFileSync(copy, source("one", f.project, "bravo needle"));
    expect((await f.service.search("needle")).hits).toHaveLength(1);
    expect((await f.service.search("alpha")).hits).toHaveLength(1);
    expect((await f.service.search("bravo")).hits).toEqual([]);
  });

  it("releases cached file projections on service disposal", async () => {
    const f = fixture();
    await f.service.search("needle");
    f.service.disposeAll();
    vi.mocked(readFileSync).mockClear();
    expect((await f.service.search("needle")).hits).toHaveLength(1);
    expect(reads(f.file)).toBe(1);
  });
});

describe("native catalog resource bounds", () => {
  it("evicts least recently used files at the entry limit", () => {
    const f = fixture();
    const second = join(f.sessionRoot, "two.jsonl");
    const third = join(f.sessionRoot, "three.jsonl");
    writeFileSync(second, source("two", f.project));
    writeFileSync(third, source("three", f.project));
    const catalog = new NativePiSessionCatalog(1024 * 1024, 2);
    catalog.read(f.file);
    catalog.read(second);
    catalog.read(f.file);
    catalog.read(third);
    vi.mocked(readFileSync).mockClear();
    catalog.read(f.file);
    expect(reads(f.file)).toBe(0);
    catalog.read(second);
    expect(reads(second)).toBe(1);
  });

  it("bounds retained source bytes and bypasses caching for oversized files", () => {
    const f = fixture();
    const second = join(f.sessionRoot, "two.jsonl");
    writeFileSync(second, source("two", f.project));
    const catalog = new NativePiSessionCatalog(Buffer.byteLength(f.text), 128);
    catalog.read(f.file);
    catalog.read(second);
    vi.mocked(readFileSync).mockClear();
    catalog.read(second);
    expect(reads(second)).toBe(0);
    catalog.read(f.file);
    expect(reads(f.file)).toBe(1);

    const uncached = new NativePiSessionCatalog(1);
    vi.mocked(readFileSync).mockClear();
    expect(uncached.read(f.file).header.id).toBe("one");
    expect(uncached.read(f.file).header.id).toBe("one");
    expect(reads(f.file)).toBe(2);
  });

  it("reclaims the byte budget after pruning, replacing, and clearing entries", () => {
    const f = fixture();
    const second = join(f.sessionRoot, "two.jsonl");
    writeFileSync(second, source("two", f.project));
    const catalog = new NativePiSessionCatalog(Buffer.byteLength(f.text) * 2, 128);
    catalog.read(f.file);
    catalog.retain(new Set());
    catalog.read(f.file);
    writeFileSync(f.file, f.text.replace("alpha", "bravo"));
    catalog.read(f.file);
    catalog.read(second);
    vi.mocked(readFileSync).mockClear();
    catalog.read(f.file);
    catalog.read(second);
    expect(reads(f.file) + reads(second)).toBe(0);
    catalog.clear();
    catalog.read(f.file);
    catalog.read(second);
    expect(reads(f.file) + reads(second)).toBe(2);
  });

  it("does not cache a snapshot read while the file is changing", async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync).mockImplementationOnce((path, options) => {
      const bytes = actual.readFileSync(path, options);
      appendFileSync(f.file, "\n");
      return bytes;
    });
    const catalog = new NativePiSessionCatalog();
    expect(() => catalog.read(f.file)).toThrow("changed during discovery");
    vi.mocked(readFileSync).mockClear();
    expect(catalog.read(f.file).snapshot.bytes.toString("utf8")).toBe(f.text + "\n");
    expect(reads(f.file)).toBe(1);
  });
});

it("keeps a warm subset when a full catalog scan exceeds the cache entry limit", async () => {
  const f = fixture();
  for (let index = 0; index < 128; index++) {
    writeFileSync(join(f.sessionRoot, `extra-${index}.jsonl`), source(`extra-${index}`, f.project));
  }
  const cold = await f.service.search("needle");
  expect(cold.hits).toHaveLength(129);
  vi.mocked(readFileSync).mockClear();
  expect(await f.service.search("needle")).toEqual(cold);
  const transcriptReads = vi.mocked(readFileSync).mock.calls.filter(([path]) =>
    typeof path === "string" && path.startsWith(f.sessionRoot) && path.endsWith(".jsonl"),
  );
  expect(transcriptReads).toHaveLength(1);
});
