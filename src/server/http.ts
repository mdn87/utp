// The HTTP front of the UTP service. One endpoint, POST /v1/op, takes
// {op, project?, args?, op_id?, session?} with a bearer token and answers with
// the operation's result as JSON. `wait` is held open until the request is
// answered, something else ends the wait, or the timeout passes.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Engine } from "../core/engine.js";
import { EXIT, type Actor, type OpResult } from "../core/types.js";
import { Service } from "./service.js";
import { TokenBook, tokenFile } from "./tokens.js";

export const DEFAULT_PORT = 7340;
const MAX_BODY = 1024 * 1024;

export interface ServeOptions {
  dataDir: string;
  host?: string;
  port?: number;
  now?: () => Date;
  /** Longest single wait the service holds open; clients wait again for longer timeouts. */
  maxWaitMs?: number;
  /** How often a held wait re-checks deadlines such as leases and hide-until times. */
  recheckMs?: number;
  log?: (line: string) => void;
}

export interface RunningService {
  url: string;
  service: Service;
  close(): Promise<void>;
}

interface OpBody {
  op?: unknown;
  project?: unknown;
  args?: unknown;
  op_id?: unknown;
  session?: unknown;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function holdWait(engine: Engine, args: Record<string, unknown>, actor: Actor, opId: string | undefined,
  limitMs: number, recheckMs: number, gone: AbortSignal): Promise<OpResult> {
  const timeoutS = Number(args.timeout_s ?? 0);
  const deadline = Date.now() + Math.min(Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : 0, limitMs);
  for (;;) {
    const r = engine.run("wait", args, actor, opId);
    if (r.code !== EXIT.WAITING || Date.now() >= deadline || gone.aborted) return r;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        engine.events.off("commit", done);
        gone.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(recheckMs, deadline - Date.now())));
      engine.events.on("commit", done);
      gone.addEventListener("abort", done);
    });
  }
}

export async function startServer(opts: ServeOptions): Promise<RunningService> {
  const service = new Service(opts.dataDir, opts.now);
  const tokens = new TokenBook(tokenFile(opts.dataDir));
  const limitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
  const recheckMs = opts.recheckMs ?? 30 * 1000;
  const log = opts.log ?? (() => {});

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, { code: EXIT.OTHER, message: "the service hit an internal error; see its log" });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/v1/op") {
      send(res, 404, { code: EXIT.NOT_FOUND, message: "the UTP service answers POST /v1/op" });
      return;
    }
    const auth = req.headers.authorization ?? "";
    const machine = auth.startsWith("Bearer ") ? tokens.machineFor(auth.slice(7).trim()) : undefined;
    if (!machine) {
      send(res, 401, { code: EXIT.OTHER, message: "token refused" });
      return;
    }
    const text = await readBody(req);
    if (text === undefined) {
      send(res, 413, { code: EXIT.OTHER, message: "request body over 1 MiB" });
      return;
    }
    let body: OpBody;
    try {
      body = JSON.parse(text) as OpBody;
    } catch {
      send(res, 400, { code: EXIT.OTHER, message: "the request body isn't JSON" });
      return;
    }
    const args = typeof body.args === "object" && body.args !== null && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>) : {};
    if (typeof body.op !== "string" || (body.op_id !== undefined && typeof body.op_id !== "string")) {
      send(res, 400, { code: EXIT.OTHER, message: "op must be text, and op_id text when given" });
      return;
    }
    const session = typeof body.session === "string" && body.session.trim() ? body.session.trim().slice(0, 200) : "default";
    const actor: Actor = { machine, session };
    const global = service.global(body.op, args, actor);
    if (global) {
      send(res, 200, global);
      return;
    }
    if (typeof body.project !== "string") {
      send(res, 200, { code: EXIT.OTHER, message: "this operation needs a project; run utp init or utp link in the checkout" });
      return;
    }
    const engine = service.engine(body.project);
    if (!(engine instanceof Engine)) {
      send(res, 200, engine);
      return;
    }
    const opId = body.op_id as string | undefined;
    if (body.op === "wait") {
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      const r = await holdWait(engine, args, actor, opId, limitMs, recheckMs, gone.signal);
      if (!gone.signal.aborted) send(res, 200, r);
      return;
    }
    send(res, 200, engine.run(body.op, args, actor, opId));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${host}:${addr.port}`,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          service.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
