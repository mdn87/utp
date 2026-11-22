// Append-only, crash-consistent event store for one project
// (docs/concept/lifecycle.md, "Crash-consistent writes").
//
// Write order for each operation:
//   1. each payload goes to a temporary file, is flushed, and is renamed into
//      place under its content hash;
//   2. one newline-terminated event line, carrying the operation id and its
//      result, is appended and flushed. That line is the commit point.
// On open, a last line without a final newline, or one that doesn't parse, is
// a torn write: it moves to quarantine.jsonl and its operation counts as not
// done, so a retry with the same operation id performs it exactly once.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredEvent {
  seq: number;
  type: string;
  at: string;
  op_id?: string;
  actor?: { machine?: string; session?: string };
  payloads?: Record<string, string>;
  data: Record<string, unknown>;
  result?: unknown;
}

export type NewEvent = Omit<StoredEvent, "seq" | "payloads">;

export type CrashPoint = "after-payload" | "mid-event" | "after-event";

export class StoreBusyError extends Error {
  constructor(lockPath: string, holder: string) {
    super(`store is in use by another process (${holder}); lock: ${lockPath}`);
  }
}

export class CorruptStoreError extends Error {}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fsyncDir(dir: string): void {
  // Makes a rename durable on POSIX. Windows can't open a directory for
  // fsync; NTFS journals the rename itself, so this is skipped there.
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class EventStore {
  private events: StoredEvent[] = [];
  private byOp = new Map<string, StoredEvent>();
  private lockFd: number | undefined;
  private readonly logPath: string;
  private readonly lockPath: string;
  private readonly payloadDir: string;

  constructor(
    readonly dir: string,
    private readonly opts: { crashAt?: CrashPoint } = {},
  ) {
    this.logPath = path.join(dir, "events.jsonl");
    this.lockPath = path.join(dir, "store.lock");
    this.payloadDir = path.join(dir, "payloads");
  }

  open(): void {
    mkdirSync(this.payloadDir, { recursive: true });
    this.acquireLock();
    try {
      this.repairTail();
      this.load();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  close(): void {
    if (this.lockFd === undefined) return;
    closeSync(this.lockFd);
    this.lockFd = undefined;
    try { unlinkSync(this.lockPath); } catch { /* already gone */ }
  }

  all(): readonly StoredEvent[] {
    return this.events;
  }

  findOp(opId: string): StoredEvent | undefined {
    return this.byOp.get(opId);
  }

  putPayload(value: unknown): string {
    const text = JSON.stringify(value);
    const sha = sha256(text);
    const final = path.join(this.payloadDir, `${sha}.json`);
    if (existsSync(final)) return sha;
    const tmp = path.join(this.payloadDir, `.tmp-${randomBytes(6).toString("hex")}`);
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, final);
    fsyncDir(this.payloadDir);
    return sha;
  }

  getPayload<T = unknown>(sha: string): T {
    const text = readFileSync(path.join(this.payloadDir, `${sha}.json`), "utf8");
    if (sha256(text) !== sha) throw new CorruptStoreError(`payload ${sha} doesn't match its hash`);
    return JSON.parse(text) as T;
  }

  /**
   * Commits one event. If an event with the same operation id is already
   * committed, returns that event unchanged instead (retries are exact).
   */
  append(e: NewEvent, payloads: Record<string, unknown> = {}): StoredEvent {
    if (this.lockFd === undefined) throw new Error("store is not open");
    if (e.op_id) {
      const existing = this.byOp.get(e.op_id);
      if (existing) return existing;
    }
    const shas: Record<string, string> = {};
    for (const [name, value] of Object.entries(payloads)) shas[name] = this.putPayload(value);
    this.crash("after-payload");
    const stored: StoredEvent = {
      seq: this.events.length + 1,
      ...e,
      ...(Object.keys(shas).length ? { payloads: shas } : {}),
    };
    const line = Buffer.from(JSON.stringify(stored) + "\n", "utf8");
    const fd = openSync(this.logPath, "a");
    try {
      if (this.opts.crashAt === "mid-event") {
        writeSync(fd, line.subarray(0, Math.floor(line.length / 2)));
        fsyncSync(fd);
        this.die();
      }
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.crash("after-event");
    this.events.push(stored);
    if (stored.op_id) this.byOp.set(stored.op_id, stored);
    return stored;
  }

  private crash(point: CrashPoint): void {
    if (this.opts.crashAt === point) this.die();
  }

  private die(): never {
    // A real crash: no exit handlers, no lock release.
    process.kill(process.pid, "SIGKILL");
    throw new Error("unreachable");
  }

  private acquireLock(): void {
    const holder = JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeSync(fd, holder);
        fsyncSync(fd);
        this.lockFd = fd;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let info: { pid?: number; host?: string } = {};
        try { info = JSON.parse(readFileSync(this.lockPath, "utf8")) as typeof info; } catch { /* unreadable lock */ }
        const stale = info.host === os.hostname() && typeof info.pid === "number" && !isAlive(info.pid);
        if (!stale || attempt > 0) throw new StoreBusyError(this.lockPath, `${info.host ?? "?"}:${info.pid ?? "?"}`);
        unlinkSync(this.lockPath);
      }
    }
  }

  private quarantine(reason: string, bytes: Buffer): void {
    const entry = { at: new Date().toISOString(), reason, text: bytes.toString("utf8") };
    const fd = openSync(path.join(this.dir, "quarantine.jsonl"), "a");
    try {
      writeSync(fd, JSON.stringify(entry) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private truncateTo(length: number): void {
    const fd = openSync(this.logPath, "r+");
    try {
      ftruncateSync(fd, length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private repairTail(): void {
    if (!existsSync(this.logPath)) return;
    let buf = readFileSync(this.logPath);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline !== buf.length - 1) {
      this.quarantine("torn write: last line has no final newline", buf.subarray(lastNewline + 1));
      this.truncateTo(lastNewline + 1);
      buf = buf.subarray(0, lastNewline + 1);
    }
    if (buf.length === 0) return;
    const prevNewline = buf.lastIndexOf(0x0a, buf.length - 2);
    const lastLine = buf.subarray(prevNewline + 1, buf.length - 1);
    try {
      JSON.parse(lastLine.toString("utf8"));
    } catch {
      this.quarantine("torn write: last line doesn't parse", lastLine);
      this.truncateTo(prevNewline + 1);
    }
  }

  private load(): void {
    this.events = [];
    this.byOp.clear();
    if (!existsSync(this.logPath)) return;
    const lines = readFileSync(this.logPath, "utf8").split("\n");
    lines.pop(); // the text after the final newline is empty after repairTail
    for (const [i, line] of lines.entries()) {
      let e: StoredEvent;
      try {
        e = JSON.parse(line) as StoredEvent;
      } catch {
        throw new CorruptStoreError(`events.jsonl line ${i + 1} doesn't parse and isn't the last line`);
      }
      this.events.push(e);
      if (e.op_id) this.byOp.set(e.op_id, e);
    }
  }
}
