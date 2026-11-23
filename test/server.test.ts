import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { get } from "node:http";
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

test("relink refuses queued work or an active grant in either project", async () => {
  const s = await service();
  try {
    const { project } = await s.agent("project.create");
    const to = (project as { id: string }).id;
    const target = (op: string, args: Record<string, unknown> = {}) =>
      call(op, args, { config: s.agentCfg, project: to });
    const relink = () => call("project.relink", { from: s.project, to }, { config: s.agentCfg, opId: "test-relink" });

    const queued = await s.agent("ask", { body: body() });
    const sourceBusy = await relink();
    assert.equal(sourceBusy.code, 19);
    assert.equal(sourceBusy.project, s.project);
    assert.equal((await s.agent("cancel", { id: queued.id })).code, 0);

    const action = body();
    const option = action.options?.[0];
    assert.ok(option);
    option.authorization = { action: "refresh", target: "fixtures", scope: "one fixture" };
    const pending = await target("ask", { body: action });
    const flushed = await target("flush");
    await target("presented", { review: flushed.review_id, channel: "conversation" });
    await target("answer", { id: pending.id, value: "a", channel: "cli" });
    assert.equal((await target("wait", { id: pending.id })).status, "granted");
    const targetBusy = await relink();
    assert.equal(targetBusy.code, 19);
    assert.equal(targetBusy.project, to);
    assert.equal((await target("cancel", { id: pending.id })).code, 0);

    assert.deepEqual(await relink(), { code: 0, project: to });
    await s.agent("ask", { body: body("A later request in the source project") });
    assert.deepEqual(await relink(), { code: 0, project: to });
  } finally {
    await s.svc.close();
  }
});

test("a browser batch presents previews and saves only its displayed revisions", async () => {
  const s = await service();
  try {
    const makeBatch = async () => {
      const cards = [];
      for (const name of ["First", "Second", "Third"]) {
        cards.push(await s.agent("ask", { body: { ...body(name), previews: [{ label: "Text preview", text: "<b>Example output</b>" }] } }));
      }
      const flushed = await s.agent("flush");
      const prep = await s.agent("review-page.prepare", { review: flushed.review_id });
      assert.equal(prep.code, 0, prep.message);
      const url = String(prep.url);
      const before = (await s.agent("show", { id: cards[0]?.id })).request as { status: string };
      assert.equal(before.status, "queued");
      const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
        get(url, { headers: { host: "elsewhere.invalid" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject);
      });
      assert.equal(invalidHost, 403);
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("referrer-policy"), "same-origin");
      const html = await page.text();
      assert.match(html, /Text preview/);
      assert.match(html, /&lt;b&gt;Example output&lt;\/b&gt;/);
      assert.match(html, /First/);
      assert.match(html, /Second/);
      assert.match(html, /Third/);
      const cookie = page.headers.get("set-cookie")?.split(";")[0];
      const token = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(html)?.[1];
      assert.ok(cookie && token);
      assert.ok(!url.includes(token));
      const origin = new URL(url).origin;
      const form = new URLSearchParams({ presentation: token, "choice-0": "a", "choice-1": "b", "choice-2": "a" });
      const save = (headers: Record<string, string>) => fetch(url, { method: "POST", headers, body: form });
      return { cards, url, save, origin, cookie };
    };

    const current = await makeBatch();
    assert.equal((await current.save({ origin: "https://elsewhere.invalid", cookie: current.cookie })).status, 403);
    assert.equal((await current.save({ origin: current.origin })).status, 403);
    assert.equal((await current.save({ origin: current.origin, cookie: current.cookie })).status, 200);
    const saved = await s.agent("show", { id: current.cards[1]?.id });
    assert.deepEqual((saved.request as { answer: { value: string; verified: string } }).answer.value, "b");
    assert.equal((saved.request as { answer: { verified: string } }).answer.verified, "channel");

    const stale = await makeBatch();
    await s.agent("revise", { id: stale.cards[0]?.id, body: body("Changed since presentation") });
    assert.equal((await stale.save({ origin: stale.origin, cookie: stale.cookie })).status, 409);
    const unaffected = await s.agent("show", { id: stale.cards[1]?.id });
    assert.equal((unaffected.request as { answer: unknown }).answer, null);
    const spoofed = await s.agent("answer", { id: stale.cards[1]?.id, value: "a", channel: "review-page" });
    assert.equal((spoofed.answer as { verified: string }).verified, "none");
  } finally {
    await s.svc.close();
  }
});
