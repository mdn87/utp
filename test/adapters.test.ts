// Tier A cross-shell lifecycle suite and self-contained adapter packaging checks.
// Runs lifecycle.ps1 (PowerShell 7) and lifecycle.sh (Git Bash, zsh, bash) against
// an isolated local UTP service and asserts every shell produces the exact same
// normalized semantic record in test/fixtures/adapters-expected.json.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server/http.js";
import { createToken } from "../src/server/tokens.js";

const CLI = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = existsSync(path.resolve("adapters", "utp-workflow.md"))
  ? path.resolve(".")
  : fileURLToPath(new URL("../../", import.meta.url));
const SH_SCRIPT = path.join(REPO_ROOT, "test", "scripts", "lifecycle.sh");
const PS1_SCRIPT = path.join(REPO_ROOT, "test", "scripts", "lifecycle.ps1");
const HELPER = path.join(REPO_ROOT, "test", "scripts", "utp-json.mjs");
const EXPECTED = JSON.parse(readFileSync(path.join(REPO_ROOT, "test", "fixtures", "adapters-expected.json"), "utf8"));

interface ShellRunner {
  name: string;
  program: string;
  args: (scriptArgs: string[]) => string[];
}

function findExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

function detectShells(): ShellRunner[] {
  const shells: ShellRunner[] = [];
  if (process.platform === "win32") {
    const pwsh = findExecutable(["pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
    if (pwsh) {
      shells.push({
        name: "pwsh",
        program: pwsh,
        args: (a) => ["-NoProfile", "-NonInteractive", "-File", PS1_SCRIPT, ...a],
      });
    }
    const gitBash = findExecutable([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ]);
    if (gitBash) {
      shells.push({
        name: "git-bash",
        program: gitBash,
        args: (a) => [SH_SCRIPT, ...a],
      });
    }
  } else {
    const bash = findExecutable(["/bin/bash", "bash"]);
    if (bash) shells.push({ name: "bash", program: bash, args: (a) => [SH_SCRIPT, ...a] });
    const zsh = findExecutable(["/bin/zsh", "zsh"]);
    if (zsh) shells.push({ name: "zsh", program: zsh, args: (a) => [SH_SCRIPT, ...a] });
  }
  return shells;
}

async function unusedPortUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function runShell(runner: ShellRunner, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(runner.program, runner.args(args), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runLifecycleInShell(runner: ShellRunner): Promise<unknown[]> {
  const root = mkdtempSync(path.join(tmpdir(), "utp shell suite "));
  const dataDir = path.join(root, "service data");
  const claudeRoot = path.join(root, "transcripts", "claude");
  const codexRoot = path.join(root, "transcripts", "codex");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(claudeRoot, "proj"), { recursive: true });
  mkdirSync(path.join(codexRoot, "2026", "11", "23"), { recursive: true });

  let clockMs = Date.parse("2026-11-23T12:00:00.000Z");
  const expiresAt = new Date(clockMs + 5 * 60 * 1000).toISOString();
  const svc = await startServer({
    dataDir,
    port: 0,
    now: () => new Date(clockMs),
    transcriptRoots: { "verified-host": { claude: claudeRoot, codex: codexRoot } },
  });
  const verifiedToken = createToken(dataDir, "verified-host");
  const remoteToken = createToken(dataDir, "remote-host");

  const claudeParents = new Map<string, string | null>();
  const codexInitialized = new Set<string>();
  const control = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    if (req.url === "/advance") {
      clockMs += Number(body.ms ?? 0);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ now: new Date(clockMs).toISOString() }));
      return;
    }
    if (req.url === "/transcript") {
      const platform = String(body.platform);
      const session = String(body.session);
      const role = String(body.role);
      const text = String(body.text);
      if (platform === "claude") {
        const log = path.join(claudeRoot, "proj", `${session}.jsonl`);
        const uuid = randomUUID();
        const parentUuid = claudeParents.get(session) ?? null;
        appendFileSync(log, JSON.stringify({
          type: role,
          origin: role === "user" ? { kind: "human" } : undefined,
          sessionId: session,
          parentUuid,
          uuid,
          message: { role, content: text },
        }) + "\n", "utf8");
        claudeParents.set(session, uuid);
      } else {
        const log = path.join(codexRoot, "2026", "11", "23", `rollout-2026-11-23T12-00-00-${session}.jsonl`);
        if (!codexInitialized.has(session)) {
          appendFileSync(log, JSON.stringify({ type: "session_meta", payload: { id: session, source: "cli" } }) + "\n", "utf8");
          codexInitialized.add(session);
        }
        if (role === "assistant") {
          appendFileSync(log, JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
          }) + "\n", "utf8");
        } else {
          const turnId = randomUUID();
          appendFileSync(log, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }) + "\n", "utf8");
          appendFileSync(log, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } }) + "\n", "utf8");
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/browser-answer") {
      const pageUrl = String(body.url);
      const value = String(body.value);
      const opened = await fetch(pageUrl);
      const html = await opened.text();
      const setCookie = opened.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0] ?? "";
      const presMatch = /name="presentation" value="([^"]+)"/.exec(html);
      const form = new URLSearchParams({ presentation: presMatch?.[1] ?? "", "choice-0": value });
      const saved = await fetch(pageUrl, {
        method: "POST",
        headers: {
          origin: new URL(pageUrl).origin,
          cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: saved.status }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  const unusedUrl = await unusedPortUrl();

  const logFile = path.join(root, "events log.jsonl");
  const workDir = path.join(root, "work dir");
  mkdirSync(workDir, { recursive: true });

  try {
    const result = await runShell(runner, [
      process.execPath,
      CLI,
      HELPER,
      workDir,
      logFile,
      svc.url,
      controlUrl,
      unusedUrl,
      verifiedToken,
      remoteToken,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      expiresAt,
    ]);
    assert.equal(result.code, 0, `${runner.name} exited ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const lines = readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } finally {
    control.closeAllConnections();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    await svc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("cross-shell lifecycle suite matches the shared expected record on every available host shell", { concurrency: true }, async (t) => {
  const shells = detectShells();
  assert.ok(shells.length > 0, "expected at least one target shell (pwsh, git-bash, bash, or zsh)");
  if (process.platform === "win32") {
    assert.ok(shells.some((s) => s.name === "pwsh"), "PowerShell 7 (pwsh) must be available on Windows");
    assert.ok(shells.some((s) => s.name === "git-bash"), "Git Bash must be available on Windows");
  } else if (process.platform === "darwin") {
    assert.ok(shells.some((s) => s.name === "zsh"), "zsh must be available on macOS");
  } else {
    assert.ok(shells.some((s) => s.name === "bash"), "bash must be available on Linux");
  }

  await Promise.all(shells.map((runner) =>
    t.test(`shell: ${runner.name}`, async () => {
      const actual = await runLifecycleInShell(runner);
      assert.deepEqual(actual, EXPECTED);
    }),
  ));
});

test("adapters are synced, self-contained in the packed npm tarball, leak-free, and expose setup paths", () => {
  const syncCheck = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "sync-adapters.mjs"), "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(syncCheck.status, 0, syncCheck.stdout + syncCheck.stderr);

  const stage = mkdtempSync(path.join(tmpdir(), "utp-pack-"));
  const packDir = path.join(stage, "tarballs");
  const extractDir = path.join(stage, "extracted");
  const isolatedHome = path.join(stage, "isolated-home");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });

  try {
    const packed = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", "pack", "--pack-destination", packDir], { cwd: REPO_ROOT, encoding: "utf8" })
      : spawnSync("npm", ["pack", "--pack-destination", packDir], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    const tgz = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    assert.ok(tgz, "npm pack produced no .tgz archive");

    // GNU tar treats a drive letter in an archive name as a remote host.
    const untar = spawnSync("tar", ["-xzf", tgz, "-C", path.relative(packDir, extractDir).split(path.sep).join("/")],
      { cwd: packDir, encoding: "utf8" });
    assert.equal(untar.status, 0, untar.stdout + untar.stderr);

    const pkgAdapters = path.join(extractDir, "package", "adapters");
    const requiredWorkflowTokens = [
      "utp status", "utp consider", "utp decide", "utp ask", "utp flush", "utp presented",
      "utp answer", "utp wait", "utp claim-default", "utp resolve-late", "utp begin", "utp applied",
      "utp reconcile", "utp release", "utp takeover", "utp revise", "utp cancel", "utp page", "utp review",
      "UTP_SESSION", "chat_provenance", "UTF-8 files", "Never pass inline JSON", "completion report",
      "`10`", "`14`", "`16`", "`18`", "`19`", "`21`", "`32`",
    ];
    const extractedFiles: string[] = [];

    for (const platform of ["claude", "codex", "antigravity"] as const) {
      const srcDir = path.join(pkgAdapters, platform);
      assert.ok(existsSync(srcDir), `packed tarball missing adapters/${platform}`);
      const copiedDir = path.join(isolatedHome, `skill-${platform}`);
      cpSync(srcDir, copiedDir, { recursive: true });

      const skillPath = path.join(copiedDir, "SKILL.md");
      const workflowPath = path.join(copiedDir, "utp-workflow.md");
      assert.ok(existsSync(skillPath), `${platform} missing SKILL.md`);
      assert.ok(existsSync(workflowPath), `${platform} missing bundled utp-workflow.md`);

      const skillText = readFileSync(skillPath, "utf8");
      const workflowText = readFileSync(workflowPath, "utf8");
      assert.match(skillText, /^---\r?\nname: utp\r?\n/, `${platform} SKILL.md missing YAML frontmatter`);

      // Verify every relative markdown link in SKILL.md resolves inside the standalone copied folder.
      for (const match of skillText.matchAll(/\]\((\.\/[^)]+)\)/g)) {
        const target = path.resolve(copiedDir, match[1]!);
        assert.ok(existsSync(target), `${platform} SKILL.md relative link broken when copied standalone: ${match[1]}`);
      }

      const combined = `${skillText}\n${workflowText}`;
      for (const token of requiredWorkflowTokens) {
        assert.ok(combined.includes(token), `${platform} adapter bundle missing required token: ${token}`);
      }

      for (const file of readdirSync(copiedDir)) extractedFiles.push(path.join(copiedDir, file));
    }

    // Verify all extracted adapter files pass utp leak-check --generic.
    const leak = spawnSync(process.execPath, [CLI, "leak-check", "--generic", ...extractedFiles], { encoding: "utf8" });
    assert.equal(leak.status, 0, leak.stdout + leak.stderr);

    // Verify utp setup <platform> reports an existing adapter folder path.
    const utpHome = path.join(stage, "utp-home");
    mkdirSync(utpHome, { recursive: true });
    writeFileSync(path.join(utpHome, "config.json"), JSON.stringify({ server: "https://utp.example.test:7340", token: "synthetic" }));
    for (const platform of ["claude", "codex", "antigravity"] as const) {
      const res = spawnSync(process.execPath, [CLI, "setup", platform, "--json"], {
        cwd: REPO_ROOT,
        env: { ...process.env, UTP_HOME: utpHome },
        encoding: "utf8",
      });
      assert.equal(res.status, 0, res.stderr);
      const parsed = JSON.parse(res.stdout) as { adapter: string };
      assert.ok(existsSync(path.join(parsed.adapter, "SKILL.md")), `setup ${platform} adapter path missing SKILL.md: ${parsed.adapter}`);
    }

    // Verify bundled Claude SessionStart hook writes export UTP_SESSION=<uuid> only for valid UUIDs.
    const envFile = path.join(stage, "claude.env");
    const hookScript = path.join(isolatedHome, "skill-claude", "session-env.mjs");
    const goodUuid = randomUUID();
    const okRun = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ session_id: goodUuid }),
      env: { ...process.env, CLAUDE_ENV_FILE: envFile },
      encoding: "utf8",
    });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(readFileSync(envFile, "utf8"), `export UTP_SESSION=${goodUuid}\n`);

    const badRun = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ session_id: "not-a-uuid; rm -rf /" }),
      env: { ...process.env, CLAUDE_ENV_FILE: envFile },
      encoding: "utf8",
    });
    assert.equal(badRun.status, 0, badRun.stderr);
    assert.equal(readFileSync(envFile, "utf8"), `export UTP_SESSION=${goodUuid}\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
