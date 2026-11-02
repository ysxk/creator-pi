import { statSync, type BigIntStats } from "node:fs";
import { parseSessionEntries, SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { nativePiSnapshot, type NativePiSnapshot } from "./native-pi-session-lease.js";

type CatalogFile = {
  version: BigIntStats;
  snapshot: NativePiSnapshot;
  header: SessionHeader;
  manager: SessionManager;
  branch: ReturnType<SessionManager["getBranch"]>;
  context: ReturnType<SessionManager["buildSessionContext"]>;
};

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Read-only discovery cache, never a substitute for a writer's byte/lease checks. */
export class NativePiSessionCatalog {
  private readonly files = new Map<string, CatalogFile>();
  private sourceBytes = 0;

  constructor(
    private readonly maxSourceBytes = 16 * 1024 * 1024,
    private readonly maxFiles = 128,
  ) {}

  read(path: string, visitedPaths?: ReadonlySet<string>): CatalogFile {
    try {
      const version = statSync(path, { bigint: true });
      const cached = this.files.get(path);
      if (cached && sameVersion(cached.version, version)) {
        this.files.delete(path);
        this.files.set(path, cached);
        return cached;
      }
      this.delete(path);
      const snapshot = nativePiSnapshot(path);
      // A file replaced or appended while being read cannot seed a warm cache.
      if (!sameVersion(version, statSync(path, { bigint: true }))) {
        throw new Error("Native Pi session changed during discovery");
      }
      const entries = parseSessionEntries(snapshot.bytes.toString("utf8"));
      const header = entries.find((entry) => entry.type === "session");
      if (!header || typeof header.id !== "string") throw new Error("Invalid native session header");
      const manager = SessionManager.inMemory(header.cwd ?? "", undefined, entries);
      const file = { version, snapshot, header, manager, branch: manager.getBranch(), context: manager.buildSessionContext() };
      const size = snapshot.bytes.length;
      if (size <= this.maxSourceBytes) {
        while (this.files.size >= this.maxFiles || this.sourceBytes + size > this.maxSourceBytes) {
          // A full scan larger than the cache must not evict its own warm prefix.
          const oldest = [...this.files.keys()].find((key) => !visitedPaths?.has(key));
          if (oldest === undefined) return file;
          this.delete(oldest);
        }
        this.files.set(path, file);
        this.sourceBytes += size;
      }
      return file;
    } catch (error) {
      this.delete(path);
      throw error;
    }
  }

  retain(paths: ReadonlySet<string>): void {
    for (const path of this.files.keys()) {
      if (!paths.has(path)) this.delete(path);
    }
  }

  clear(): void {
    this.files.clear();
    this.sourceBytes = 0;
  }

  private delete(path: string): void {
    const cached = this.files.get(path);
    if (cached) this.sourceBytes -= cached.snapshot.bytes.length;
    this.files.delete(path);
  }
}
