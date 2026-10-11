import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openableMediaPath } from "../electron/main/open-attachment-media.ts";

test("an extensionless stored MP4 gets an OS-openable name without copying bytes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-media-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attachments = join(dataDir, "attachments");
  await mkdir(attachments);
  const hash = "a".repeat(64);
  const stored = join(attachments, hash);
  await writeFile(stored, Buffer.alloc(512 * 1024 + 1));
  const storedReal = await realpath(stored);

  const alias = await openableMediaPath(dataDir, storedReal, "video/mp4");
  assert.equal(alias, join(dataDir, "openable-attachments", `${hash}.mp4`));
  assert.equal(await realpath(alias), storedReal);
  assert.equal(await readlink(alias), storedReal);
  assert.equal((await stat(alias)).size, 512 * 1024 + 1);
  assert.equal(await openableMediaPath(dataDir, storedReal, "video/mp4"), alias);
});

test("a stored recording gets the extension of its audio type, however the system spelt it", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-media-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attachments = join(dataDir, "attachments");
  await mkdir(attachments);
  const cases = [
    ["audio/mpeg", "mp3"],
    ["audio/mp3", "mp3"],
    ["audio/x-m4a", "m4a"],
    ["audio/wav; rate=44100", "wav"],
    ["audio/flac", "flac"],
  ];
  for (const [index, [mimeType, extension]] of cases.entries()) {
    const hash = String(index).repeat(64);
    const stored = join(attachments, hash);
    await writeFile(stored, "audio");
    const alias = await openableMediaPath(dataDir, await realpath(stored), mimeType);
    assert.equal(alias, join(dataDir, "openable-attachments", `${hash}.${extension}`), mimeType);
  }
});

test("only a typed content-addressed media blob is given an alias", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-media-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, "clip.mp4");
  await writeFile(file, "video");
  const workspace = join(dataDir, "workspace");
  await mkdir(workspace);
  const hashNamedProjectFile = join(workspace, "b".repeat(64));
  await writeFile(hashNamedProjectFile, "project file");
  const attachments = join(dataDir, "attachments");
  await mkdir(attachments);
  const untyped = join(attachments, "d".repeat(64));
  await writeFile(untyped, "bytes");

  assert.equal(await openableMediaPath(dataDir, file, "video/mp4"), file);
  assert.equal(await openableMediaPath(dataDir, file, "text/plain"), file);
  assert.equal(await openableMediaPath(dataDir, hashNamedProjectFile, "video/mp4"), hashNamedProjectFile);
  // A stored blob of a type the chat does not play keeps its hash name.
  const untypedReal = await realpath(untyped);
  assert.equal(await openableMediaPath(dataDir, untypedReal, "application/pdf"), untypedReal);
  assert.equal(await openableMediaPath(dataDir, untypedReal, undefined), untypedReal);
});

test("an occupied alias cannot redirect the OS handoff", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-media-open-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attachments = join(dataDir, "attachments");
  const aliases = join(dataDir, "openable-attachments");
  await Promise.all([mkdir(attachments), mkdir(aliases)]);
  const hash = "c".repeat(64);
  const stored = join(attachments, hash);
  await writeFile(stored, "audio");
  await writeFile(join(aliases, `${hash}.mp3`), "different file");

  await assert.rejects(
    openableMediaPath(dataDir, await realpath(stored), "audio/mpeg"),
    /already occupied/,
  );
});
