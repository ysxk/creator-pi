import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";

type MessageAppend = {
  key: string;
  sessionId: string;
  message?: unknown;
  usage?: unknown;
  turnId?: string;
};

/**
 * An append the outbox gave up on. The payload is kept verbatim so a user (or
 * a later build) can replay it by hand; quarantined appends are never replayed
 * automatically.
 */
type QuarantinedAppend = MessageAppend & {
  quarantinedAt: string;
  reason: string;
};

/**
 * The appends a transcript rewrite set aside. Exactly one of the two settles
 * it; a second call is ignored.
 */
export type SessionReplacementLease = {
  /** The rewrite landed: the held appends belonged to the replaced history. */
  commit(): Promise<void>;
  /** The rewrite failed: the held appends go back to the front of the queue. */
  rollback(): Promise<void>;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

type OutboxOptions = {
  /** Current time in ms; a test seam for the retry backoff. */
  now?: () => number;
  /** Quarantined appends retained on disk, oldest discarded first. */
  maxDeadLetters?: number;
};

const MAX_ENTRIES = 1024;
/**
 * Consecutive unclassified failures allowed on one queued head before it is
 * quarantined. Bounded so an append the host rejects forever cannot starve
 * every later append from every session (#1560).
 */
const MAX_TRANSIENT_ATTEMPTS = 5;
/** First backoff step before the same head is retried; doubles per attempt. */
const RETRY_BACKOFF_MS = 5_000;
/** Upper bound for one backoff step. */
const MAX_RETRY_BACKOFF_MS = 60_000;
/** Quarantined appends retained for manual recovery. */
const MAX_DEAD_LETTERS = 256;

/**
 * Keeps transcript appends away from a dead host pipe. The file is an
 * application-owned outbox, while SQLite remains exclusively host-owned.
 * Message ids make replay idempotent after a host restart.
 */
export class PersistenceOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly deadLetterPath: string;
  private readonly tempDeadLetterPath: string;
  private readonly logger: OutboxLogger;
  private readonly now: () => number;
  private readonly maxDeadLetters: number;
  private entries: MessageAppend[] = [];
  /**
   * Appends taken out of the queue while their session's transcript is being
   * rewritten. They are not flushed, but they stay in the file until the
   * rewrite settles, so neither a failed rewrite nor a crash loses them.
   */
  private held = new Map<string, MessageAppend[]>();
  private deadLetters: QuarantinedAppend[] = [];
  private flushing: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private headRetry: {
    entry: MessageAppend;
    attempts: number;
    nextAttemptAt: number;
    host: HostProcess;
  } | null = null;
  private readonly loaded: Promise<void>;

  constructor(dataDir: string, logger: OutboxLogger, options: OutboxOptions = {}) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.deadLetterPath = join(dataDir, "session-message-outbox.dead-letter.json");
    this.tempDeadLetterPath = `${this.deadLetterPath}.tmp`;
    this.logger = logger;
    this.now = options.now ?? Date.now;
    this.maxDeadLetters = options.maxDeadLetters ?? MAX_DEAD_LETTERS;
    this.loaded = this.load();
  }

  async enqueue(
    entry: MessageAppend,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.loaded;
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.entries[existing] = entry;
    else {
      if (this.entries.length >= MAX_ENTRIES) await this.flush(getHost);
      if (this.entries.length >= MAX_ENTRIES) {
        this.logger("error", "session persistence outbox is full", {
          key: entry.key,
          sessionId: entry.sessionId,
          size: this.entries.length,
          max: MAX_ENTRIES,
        });
        throw new Error("session persistence outbox is full");
      }
      this.entries.push(entry);
    }
    await this.persist();
    void this.flush(getHost);
  }

  async flush(getHost: () => HostProcess | null): Promise<void> {
    await this.loaded;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(getHost).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Drop queued appends for a session that the user deleted so a later
   * host-side stub recreate cannot resurrect it (D318). Its quarantined
   * appends go with it: they belong to the same deleted conversation.
   */
  async dropSession(sessionId: string): Promise<void> {
    await this.loaded;
    const next = this.entries.filter((entry) => entry.sessionId !== sessionId);
    const nextDeadLetters = this.deadLetters.filter((entry) => entry.sessionId !== sessionId);
    // A deleted session's held appends go too; a pending rewrite of it then
    // has nothing to give back.
    const heldChanged = this.held.delete(sessionId);
    const entriesChanged = next.length !== this.entries.length || heldChanged;
    const deadLettersChanged = nextDeadLetters.length !== this.deadLetters.length;
    if (!entriesChanged && !deadLettersChanged) return;
    this.entries = next;
    this.deadLetters = nextDeadLetters;
    if (entriesChanged) await this.persist();
    if (deadLettersChanged) await this.persistDeadLetters();
  }

  /**
   * A transcript replacement must not be followed by an append that was
   * already in flight when its queued entries were set aside. Drain the
   * current flush first, then hold back whatever could not be written.
   *
   * A drain can end without writing everything (the host is down, or the
   * head is backing off), so the held appends may be the only copy. They are
   * discarded only when the caller commits the rewrite; a rollback puts them
   * back ahead of anything queued meanwhile.
   */
  async prepareSessionReplacement(
    sessionId: string,
    getHost: () => HostProcess | null,
  ): Promise<SessionReplacementLease> {
    await this.flush(getHost);
    if (this.held.has(sessionId)) {
      throw new Error("a transcript replacement is already pending for this session");
    }
    this.held.set(
      sessionId,
      this.entries.filter((entry) => entry.sessionId === sessionId),
    );
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId);
    let settled = false;
    return {
      commit: async () => {
        if (settled) return;
        settled = true;
        this.held.delete(sessionId);
        // Quarantined appends belong to the history that was just replaced.
        const nextDeadLetters = this.deadLetters.filter((entry) => entry.sessionId !== sessionId);
        const deadLettersChanged = nextDeadLetters.length !== this.deadLetters.length;
        this.deadLetters = nextDeadLetters;
        await this.persist();
        if (deadLettersChanged) await this.persistDeadLetters();
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        const held = this.held.get(sessionId) ?? [];
        this.held.delete(sessionId);
        // An append queued during the rewrite under the same key is newer.
        const restored = held.filter(
          (entry) => !this.entries.some((queued) => queued.key === entry.key),
        );
        this.entries = [...restored, ...this.entries];
        await this.persist();
        if (restored.length > 0) void this.flush(getHost);
      },
    };
  }

  size(): number {
    return this.entries.length;
  }

  private async flushLoop(getHost: () => HostProcess | null): Promise<void> {
    while (this.entries.length > 0) {
      const current = this.entries[0];
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      // Bounded backoff: a head that just failed is not retried on every
      // enqueue, so a struggling host is not hammered by a burst. A restarted
      // host is a new generation and retries at once (#1560).
      if (
        this.headRetry?.entry === current &&
        this.headRetry.host === currentHost &&
        this.headRetry.nextAttemptAt > this.now()
      ) {
        return;
      }
      try {
        await currentHost.call(current.usage ? "session.recordUsage" : "session.appendMessage", {
          sessionId: current.sessionId,
          ...(current.usage ? { usage: current.usage } : { message: current.message }),
          turnId: current.turnId,
        });
      } catch (error) {
        // A duplicate message id means the host already has the row; drop it
        // and keep draining (D318/#560).
        if (isDuplicateMessageIdError(error)) {
          this.logger("warn", "session persistence flush skipped duplicate message id", {
            key: current.key,
            data: String(error),
          });
        } else if (isPoisonMessageError(error)) {
          // The host will reject this row forever (provenance / permission
          // on this message). Drop only this entry and keep draining so one
          // poisoned head cannot starve later transcript rows (D597).
          this.logger("warn", "session persistence flush dropped poisoned message", {
            key: current.key,
            data: String(error),
          });
        } else if (isForeignKeyError(error)) {
          // The parent row (session or turn) was lost — typically after a
          // sidecar crash that restarted before the outbox could drain.
          // The host will never accept a child row whose parent is gone,
          // so drop it and keep draining (#996).
          this.logger("warn", "session persistence flush dropped orphaned message", {
            key: current.key,
            data: String(error),
          });
        } else if (isOversizedRequestError(error)) {
          // The request is over the host's line limit and will be on every
          // retry. The queue is shared by every session, so it must not wait
          // behind this row: store a tool row without its payload, and drop
          // anything that is still too large or is not a tool row.
          const reduced = withoutOversizedPayload(current.message);
          if (reduced !== undefined && this.entries[0] === current) {
            this.entries[0] = { ...current, message: reduced };
            this.logger("error", "session persistence flush stored an oversized tool result without its payload", {
              key: current.key,
            });
            await this.persist();
            continue;
          }
          this.logger("error", "session persistence flush dropped oversized message", {
            key: current.key,
            data: String(error),
          });
        } else {
          const attempts = this.noteTransientFailure(current, currentHost);
          if (attempts < MAX_TRANSIENT_ATTEMPTS) {
            // Transient failure (host busy/overloaded/pipe dead). Keep the head
            // and retry it after this attempt's backoff.
            this.logger("warn", "session persistence flush paused", {
              key: current.key,
              sessionId: current.sessionId,
              attempts,
              maxAttempts: MAX_TRANSIENT_ATTEMPTS,
              retryInMs: this.headRetry ? this.headRetry.nextAttemptAt - this.now() : 0,
              data: String(error),
            });
            return;
          }
          // An error the outbox cannot classify as permanent or as a
          // duplicate recurs on every retry. Quarantine the head instead of
          // blocking the whole application queue behind it forever (#1560).
          await this.quarantine(current, attempts, error);
          continue;
        }
      }
      // A newer snapshot may have replaced this key while the host wrote it.
      // Only remove the exact entry acknowledged by that write.
      if (this.entries[0] === current) this.entries.shift();
      this.headRetry = null;
      await this.persist();
    }
  }

  /** Count one failure of the given head and schedule its next attempt. */
  private noteTransientFailure(entry: MessageAppend, host: HostProcess): number {
    const attempts = (this.headRetry?.entry === entry ? this.headRetry.attempts : 0) + 1;
    const backoff = Math.min(RETRY_BACKOFF_MS * 2 ** (attempts - 1), MAX_RETRY_BACKOFF_MS);
    this.headRetry = { entry, attempts, nextAttemptAt: this.now() + backoff, host };
    return attempts;
  }

  /** Move a head the host keeps refusing into the dead-letter file. */
  private async quarantine(entry: MessageAppend, attempts: number, error: unknown): Promise<void> {
    this.deadLetters.push({
      ...entry,
      quarantinedAt: new Date(this.now()).toISOString(),
      reason: String(error),
    });
    while (this.deadLetters.length > this.maxDeadLetters) {
      const dropped = this.deadLetters.shift();
      this.logger("warn", "session persistence outbox dead letter discarded", {
        key: dropped?.key,
        sessionId: dropped?.sessionId,
        max: this.maxDeadLetters,
        file: this.deadLetterPath,
      });
    }
    this.logger("error", "session persistence flush quarantined entry", {
      key: entry.key,
      sessionId: entry.sessionId,
      attempts,
      file: this.deadLetterPath,
      data: String(error),
    });
    if (this.entries[0] === entry) this.entries.shift();
    this.headRetry = null;
    await this.persist();
    await this.persistDeadLetters();
  }

  private async load(): Promise<void> {
    await this.loadEntries();
    await this.loadDeadLetters();
  }

  private async loadEntries(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is MessageAppend => {
          return (
            entry &&
            typeof entry.key === "string" &&
            typeof entry.sessionId === "string" &&
            ("message" in entry || ("usage" in entry && typeof entry.turnId === "string"))
          );
        });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger("warn", "session persistence outbox load failed", String(error));
      }
    }
  }

  private async loadDeadLetters(): Promise<void> {
    try {
      const raw = await readFile(this.deadLetterPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.deadLetters = parsed.filter((entry): entry is QuarantinedAppend => {
          return (
            entry &&
            typeof entry.key === "string" &&
            typeof entry.sessionId === "string" &&
            typeof entry.quarantinedAt === "string" &&
            ("message" in entry || ("usage" in entry && typeof entry.turnId === "string"))
          );
        });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger("warn", "session persistence outbox dead letter load failed", String(error));
      }
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const onDisk = [...[...this.held.values()].flat(), ...this.entries];
      if (onDisk.length === 0) {
        try {
          await writeFile(this.path, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempPath, `${JSON.stringify(onDisk)}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }

  private async persistDeadLetters(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      if (this.deadLetters.length === 0) {
        try {
          await writeFile(this.deadLetterPath, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox dead letter clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempDeadLetterPath, `${JSON.stringify(this.deadLetters)}\n`, "utf8");
      await rename(this.tempDeadLetterPath, this.deadLetterPath);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
}

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * The host will reject this message on every retry. Match the host-core
 * provenance prefix in the JSON-RPC message body (append maps those failures
 * as INTERNAL). Do not treat PLUGIN_PERMISSION_DENIED or schema
 * INVALID_PARAMS as poison — those are a different surface, and serde
 * failures do not even put INVALID_PARAMS in the message text.
 */
function isPoisonMessageError(error: unknown): boolean {
  return /(?<![A-Z_])PERMISSION_DENIED:/i.test(String(error));
}

/**
 * The request line is above the host's fixed size limit. The check runs on
 * the serialized request before anything is sent, so the same entry fails
 * the same way on every retry.
 */
function isOversizedRequestError(error: unknown): boolean {
  return /request line exceeds/i.test(String(error));
}

const OVERSIZED_RESULT_NOTE = "[This tool result was too large to store.]";

/**
 * The same tool row with a note in place of its result, so the transcript
 * still shows the call as finished. Undefined for any other message, and for
 * a row already reduced once.
 */
function withoutOversizedPayload(message: unknown): unknown | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const row = message as Record<string, unknown>;
  if (row.role !== "tool" || row.content === OVERSIZED_RESULT_NOTE) return undefined;
  return {
    ...row,
    content: OVERSIZED_RESULT_NOTE,
    toolResult: { content: [{ type: "text", text: OVERSIZED_RESULT_NOTE }] },
  };
}

/**
 * The parent row (session or turn) no longer exists. This happens after a
 * sidecar or host-core crash where the parent was deleted or never committed.
 * Retrying is pointless — the FK will never be satisfied.
 */
function isForeignKeyError(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(String(error));
}
