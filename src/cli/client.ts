// Client side of the service: the machine's config (~/.utp/config.json, or
// $UTP_HOME/config.json) and one call per operation. Every failure to reach
// the service becomes exit code 32 with the likely causes.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { EXIT, type OpResult } from "../core/types.js";

export interface ClientConfig {
  server: string;
  token: string;
}

let proxy: { dispatcher: unknown } | undefined;

function proxyOptions(): { dispatcher: unknown } | undefined {
  if (!["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"].some((name) => process.env[name])) return undefined;
  if (!proxy) {
    const tooling = process.env.UTP_TOOLING_DIR;
    const require = createRequire(tooling ? path.resolve(tooling, "package.json") : import.meta.url);
    const { EnvHttpProxyAgent } = require("undici") as { EnvHttpProxyAgent: new () => unknown };
    proxy = { dispatcher: new EnvHttpProxyAgent() };
  }
  return proxy;
}

export class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function utpHome(): string {
  return process.env.UTP_HOME || path.join(os.homedir(), ".utp");
}

export function readConfig(): ClientConfig {
  const file = path.join(utpHome(), "config.json");
  const cfg = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<ClientConfig>) : {};
  const server = process.env.UTP_SERVER || cfg.server;
  if (!server || !cfg.token) {
    throw new CliError(EXIT.UNREACHABLE, "this machine isn't connected to a UTP service yet: create a token on the server with "
      + "utp token create <machine>, then run utp connect <server-url> here with the token on standard input");
  }
  return { server, token: cfg.token };
}

export function writeConfig(cfg: ClientConfig): string {
  const dir = utpHome();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps the file private through the user profile's permissions.
  }
  return file;
}

export function unreachableMessage(server: string): string {
  return [
    `can't reach the UTP service at ${server}. Likely causes:`,
    "- the service isn't running: start it on the home server with utp serve",
    "- this agent's sandbox blocks network access: run utp setup <codex|claude|antigravity>",
    "- the address is wrong: check ~/.utp/config.json or UTP_SERVER",
  ].join("\n");
}

export interface CallOptions {
  project?: string;
  opId?: string;
  timeoutMs?: number;
  config?: ClientConfig;
}

export async function call(op: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<OpResult> {
  const cfg = opts.config ?? readConfig();
  const body = JSON.stringify({
    op, args, session: process.env.UTP_SESSION || "default",
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.opId ? { op_id: opts.opId } : {}),
  });
  let res: Response;
  try {
    const endpoint = new URL(cfg.server);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/op`;
    endpoint.search = "";
    endpoint.hash = "";
    res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body,
      ...proxyOptions(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch {
    throw new CliError(EXIT.UNREACHABLE, unreachableMessage(cfg.server));
  }
  if (res.status === 401) {
    throw new CliError(EXIT.OTHER, "the service refused this machine's token; create a new one on the server with "
      + "utp token create <machine>, then run utp connect again");
  }
  let parsed: OpResult | undefined;
  try {
    parsed = JSON.parse(await res.text()) as OpResult;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed.code !== "number") {
    throw new CliError(EXIT.OTHER, `the service answered HTTP ${res.status} without a result`);
  }
  return parsed;
}
