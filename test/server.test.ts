import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, get, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { call, CliError, type ClientConfig } from "../src/cli/client.js";
import { startServer, type RunningService, type ServeOptions } from "../src/server/http.js";
import { createToken } from "../src/server/tokens.js";
import type { OpResult, RequestBody } from "../src/core/types.js";

const body = (question = "Which parser should the import use?"): RequestBody => ({
  kind: "choose", category: "approach", question, why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.",
});

async function service(dataDir = mkdtempSync(path.join(tmpdir(), "utp-svc-")), options?: Partial<ServeOptions>) {
  const svc: RunningService = await startServer({ dataDir, port: 0, maxWaitMs: 10_000, recheckMs: 200, ...options });
  const agent: ClientConfig = { server: svc.url, token: createToken(dataDir, "laptop") };
  const person: ClientConfig = { server: svc.url, token: createToken(dataDir, "desk") };
  const project = ((await call("project.create", { remote: "git@github.com:someone/thing.git" }, { config: agent })).project as { id: string }).id;
  const as = (config: ClientConfig) => (op: string, args: Record<string, unknown> = {}, timeoutMs?: number) =>
    call(op, args, { config, project, timeoutMs });
  return { svc, dataDir, project, agent: as(agent), person: as(person), agentCfg: agent };
}

test("one attention item serves a review across retries and restart, and notices alone stay silent", async () => {
  const accepted = new Map<string, Record<string, unknown>>();
  let attempts = 0;
  let allowAck = false;
  const receiver = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk.toString();
    const event = JSON.parse(text) as Record<string, unknown>;
    attempts++;
    accepted.set(String(event.event_id), event);
    res.writeHead(allowAck ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: allowAck, event_id: event.event_id }));
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
  const notifications: NonNullable<ServeOptions["notifications"]> = { retryMs: 25,
    send: async (event, signal) => {
      const response = await fetch(url, { method: "POST", body: JSON.stringify(event), signal });
      return await response.json() as { ok: boolean; event_id: string };
    },
  };
  const s = await service(undefined, { notifications });
  let current = s.svc;
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 6_000;
    while (!(await condition())) {
      assert.ok(Date.now() < deadline, "attention delivery did not reach the expected state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await s.agent("ask", { body: { ...body("A quiet update"), kind: "notice", level: 1 } });
    const notice = await s.agent("flush");
    assert.equal(notice.code, 0);
    await s.agent("presented", { review: notice.review_id, channel: "conversation" });
    const ids = [];
    for (const question of ["First sample?", "Another sample?"]) ids.push((await s.agent("ask", { body: body(question) })).id);
    const intent = { task_title: "Import settings", asked: "Prepare the private import.",
      doing: "Choose the internal parser.", scope_delta: "none" };
    const flush = await s.agent("flush", { intent });
    assert.equal((await s.agent("flush")).review_id, null);
    await until(() => attempts >= 2);
    assert.equal(accepted.size, 1);
    const requested = [...accepted.values()][0]!;
    assert.equal(requested.type, "review.ready");
    assert.equal(requested.questions, 2);
    assert.equal(requested.task_title, intent.task_title);
    assert.doesNotMatch(JSON.stringify(requested), /private import|internal parser|First sample/);
    assert.match(String(requested.dedupe_key), new RegExp(String(flush.review_id)));
    await current.close();
    allowAck = true;
    current = await startServer({ dataDir: s.dataDir, port: 0, notifications });
    const options = { config: { ...s.agentCfg, server: current.url }, project: s.project };
    await until(async () => ((await call("show", { id: flush.review_id }, options)).review as { delivery: string }).delivery === "sent");
    assert.equal(accepted.size, 1);
    assert.deepEqual([...accepted.values()][0], requested);
    await call("presented", { review: flush.review_id, channel: "conversation" }, options);
    for (const id of ids) assert.equal((await call("answer", { id, value: "a", channel: "cli" }, options)).code, 0);
    await until(() => [...accepted.values()].some((event) => event.type === "review.resolved"));
    assert.equal(accepted.size, 2);
    assert.ok([...accepted.values()].every((event) => event.dedupe_key === requested.dedupe_key));
    assert.equal([...accepted.values()].find(event => event.type === "review.resolved")?.task_title, undefined);

    await call("ask", { body: body("Private question in an untitled review?") }, options);
    const legacy = await call("flush", {}, options);
    await until(() => [...accepted.values()].some(event => event.review_id === legacy.review_id));
    const untitled = [...accepted.values()].find(event => event.review_id === legacy.review_id)!;
    assert.equal(untitled.task_title, undefined);
    assert.doesNotMatch(JSON.stringify(untitled), /Private question/);
  } finally {
    await current.close();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

test("notice-only flush writes a redacted morning report item and records its receipt", async () => {
  const inboxDir = mkdtempSync(path.join(tmpdir(), "utp-report-inbox-"));
  const s = await service(undefined, { inboxDir });
  try {
    const secret = "utp_" + "q".repeat(32);
    const notice = await s.agent("ask", { body: { ...body("A routine import update"), kind: "notice", level: 1,
      why_now: `Keep the checked import. Sample data includes ${secret}.` } });
    const flush = await s.agent("flush");
    assert.equal(flush.digest, true);
    const files = readdirSync(inboxDir).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const item = JSON.parse(readFileSync(path.join(inboxDir, files[0]!), "utf8"));
    assert.equal(item.schema, "utp-report-notice/v1");
    assert.equal(item.review_id, flush.review_id);
    assert.match(item.body_md, /Keep the checked import/);
    assert.match(item.body_md, /\[redacted\]/);
    assert.ok(!item.body_md.includes(secret));
    const view = (await s.agent("show", { id: notice.id })).request as { status: string; presented_at: string };
    assert.equal(view.status, "closed");
    assert.ok(Number.isFinite(Date.parse(view.presented_at)));
    await s.agent("flush");
    assert.deepEqual(readdirSync(inboxDir).filter((name) => name.endsWith(".json")), files);
  } finally {
    await s.svc.close();
  }
});

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
      const flushed = await s.agent("flush", { intent: { asked: "Compare the <spring> entries.",
        doing: "Select the catalogue order.", scope_delta: "none" } });
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
      assert.match(html, /How sure are you/);
      assert.match(html, /Compare the &lt;spring&gt; entries/);
      assert.match(html, /Wrong options/);
      const cookie = page.headers.get("set-cookie")?.split(";")[0];
      const token = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(html)?.[1];
      assert.ok(cookie && token);
      assert.ok(!url.includes(token));
      const origin = new URL(url).origin;
      const form = new URLSearchParams({ presentation: token, "choice-0": "a", "choice-1": "b", "choice-2": "a",
        "sureness-1": "leaning", "feedback-1": "needed_more" });
      const save = (headers: Record<string, string>) => fetch(url, { method: "POST", headers, body: form });
      return { cards, url, save, origin, cookie, form, reviewId: flushed.review_id };
    };

    const current = await makeBatch();
    assert.equal((await current.save({ origin: "https://elsewhere.invalid", cookie: current.cookie })).status, 403);
    assert.equal((await current.save({ origin: current.origin })).status, 403);
    current.form.set("clarify", "1");
    current.form.set("clarify-note-1", "What changes when I choose the second option?");
    const clarification = await current.save({ origin: current.origin, cookie: current.cookie });
    assert.equal(clarification.status, 200);
    assert.match(await clarification.text(), /Clarification requested/);
    const waiting = await s.agent("wait", { id: current.cards[1]?.id });
    assert.equal(waiting.code, 21);
    assert.equal(waiting.answer, null);
    assert.equal((waiting.clarification as { note: string }).note, "What changes when I choose the second option?");
    assert.equal((await s.agent("wait", { id: current.cards[0]?.id })).code, 10);
    current.form.delete("clarify");
    current.form.set("feedback-1", "unknown");
    assert.equal((await current.save({ origin: current.origin, cookie: current.cookie })).status, 400);
    current.form.set("feedback-1", "needed_more");
    const custom = "  Put <maps> first.\nKeep the last two together.  ";
    current.form.set("custom-2", custom);
    const posted = await current.save({ origin: current.origin, cookie: current.cookie });
    assert.equal(posted.status, 200);
    const receipt = await posted.text();
    assert.match(receipt, /Compare the &lt;spring&gt; entries/);
    assert.ok(receipt.includes(custom.replace("<maps>", "&lt;maps&gt;")));
    assert.ok(receipt.includes(current.cards[2]!.id + "@1"));
    assert.equal((await (await fetch(current.url, { headers: { cookie: current.cookie } })).text()), receipt);
    const customCard = (await s.agent("show", { id: current.cards[2]!.id })).request as { answer: { custom: string } };
    assert.equal(customCard.answer.custom, custom);
    assert.equal((await s.agent("answer", { id: current.cards[2]!.id, channel: "terminal-piped", custom: "A later correction." })).code, 0);
    const originalReceipt = await fetch(current.url, { headers: { cookie: current.cookie } });
    assert.equal(await originalReceipt.text(), receipt);
    const saved = await s.agent("show", { id: current.cards[1]?.id });
    const request = saved.request as { presented_at: string; answer: Record<string, unknown> };
    assert.equal(request.answer.value, "b");
    assert.equal(request.answer.verified, "channel");
    assert.equal(request.answer.sureness, "leaning");
    assert.equal(request.answer.feedback, "needed_more");
    assert.ok(!("active_response_ms" in request.answer));
    assert.ok(Date.parse(request.presented_at) <= Date.parse(String(request.answer.at)));
    const review = (await s.agent("show", { id: current.reviewId })).review as { page_response_ms: number;
      presentations: { id: string; items: string[]; acknowledged_at?: string }[] };
    assert.ok(Number.isSafeInteger(review.page_response_ms) && review.page_response_ms >= 0);
    const presentation = review.presentations.find(p => p.id === request.answer.presentation_id);
    assert.ok(presentation?.acknowledged_at);
    assert.deepEqual(presentation.items, current.cards.map(c => c.id + "@1"));

    const stale = await makeBatch();
    await s.agent("revise", { id: stale.cards[0]?.id, body: body("Changed since presentation") });
    assert.equal((await stale.save({ origin: stale.origin, cookie: stale.cookie })).status, 409);
    const unaffected = await s.agent("show", { id: stale.cards[1]?.id });
    assert.equal((unaffected.request as { answer: unknown }).answer, null);
    const spoofed = await s.agent("answer", { id: stale.cards[1]?.id, value: "a", channel: "review-page" });
    assert.equal((spoofed.answer as { verified: string }).verified, "none");
    await s.svc.close();
    const restarted = await startServer({ dataDir: s.dataDir, port: 0 });
    try {
      const options = { config: { ...s.agentCfg, server: restarted.url }, project: s.project };
      const restored = await call("show", { id: current.reviewId }, options);
      assert.equal((restored.review as { page_response_ms: number }).page_response_ms, review.page_response_ms);
      const restoredCard = await call("show", { id: current.cards[1]?.id }, options);
      assert.deepEqual((restoredCard.request as { answer: unknown }).answer, request.answer);
    } finally {
      await restarted.close();
    }
  } finally {
    await s.svc.close();
  }
});

test("a review link keeps its browser binding after restart and expires at 24 hours", async () => {
  const start = Date.now();
  let time = start;
  const now = () => new Date(time);
  const s = await service(undefined, { now });
  let running = s.svc;
  try {
    await s.agent("ask", { body: body() });
    const review = await s.agent("flush");
    const prepared = await s.agent("review-page.prepare", { review: review.review_id });
    const link = String(prepared.url);
    const visit = (cookie?: string, answers?: URLSearchParams) => new Promise<{ status?: number; setCookie?: string; html: string }>((resolve, reject) => {
      const req = request(link, { agent: false, method: answers ? "POST" : "GET", headers: {
        ...(cookie ? { cookie } : {}), ...(answers ? { origin: new URL(link).origin, "content-type": "application/x-www-form-urlencoded" } : {}) },
      }, (res) => {
        let html = "";
        res.setEncoding("utf8").on("data", (chunk) => { html += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"]?.[0], html }));
      });
      req.on("error", reject).end(answers?.toString());
    });
    time = start + 31 * 60_000;
    const opened = await visit();
    assert.equal(opened.status, 200);
    assert.match(opened.setCookie ?? "", /Max-Age=84540;/);
    const cookie = opened.setCookie?.split(";")[0];
    assert.ok(cookie);
    await running.close();
    running = await startServer({ dataDir: s.dataDir, port: Number(new URL(link).port), now });
    assert.equal((await visit()).status, 403);
    time = start + 24 * 60 * 60_000 - 1;
    const returned = await visit(cookie);
    const form = /name="presentation" value="([A-Za-z0-9_-]+)"/.exec(returned.html)?.[1];
    assert.equal(returned.status, 200);
    assert.ok(form);
    const answers = new URLSearchParams({ presentation: form, "choice-0": "a" });
    assert.match((await visit(cookie, answers)).html, /Answers saved/);
    await running.close();
    running = await startServer({ dataDir: s.dataDir, port: Number(new URL(link).port), now });
    assert.match((await visit(cookie, answers)).html, /Answers saved/);
    time++;
    assert.equal((await visit(cookie)).status, 404);
  } finally {
    await running.close();
  }
});

test("the private reviewer socket lists outstanding questions and opens only the selected review",
  { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "utp-inbox-"));
    const socket = path.join(dir, "review.sock");
    const origin = "https://reviews.example.test";
    const options = { reviewOrigin: origin, reviewInboxSocket: socket };
    const s = await service(undefined, options);
    const browse = (url: string, method = "GET", headers: Record<string, string> = {}, text = "") =>
      new Promise<{ status: number; html: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
        const req = request({ socketPath: socket, path: url, method, headers: { host: "reviews.example.test", ...headers } }, (res) => {
          let html = "";
          res.setEncoding("utf8").on("data", (chunk) => { html += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, html, headers: res.headers }));
        });
        req.on("error", reject).end(text);
      });
    try {
      assert.equal((await fetch(s.svc.url + "/")).status, 404);
      assert.equal((await fetch(s.svc.url + "/review/invalid")).status, 404);
      assert.equal((await browse("/v1/op", "POST")).status, 404);
      assert.equal((await browse("/", "GET", { host: "different.example.test" })).status, 403);
      assert.match((await browse("/")).html, /No questions are waiting/);
      const card = await s.agent("ask", { body: body("Which <sample> needs review?") });
      assert.doesNotMatch((await browse("/")).html, /Which/);
      const flushed = await s.agent("flush");
      const listed = await browse("/");
      assert.equal(listed.status, 200);
      assert.equal(listed.headers["cache-control"], "no-store");
      assert.match(listed.html, /Which &lt;sample&gt; needs review/);
      const path = `/open/${s.project}/${flushed.review_id}`;
      assert(listed.html.includes(path));
      assert.equal((await browse(path, "POST", { origin: "https://other.example.test" })).status, 403);
      const open = await browse(path, "POST", { origin });
      assert.equal(open.status, 303);
      const target = open.headers.location!;
      assert.match(target, /^\/review\/[A-Za-z0-9_-]+$/);
      const current = await browse(target);
      assert.match(current.html, /Which &lt;sample&gt; needs review/);
      const cookie = current.headers["set-cookie"]?.[0]?.split(";")[0];
      const form = /name="presentation" value="([A-Za-z0-9_-]+)"/.exec(current.html)?.[1];
      assert.ok(cookie && form);
      assert.equal((await browse(target, "POST", { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
        new URLSearchParams({ presentation: form, "choice-0": "a" }).toString())).status, 200);
      assert.equal(((await s.agent("show", { id: card.id })).request as { status: string }).status, "answered");
      assert.match((await browse("/")).html, /No questions are waiting/);
    } finally {
      await s.svc.close();
    }
  });
