import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { utpHome } from "./client.js";

interface Turn { id: string; root: string; before: string | null }
interface HookInput {
  session_id?: string; cwd?: string; hook_event_name?: string; tool_name?: string;
  last_assistant_message?: string; stop_hook_active?: boolean;
}

function sessionDirectory(id?: string): string | undefined {
  if (id && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return path.join(utpHome(), "closeout-hooks", id);
}

function readState<T>(directory: string, name: string): T | undefined {
  try { return JSON.parse(readFileSync(path.join(directory, name), "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function saveState(directory: string, name: string, value: unknown): void {
  const temp = path.join(directory, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, path.join(directory, name));
}

function git(cwd: string, ...args: string[]): string | null {
  const run = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

// Include the committed tree and index as well as edits to already-dirty or untracked files.
// Only the fingerprint persists. Ignored files and the contents of the checkout stay private.
function fingerprint(root: string): string | null {
  const home = path.resolve(utpHome());
  const cache = path.relative(root, path.join(home, "closeout-hooks"));
  const exclusions = cache.startsWith(".." + path.sep) || path.isAbsolute(cache) ? []
    : [`:(top,exclude,literal)${cache.split(path.sep).join("/")}`];
  const status = git(root, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
    "--", ".", ...exclusions);
  const index = git(root, "diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames");
  const hash = createHash("sha256");
  function addFile(file: string): void {
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat) hash.update(`\0${file}\0${stat.mode},${stat.size},${stat.mtimeNs},${stat.ctimeNs}`);
  }
  if (status !== null && index !== null) {
    hash.update(git(root, "rev-parse", "--verify", "HEAD^{tree}") ?? "").update(index).update(status);
    for (const entry of status.split("\0").filter(Boolean)) addFile(path.join(root, entry.slice(3)));
  } else {
    // UTP_PROJECT also supports a workspace without a Git checkout. Traverse that
    // explicit workspace only, without following symlinks or fingerprinting UTP's own state.
    if (!process.env.UTP_PROJECT || git(root, "rev-parse", "--git-dir") !== null) return null;
    const directories = [root];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (file === home || entry.name === ".git") continue;
        if (entry.isDirectory()) directories.push(file);
        else addFile(file);
      }
    }
  }
  return hash.digest("hex");
}

export function currentHookTurn(): { directory: string; turn: Turn } | undefined {
  const directory = sessionDirectory(process.env.UTP_SESSION);
  if (!directory) return;
  const turn = readState<Turn>(directory, "turn.json");
  if (!turn) return;
  const relative = path.relative(realpathSync.native(turn.root), realpathSync.native(process.cwd()));
  if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return { directory, turn };
}

export function recordHookReport(active: ReturnType<typeof currentHookTurn>, markdown: string): void {
  if (active) saveState(active.directory, "report.json", { turn: active.turn.id, markdown });
}

export function closeoutHook(input: HookInput): Record<string, string> | undefined {
  const dir = sessionDirectory(input.session_id);
  if (!dir || !input.cwd) return;
  if (input.hook_event_name === "UserPromptSubmit") {
    const root = git(input.cwd, "rev-parse", "--show-toplevel")?.trimEnd() ?? input.cwd;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    saveState(dir, "turn.json", { id: randomUUID(), root, before: fingerprint(root) } satisfies Turn);
    return;
  }
  const turn = readState<Turn>(dir, "turn.json");
  if (!turn) return;
  if (input.hook_event_name === "PostToolUse" && ["Write", "Edit", "NotebookEdit"].includes(input.tool_name ?? "")) {
    saveState(dir, "edit.json", turn.id);
    return;
  }
  if (input.hook_event_name !== "Stop") return;
  const report = readState<{ turn: string; markdown: string }>(dir, "report.json");
  if (report?.turn === turn.id) {
    if (!input.last_assistant_message?.replaceAll("\r\n", "\n").includes(report.markdown)) return { systemMessage: report.markdown };
    return;
  }
  if (input.stop_hook_active) return;
  const edited = readState<string>(dir, "edit.json") === turn.id;
  const after = !edited && turn.before !== null ? fingerprint(turn.root) : null;
  if (edited || (after !== null && turn.before !== after)) {
    return { decision: "block", reason: "Files changed this turn. Map each stated goal to evidence, run utp closeout <report.json>, and show the report. Finish without asking the person to accept routine work." };
  }
}
