import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { call, CliError, type ClientConfig } from "../src/cli/client.js";
import { startServer, type RunningService } from "../src/server/http.js";
import { createToken } from "../src/server/tokens.js";
import type { OpResult, RequestBody } from "../src/core/types.js";

const body = (question = "Which parser should the import use?"): RequestBody => ({
  kind: "choose", question, why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.",
});

async function service(dataDir = mkdtempSync(path.join(tmpdir(), "utp-svc-"))) {
  const svc: RunningService = await startServer({ dataDir, port: 0, maxWaitMs: 10_000, recheckMs: 200 });
  const agent: ClientConfig = { server: svc.url, token: createToken(dataDir, "laptop") };
  const person: ClientConfig = { server: svc.url, token: createToken(dataDir, "desk") };
  const project = ((await call("project.create", { remote: "git@github.com:someone/thing.git" }, { config: agent })).project as { id: string }).id;
  const as = (config: ClientConfig) => (op: string, args: Record<string, unknown> = {}, timeoutMs?: number) =>
    call(op, args, { config, project, timeoutMs });
  return { svc, dataDir, project, agent: as(agent), person: as(person), agentCfg: agent };
}

async function presented(s: Awaited<ReturnType<typeof service>>): Promise<string> {
  const asked = await s.agent("ask", { body: body() });
  const flushed = await s.agent("flush");
  await s.agent("presented", { review: flushed.review_id, channel: "conversation" });
  return asked.id as string;
}

test("a request without a valid token is refused", async () => {
  const s = await service();
  try {
    await assert.rejects(call("ping", {}, { config: { server: s.svc.url, token: "utp_wrong" } }),
      (e: unknown) => e instanceof CliError && e.code === 1 && /refused/.test(e.message));
    assert.equal((await s.agent("ping")).machine, "laptop");
  } finally {
    await s.svc.close();
  }
});

test("a service that can't be reached is exit code 32 with the likely causes", async () => {
  const s = await service();
  await s.svc.close();
  await assert.rejects(s.agent("status"),
    (e: unknown) => e instanceof CliError && e.code === 32 && /isn't running/.test(e.message) && /sandbox/.test(e.message));
});

test("a held wait returns as soon as the person answers from another machine", async () => {
  const s = await service();
  try {
    const id = await presented(s);
    const started = Date.now();
    const waiting = s.agent("wait", { id, timeout_s: 8 }, 20_000);
    setTimeout(() => void s.person("answer", { id, value: "b", channel: "conversation" }), 300);
    const r = await waiting;
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal((r.answer as { value: string; machine: string }).value, "b");
    assert.equal((r.answer as { machine: string }).machine, "desk");
    assert.ok(Date.now() - started < 5_000, "the wait should end when the answer lands, not at the timeout");
  } finally {
    await s.svc.close();
  }
});

test("a wait with no answer ends at its timeout with exit code 10", async () => {
  const s = await service();
  try {
    const id = await presented(s);
    const started = Date.now();
    const r = await s.agent("wait", { id, timeout_s: 1 }, 10_000);
    assert.equal(r.code, 10);
    assert.ok(Date.now() - started >= 900);
  } finally {
    await s.svc.close();
  }
});

test("concurrent writers from many sessions all commit, and a restart replays every one", async () => {
  const s = await service();
  const asks: Promise<OpResult>[] = [];
  for (let i = 0; i < 25; i++) {
    process.env.UTP_SESSION = `session-${i}`;
    asks.push(s.agent("ask", { body: body(`Question number ${i}?`) }));
  }
  delete process.env.UTP_SESSION;
  const results = await Promise.all(asks);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results.find((r) => r.code !== 0)));
  assert.equal(new Set(results.map((r) => r.id)).size, 25);
  await s.svc.close();
  const again = await startServer({ dataDir: s.dataDir, port: 0 });
  try {
    const status = await call("status", {}, { config: { ...s.agentCfg, server: again.url }, project: s.project });
    assert.equal((status.requests as unknown[]).length, 25);
  } finally {
    await again.close();
  }
});

test("a second service on the same data folder can't write to a project the first one holds", async () => {
  const s = await service();
  const second = await startServer({ dataDir: s.dataDir, port: 0 });
  try {
    await s.agent("status");
    const r = await call("status", {}, { config: { ...s.agentCfg, server: second.url }, project: s.project });
    assert.equal(r.code, 30);
  } finally {
    await second.close();
    await s.svc.close();
  }
});

test("projects are found by remote whichever way the remote is spelled", async () => {
  const s = await service();
  try {
    const found = await call("project.find", { remote: "https://github.com/someone/thing" }, { config: s.agentCfg });
    assert.deepEqual((found.projects as { id: string }[]).map((p) => p.id), [s.project]);
    const none = await call("project.find", { remote: "https://github.com/someone/other" }, { config: s.agentCfg });
    assert.equal((none.projects as unknown[]).length, 0);
  } finally {
    await s.svc.close();
  }
});
