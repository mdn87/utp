// The UTP service: one engine per project, each over its own store under
// <data>/stores/<project-id>/. The service is the only writer. Node runs one
// operation at a time, and every engine operation is synchronous, so writes to
// a project are serialized without further locking; the store's file lock
// keeps a second service instance out.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Engine } from "../core/engine.js";
import { EventStore, StoreBusyError } from "../core/store.js";
import { EXIT, type Actor, type OpResult } from "../core/types.js";

const PROJECT_ID = /^prj-[0-9a-f]{12}$/;

export interface ProjectInfo {
  id: string;
  created_at: string;
  remote?: string;
  name?: string;
}

/** Reduces the common spellings of one Git remote to a single form. */
export function normalizeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  let r = remote.trim().replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  r = r.replace(/^([^/:]+):(?!\d)/, "$1/").replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = r.indexOf("/");
  return slash < 0 ? r.toLowerCase() : r.slice(0, slash).toLowerCase() + r.slice(slash);
}

export class Service {
  private readonly engines = new Map<string, { store: EventStore; engine: Engine }>();
  readonly storesDir: string;

  constructor(
    readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.storesDir = path.join(dataDir, "stores");
    mkdirSync(this.storesDir, { recursive: true });
  }

  /** Runs a service-level operation, or returns undefined when op belongs to a project. */
  global(op: string, args: Record<string, unknown>, actor: Actor, opId?: string): OpResult | undefined {
    switch (op) {
      case "ping":
        return { code: EXIT.OK, machine: actor.machine };
      case "project.create": {
        const id = `prj-${randomBytes(6).toString("hex")}`;
        const info: ProjectInfo = { id, created_at: this.now().toISOString() };
        const remote = normalizeRemote(typeof args.remote === "string" ? args.remote : undefined);
        if (remote) info.remote = remote;
        if (typeof args.name === "string" && args.name.trim()) info.name = args.name.trim();
        const dir = path.join(this.storesDir, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "project.json"), JSON.stringify(info, null, 2) + "\n");
        return { code: EXIT.OK, project: info };
      }
      case "project.find": {
        const remote = normalizeRemote(typeof args.remote === "string" ? args.remote : undefined);
        const projects = remote ? this.projects().filter((p) => p.remote === remote) : [];
        return { code: EXIT.OK, projects };
      }
      case "project.info": {
        const id = typeof args.project === "string" ? args.project : "";
        const info = this.info(id);
        return info ? { code: EXIT.OK, project: info } : { code: EXIT.NOT_FOUND, message: `no project ${id} on this service` };
      }
      case "project.relink": {
        const { from, to } = args;
        if (typeof from !== "string" || typeof to !== "string" || from === to) {
          return { code: EXIT.OTHER, message: "relink needs two different project IDs" };
        }
        const source = this.engine(from);
        if (!(source instanceof Engine)) return source;
        const target = this.engine(to);
        if (!(target instanceof Engine)) return target;
        return target.relinkFrom(source, from, to, actor, opId);
      }
      default:
        return undefined;
    }
  }

  /** The engine for a project, opened on first use; a result when it can't be opened. */
  engine(project: string): Engine | OpResult {
    const open = this.engines.get(project);
    if (open) return open.engine;
    if (!this.info(project)) return { code: EXIT.NOT_FOUND, message: `no project ${project} on this service; run utp init or utp link` };
    const store = new EventStore(path.join(this.storesDir, project));
    try {
      store.open();
    } catch (e) {
      if (e instanceof StoreBusyError) return { code: EXIT.BUSY, message: e.message };
      throw e;
    }
    const engine = new Engine(store, this.now);
    try {
      engine.load();
    } catch (e) {
      store.close();
      throw e;
    }
    this.engines.set(project, { store, engine });
    return engine;
  }

  close(): void {
    for (const { store } of this.engines.values()) store.close();
    this.engines.clear();
  }

  private info(id: string): ProjectInfo | undefined {
    if (!PROJECT_ID.test(id)) return undefined;
    const file = path.join(this.storesDir, id, "project.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ProjectInfo) : undefined;
  }

  projects(): ProjectInfo[] {
    return readdirSync(this.storesDir)
      .map((id) => this.info(id))
      .filter((p): p is ProjectInfo => p !== undefined);
  }
}
