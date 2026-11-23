import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { EXIT } from "../core/types.js";
import { CliError, readConfig, utpHome } from "./client.js";

export interface SetupPlan {
  program: string;
  args: string[];
  access: string;
}

export function setupPlan(platform: string): SetupPlan {
  if (platform === "codex") {
    return {
      program: "codex",
      args: ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"],
      access: "This Codex session's workspace-write sandbox can make outbound network requests.",
    };
  }
  if (platform !== "claude" && platform !== "antigravity") {
    throw new CliError(EXIT.OTHER, "choose codex, claude or antigravity");
  }
  const server = new URL(readConfig().server);
  if (!["http:", "https:"].includes(server.protocol) || server.username || server.password) {
    throw new CliError(EXIT.OTHER, "UTP needs an HTTP or HTTPS service address");
  }
  if (platform === "claude") {
    const domain = server.port ? server.host : `${server.hostname}:${server.protocol === "https:" ? 443 : 80}`;
    return {
      program: "claude",
      args: ["--settings", JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains: [domain] } } })],
      access: `This Claude Code session adds ${domain} to its sandbox network allowlist on supported systems.`,
    };
  }
  const config = path.resolve(utpHome(), "config.json");
  const runtimeFiles = [...new Set([process.execPath, realpathSync(process.execPath), config])];
  return {
    program: "agy",
    args: ["--sandbox", "--settings", JSON.stringify({
      permissions: { allow: [`read_url(${server.hostname})`, ...runtimeFiles.map((file) => `read_file(${file})`)] },
    })],
    access: `This Antigravity session adds ${server.hostname} and read access to Node and the UTP connection file.`,
  };
}

export function launchSetup(plan: SetupPlan, agentArgs: string[], launcher?: string): Promise<number> {
  if (plan.program === "claude" && process.platform === "win32") {
    throw new CliError(EXIT.OTHER, "run utp setup claude --apply inside WSL2 to use Claude Code's sandbox on Windows");
  }
  let program = launcher ?? plan.program;
  let args = [...plan.args, ...agentArgs];
  if (process.platform === "win32" && !launcher) {
    const search = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const native = search.map((dir) => path.join(dir.replace(/^"|"$/g, ""), program + ".exe")).find(existsSync);
    if (native) program = native;
    else if (plan.program === "codex") {
      const entry = search.map((dir) =>
        path.join(dir.replace(/^"|"$/g, ""), "node_modules", "@openai", "codex", "bin", "codex.js")).find(existsSync);
      if (entry) {
        program = process.execPath;
        args = [entry, ...args];
      }
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.once("error", () => reject(new CliError(EXIT.OTHER, `could not launch ${plan.program}; pass its executable with --launcher`)));
    child.once("exit", (code) => resolve(code ?? EXIT.OTHER));
  });
}
