// Which project a checkout belongs to. Registration is explicit: utp init
// creates a project and utp link joins one. The registry (~/.utp/registry.json)
// is keyed by the checkout's Git common directory, so worktrees of a
// registered checkout join its project automatically.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "../core/types.js";
import { CliError, utpHome } from "./client.js";

export interface Checkout {
  commonDir: string;
  root: string;
  remote?: string;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function checkout(cwd = process.cwd()): Checkout | undefined {
  const out = git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], cwd);
  const [common, root] = out?.split(/\r?\n/) ?? [];
  if (!common || !root) return undefined;
  const remote = git(["remote", "get-url", "origin"], cwd) || undefined;
  return { commonDir: path.resolve(common), root: path.resolve(root), ...(remote ? { remote } : {}) };
}

interface Registry {
  checkouts: Record<string, string>;
}

const registryFile = () => path.join(utpHome(), "registry.json");

export function readRegistry(): Registry {
  const file = registryFile();
  if (!existsSync(file)) return { checkouts: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Registry>;
  return { checkouts: parsed.checkouts ?? {} };
}

export function register(commonDir: string, project: string): void {
  const reg = readRegistry();
  reg.checkouts[commonDir] = project;
  mkdirSync(utpHome(), { recursive: true });
  const file = registryFile();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The project for the current checkout; UTP_PROJECT overrides it (the root is then the working folder). */
export function projectFor(cwd = process.cwd()): { project: string; root: string } {
  if (process.env.UTP_PROJECT) return { project: process.env.UTP_PROJECT, root: cwd };
  const co = checkout(cwd);
  if (!co) throw new CliError(EXIT.NOT_FOUND, "this folder isn't in a Git checkout; run utp from a registered checkout or set UTP_PROJECT");
  const project = readRegistry().checkouts[co.commonDir];
  if (!project) {
    throw new CliError(EXIT.NOT_FOUND, "this checkout isn't registered with UTP: run utp init to create a project for it, "
      + "or utp link <project-id> to join an existing one");
  }
  return { project, root: co.root };
}

/** Fingerprints of basis files, relative to the checkout root. */
export function fingerprints(root: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const full = path.resolve(root, f);
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new CliError(EXIT.OTHER, `basis file ${f} is outside the checkout`);
    if (!existsSync(full)) {
      out[f] = "missing";
      continue;
    }
    if (statSync(full).isDirectory()) throw new CliError(EXIT.OTHER, `basis entry ${f} is a folder; list the files that matter`);
    out[f] = `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  }
  return out;
}
