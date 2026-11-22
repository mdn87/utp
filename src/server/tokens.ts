// Client tokens. The service keeps only SHA-256 hashes, in <data>/tokens.json;
// `utp token create <machine>` prints a new token once. Each token names the
// machine it was issued to, which every answer and grant records.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TokenEntry {
  machine: string;
  sha256: string;
  created_at: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function readTokens(file: string): TokenEntry[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: TokenEntry[] };
  return Array.isArray(parsed.tokens) ? parsed.tokens : [];
}

export function tokenFile(dataDir: string): string {
  return path.join(dataDir, "tokens.json");
}

export function createToken(dataDir: string, machine: string, now = new Date()): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(machine)) {
    throw new Error("a machine name may use letters, digits, '.', '_' and '-' (64 at most)");
  }
  mkdirSync(dataDir, { recursive: true });
  const file = tokenFile(dataDir);
  const entries = readTokens(file);
  const token = `utp_${randomBytes(24).toString("base64url")}`;
  entries.push({ machine, sha256: hash(token), created_at: now.toISOString() });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ tokens: entries }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return token;
}

/** Looks tokens up by hash, rereading the file when it changes. */
export class TokenBook {
  private stamp = "";
  private byHash = new Map<string, string>();

  constructor(private readonly file: string) {}

  machineFor(token: string): string | undefined {
    this.reload();
    return this.byHash.get(hash(token));
  }

  private reload(): void {
    let stamp: string;
    try {
      const s = statSync(this.file);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      this.byHash.clear();
      this.stamp = "";
      return;
    }
    if (stamp === this.stamp) return;
    this.byHash = new Map(readTokens(this.file).map((e) => [e.sha256, e.machine]));
    this.stamp = stamp;
  }
}
