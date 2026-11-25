import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../core/types.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_LINKS = 256;
export const token = (): string => randomBytes(24).toString("base64url");
export const linkKey = (id: string): string => createHash("sha256").update(id).digest("hex");

export interface ReviewLink {
  project: string;
  actor: Actor;
  review: string;
  mode?: "answer" | "edit";
  items: { id: string; revision: number }[];
  expiresAt: number;
  browser?: { cookie: string; form: string; openedAt: number };
}

/** The service is the only writer. Persist only card references and browser binding. */
export class ReviewLinks {
  private readonly dir: string;

  constructor(dataDir: string, private readonly now: () => number) {
    this.dir = path.join(dataDir, "review-links");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  create(input: Pick<ReviewLink, "project" | "actor" | "review" | "items" | "mode">): string | undefined {
    const now = this.now();
    let live = 0;
    for (const name of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      const record = JSON.parse(readFileSync(file, "utf8")) as ReviewLink;
      if (record.expiresAt <= now) unlinkSync(file);
      else live++;
    }
    if (live >= MAX_LINKS) return undefined;
    const id = token();
    this.save(id, { ...input, expiresAt: now + DAY });
    return id;
  }

  get(id: string): ReviewLink | undefined {
    const file = path.join(this.dir, linkKey(id) + ".json");
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as ReviewLink;
      return record.expiresAt > this.now() ? record : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(id: string, record: ReviewLink): void {
    const file = path.join(this.dir, linkKey(id) + ".json");
    const temporary = file + ".tmp";
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file);
  }
}
