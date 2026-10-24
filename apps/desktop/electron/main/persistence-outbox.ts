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

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

type OutboxOptions = {
  /** Current time in ms; a test seam for the retry backoff. */
  now?: () => number;
  /** Quarantined appends retained on disk, oldest discarded first. */
  maxDeadLetters?: number;
  /**
   * Runs `run` once after `delayMs` and returns a cancel function; a test seam
   * for the backoff retry. Defaults to an unref'd `setTimeout`.
   */
  schedule?: (run: () => void, delayMs: number) => () => void;
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
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** Cancels the one pending backoff retry, if any. */
  private cancelRetry: (() => void) | null = null;
  private entries: MessageAppend[] = [];
  private deadLetters: QuarantinedAppend[] = [];
  private flushing: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private deadLetterMutation = Promise.resolve();
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
    this.schedule = options.schedule ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      // A retry must not keep the app alive; shutdown flushes on its own.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
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
    this.flushInBackground(getHost);
  }

  async flush(getHost: () => HostProcess | null): Promise<void> {
    await this.loaded;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(getHost).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private flushInBackground(getHost: () => HostProcess | null): void {
    void this.flush(getHost).catch((error: unknown) => {
      this.logger("error", "session persistence background flush failed", { data: String(error) });
    });
  }

  /**
   * Drop queued appends for a session that the user deleted so a later
   * host-side stub recreate cannot resurrect it (D318). Its quarantined
   * appends go with it: they belong to the same deleted conversation.
   */
  async dropSession(sessionId: string): Promise<void> {
    await this.loaded;
    const next = this.entries.filter((entry) => entry.sessionId !== sessionId);
    this.entries = next;
    await Promise.all([
      this.persist(),
      this.discardQuarantinedSession(sessionId),
    ]);
  }

  /** Old appends must be acknowledged and absent from recovery before a rewrite can start. */
  async prepareSessionReplacement(
    sessionId: string,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.flush(getHost);
    if (this.entries.some((entry) => entry.sessionId === sessionId)) {
      throw new Error("Cannot rewrite a transcript with pending message persistence; retry after storage recovers");
    }
    // A previous flush may have reached the host but failed to clear its disk copy.
    await this.persist();
  }

  async discardQuarantinedSession(sessionId: string): Promise<void> {
    await this.loaded;
    await this.updateDeadLetters((current) => {
      const next = current.filter((entry) => entry.sessionId !== sessionId);
      return next.length === current.length ? current : next;
    });
  }

  size(): number {
    return this.entries.length;
  }

  /** Stop the pending backoff retry (shutdown). Queued appends stay on disk. */
  close(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  /**
   * Make sure the head that is backing off gets another attempt when its
   * window ends, even if nothing else is enqueued or flushed meanwhile. One
   * timer at most; it re-reads the host when it fires, so a replaced host is
   * used, and a flush that finds nothing to do simply returns.
   */
  private scheduleRetry(getHost: () => HostProcess | null): void {
    if (!this.headRetry) return;
    this.cancelRetry?.();
    const delay = Math.max(0, this.headRetry.nextAttemptAt - this.now());
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      this.flushInBackground(getHost);
    }, delay);
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
        if (!this.cancelRetry) this.scheduleRetry(getHost);
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
            this.scheduleRetry(getHost);
            return;
          }
          // An error the outbox cannot classify as permanent or as a
          // duplicate recurs on every retry. Quarantine the head instead of
          // blocking the whole application queue behind it forever (#1560).
          if (!(await this.quarantine(current, attempts, error))) {
            // The copy could not be saved, so the head stays queued and
            // comes back after the backoff like any other failure.
            this.scheduleRetry(getHost);
            return;
          }
          continue;
        }
      }
      // A newer snapshot may have replaced this key while the host wrote it.
      // Only remove the exact entry acknowledged by that write.
      if (this.entries[0] === current) this.entries.shift();
      this.headRetry = null;
      await this.persist();
    }
    // Drained: nothing is left for a pending retry to do.
    this.close();
  }

  /** Count one failure of the given head and schedule its next attempt. */
  private noteTransientFailure(entry: MessageAppend, host: HostProcess): number {
    const attempts = (this.headRetry?.entry === entry ? this.headRetry.attempts : 0) + 1;
    const backoff = Math.min(RETRY_BACKOFF_MS * 2 ** (attempts - 1), MAX_RETRY_BACKOFF_MS);
    this.headRetry = { entry, attempts, nextAttemptAt: this.now() + backoff, host };
    return attempts;
  }

  /**
   * Move a head the host keeps refusing into the dead-letter file. The copy is
   * written first and the queue entry removed only after it is on disk, so a
   * failed write or an exit in between never leaves the append in neither
   * place. Returns false, with the head still queued, when the copy failed.
   */
  private async quarantine(entry: MessageAppend, attempts: number, error: unknown): Promise<boolean> {
    let quarantined = false;
    let discarded: QuarantinedAppend[] = [];
    try {
      await this.updateDeadLetters((current) => {
        if (!this.entries.includes(entry)) return current;
        const next = [
          ...current,
          { ...entry, quarantinedAt: new Date(this.now()).toISOString(), reason: String(error) },
        ];
        discarded = next.splice(0, Math.max(0, next.length - this.maxDeadLetters));
        quarantined = true;
        return next;
      });
    } catch (writeError) {
      this.logger("error", "session persistence flush could not save the dead-letter copy; the entry stays queued", {
        key: entry.key,
        sessionId: entry.sessionId,
        attempts,
        file: this.deadLetterPath,
        data: String(writeError),
      });
      return false;
    }
    if (!quarantined) return true;
    for (const dropped of discarded) {
      this.logger("warn", "session persistence outbox dead letter discarded", {
        key: dropped.key,
        sessionId: dropped.sessionId,
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
    return true;
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
      await writeFile(this.tempPath, `${JSON.stringify(this.entries)}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }

  private async updateDeadLetters(
    update: (current: QuarantinedAppend[]) => QuarantinedAppend[],
  ): Promise<void> {
    const mutation = this.deadLetterMutation.then(async () => {
      const next = update(this.deadLetters);
      if (next === this.deadLetters) return;
      await this.persistDeadLetters(next);
      this.deadLetters = next;
    });
    this.deadLetterMutation = mutation.catch(() => undefined);
    await mutation;
  }

  private async persistDeadLetters(deadLetters: QuarantinedAppend[]): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      await writeFile(this.tempDeadLetterPath, `${JSON.stringify(deadLetters)}\n`, "utf8");
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
