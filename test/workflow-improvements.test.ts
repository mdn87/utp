// End-to-end tests for the six approved workflow and review-frame improvements
// recorded in docs/decisions/0003-workflow-improvements.export.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, type ClientConfig } from "../src/cli/client.js";
import { reviewMarkdown, type RequestView, type ReviewView } from "../src/cli/render.js";
import { checkDocument } from "../src/core/check.js";
import { computeRevisionDiff } from "../src/core/diff.js";
import { Engine, type ResumeCardPacket } from "../src/core/engine.js";
import { EXIT, type Actor, type RequestBody } from "../src/core/types.js";
import { startServer, type ServeOptions } from "../src/server/http.js";
import { handleReviewerInbox } from "../src/server/reviewer-inbox.js";
import { ReviewPages } from "../src/server/review-page.js";
import { Service, type ProjectInfo } from "../src/server/service.js";
import { createToken } from "../src/server/tokens.js";

const CLI = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function utp(args: string[], opts: { cwd: string; home: string; input?: string; env?: Record<string, string> }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, UTP_HOME: opts.home, UTP_SESSION: "agent-1", ...opts.env };
    delete env.UTP_SERVER;
    delete env.UTP_PROJECT;
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "utp-wf-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const chooseCard = (question: string, extra: Partial<RequestBody> = {}): RequestBody => ({
  kind: "choose",
  category: "approach",
  question,
  why_now: "This step needs a concrete choice before writing code.",
  options: [
    { id: "a", label: "First option", consequence: "Uses the first approach.", agent_next: "Write the first implementation." },
    { id: "b", label: "Second option", consequence: "Uses the second approach.", agent_next: "Write the second implementation." },
  ],
  recommendation: { option: "a", because: "Simpler to verify.", preserves: "Current file layout.", bolder_alternative: "Second option rewrites the pipeline." },
  stakes: { reversibility: "easy" },
  level: 2,
  level_reason: "Reversible trade-off between two approaches.",
  ...extra,
});

const approveCard = (question: string, extra: Partial<RequestBody> = {}): RequestBody => ({
  kind: "approve",
  question,
  why_now: "Changing the remote schema cannot be undone automatically.",
  options: [
    {
      id: "yes", label: "Apply full migration", consequence: "Updates all tables.",
      authorization: { action: "migrate", target: "production schema", scope: "tables alpha, beta", expected_effect: "both tables migrated" },
      agent_next: "Run the migration across alpha and beta.",
    },
    {
      id: "narrow", narrower_than: "yes", label: "Migrate alpha only", consequence: "Updates only table alpha.",
      authorization: { action: "migrate", target: "production schema", scope: "tables alpha", expected_effect: "table alpha migrated" },
      agent_next: "Run the migration on alpha only.",
    },
    { id: "no", label: "Skip migration", consequence: "Leaves the schema untouched." },
  ],
  evidence: [{ claim: "Dry run succeeded on staging.", kind: "observed", source: "staging-check.log", date: "2026-11-25" }],
  stakes: { reversibility: "one_way" },
  level: 3,
  level_reason: "Production schema change cannot be reversed automatically.",
  ...extra,
});

async function openReviewPage(url: string) {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const cookie = page.headers.get("set-cookie")?.split(";")[0];
  const token = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(cookie && token, "expected cookie and presentation token");
  const origin = new URL(url).origin;
  const post = (fields: Record<string, string>) => {
    const form = new URLSearchParams({ presentation: token, ...fields });
    return fetch(url, { method: "POST", headers: { origin, cookie }, body: form });
  };
  return { html, cookie, token, origin, post };
}

async function renderInbox(service: Service, pages: ReviewPages, url = "/", method = "GET",
  headers: Record<string, string> = {}, waitersFor?: (project: string, reviewId: string) => Actor[], bodyText?: string) {
  let html = "";
  let status = 0;
  let respHeaders: Record<string, string> = {};
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { status = code; respHeaders = h ?? {}; return res; },
    end: (text?: string) => { html += text ?? ""; },
  };
  const req = { url, method, headers: { host: pages.origin.host, ...headers } } as IncomingMessage;
  await handleReviewerInbox(req, res as unknown as ServerResponse, service, pages, async () => bodyText, waitersFor);
  return { status, headers: respHeaders, html };
}

test("project pins preserve the selected answer through edits, reversals, supersession and restart", t => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-pins-"));
  let service = new Service(data);
  t.after(() => service.close());
  const actor = { machine: "sample", session: "author" };
  const create = (name: string) => (service.global("project.create", { name }, actor)!.project as ProjectInfo).id;
  const project = create("Library"), other = create("Other");
  const run = (verb: string, args: Record<string, unknown> = {}, id = project) =>
    (service.engine(id) as Engine).run(verb, args, actor);
  const card = run("ask", { body: chooseCard("Which compatibility rule?") });
  const ref = `${card.id}@1`;
  assert.deepEqual(run("pins").pins, []);
  assert.equal(run("pin", { id: ref }).code, EXIT.NOT_ALLOWED);
  run("flush");
  run("presented", { review: card.review_id, channel: "terminal-review" });
  run("answer", { id: ref, value: "a", channel: "terminal-review" });
  const args = { id: ref, note: "Applies to extensions" };
  assert.equal(run("pin", args).code, 0);
  const initial = (run("pins").pins as Record<string, unknown>[])[0]!;
  assert.equal(initial.id, card.id);
  assert.equal(initial.review_id, card.review_id);
  assert.equal(initial.revision, 1);
  assert.equal(initial.title, "Which compatibility rule?");
  assert.match(String(initial.answer), /First option/);
  assert.equal(initial.note, args.note);
  assert.ok(Number.isFinite(Date.parse(String(initial.pinned_at))));
  assert.equal(initial.stale, false);
  run("pin", { id: card.id });
  assert.deepEqual(run("pins").pins, [initial]);
  assert.deepEqual(run("pins", {}, other).pins, []);
  assert.equal(run("pin", args, other).code, EXIT.NOT_FOUND);
  const state = () => (run("pins").pins as { answer: string; stale: boolean; reasons: string[] }[])[0]!;
  run("edit", { id: ref, value: "b", channel: "terminal-review" });
  assert.deepEqual(state().reasons, ["changed"]);
  assert.equal(state().answer, initial.answer);
  run("edit", { id: ref, withdraw: true, channel: "terminal-review" });
  assert.deepEqual(state().reasons, ["withdrawn"]);
  run("answer", { id: ref, value: "a", channel: "terminal-review" });
  run("reverse", { id: ref, reason: "We changed the rule." });
  assert.equal(state().stale, true);
  assert.ok(state().reasons.includes("reversed"));
  run("revise", { id: card.id, body: chooseCard("Which revised compatibility rule?") });
  assert.ok(state().reasons.includes("superseded"));
  const before = state();
  service.close();
  service = new Service(data);
  assert.deepEqual(state(), before);
  assert.equal(run("unpin", { id: card.id }).code, 0);
  assert.deepEqual(run("pins").pins, []);
});

test("the CLI and protected inbox manage pins and show them on later reviews", async t => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-pin-inbox-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  t.after(() => svc.close());
  const actor = { machine: "sample", session: "author" };
  const config = { server: svc.url, token: createToken(data, actor.machine) };
  const project = (svc.service.global("project.create", { name: "Library" }, actor)!.project as ProjectInfo).id;
  const engine = svc.service.engine(project) as Engine;
  const run = (op: string, args: Record<string, unknown> = {}) => engine.run(op, args, actor);
  const source = run("ask", { body: chooseCard("Which compatibility rule?") });
  const ref = `${source.id}@1`;
  run("flush");
  run("presented", { review: source.review_id, channel: "terminal-review" });
  run("answer", { id: ref, value: "a", channel: "terminal-review" });
  const pending = run("ask", { body: chooseCard("Which later format?") });
  run("flush");
  const cwd = repo(), home = mkdtempSync(path.join(tmpdir(), "utp-pin-home-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  const cmd = (args: string[], input?: string) => utp(args, { cwd, home, input, env: { UTP_PROJECT: project } });
  const pinned = await cmd(["pin", String(source.id), "--note", "Keep <v1>"]);
  assert.equal(pinned.code, 0, pinned.stderr + pinned.stdout);
  assert.equal(JSON.parse((await cmd(["pins", "--json"])).stdout).pins[0].note, "Keep <v1>");
  const inbox = (await cmd(["inbox"])).stdout;
  assert.match(inbox, /Pinned decisions[\s\S]*First option[\s\S]*Which later format/);
  const pages = new ReviewPages(new URL("https://reviews.example.test"), svc.service, Date.now, true);
  const detail = `/history/${project}/${source.review_id}`;
  const list = await renderInbox(svc.service, pages);
  assert.match(list.html, /<details[^>]*>\s*<summary>Pinned decisions \(1\)/);
  assert.ok(list.html.includes(`${detail}#${ref}`));
  assert.ok(list.html.includes("Keep &lt;v1&gt;"));
  const local = new URL(String(pages.prepare(project, actor, pending.review_id).url)).pathname;
  const reviewHtml = (await renderInbox(svc.service, pages, local)).html;
  assert.match(reviewHtml, /Pinned decisions \(1\)[\s\S]*First option/);
  const publicLink = await call("review-page.prepare", { review: pending.review_id }, { project, config });
  assert.equal(publicLink.code, 0, publicLink.message);
  assert.doesNotMatch(await (await fetch(String(publicLink.url))).text(), /Which compatibility rule|Keep &lt;v1&gt;|Pinned decisions \(1\)/);
  const post = (op: string, origin: string, values: Record<string, string>) => renderInbox(svc.service, pages,
    `/pins/${project}/${ref}/${op}`, "POST", { origin, "content-type": "application/x-www-form-urlencoded" },
    undefined, new URLSearchParams(values).toString());
  const version = (html: string) => {
    const value = /name="expected" value="([a-f\d]+)"/.exec(html)?.[1];
    assert.ok(value);
    return value;
  };
  const unpin = { return: detail, expected: version(list.html) };
  assert.equal((await post("unpin", "https://elsewhere.example.test", unpin)).status, 403);
  run("pin", { id: ref, note: "This decision also covers plugins." });
  assert.equal((await post("unpin", pages.origin.origin, unpin)).status, 409);
  unpin.expected = version((await renderInbox(svc.service, pages)).html);
  assert.equal((await post("unpin", pages.origin.origin, unpin)).status, 303);
  assert.deepEqual(run("pins").pins, []);
  const page = (await renderInbox(svc.service, pages, detail)).html;
  assert.ok(page.includes(`/pins/${project}/${ref}/pin`));
  const oldAnswer = version(page);
  run("edit", { id: ref, value: "b", channel: "terminal-review" });
  assert.equal((await post("pin", pages.origin.origin, { return: detail, expected: oldAnswer })).status, 409);
  const expected = version((await renderInbox(svc.service, pages, detail)).html);
  const submission = { return: detail, expected, submission: "00000000-0000-4000-8000-000000000011" };
  assert.equal((await post("pin", pages.origin.origin, submission)).headers.location, detail);
  run("reverse", { id: ref, reason: "Reconsidered" });
  assert.match((await renderInbox(svc.service, pages)).html, /Reversed/);
  const terminal = await cmd(["review", String(pending.review_id)], "a\n");
  assert.match(terminal.stdout, /Pinned decisions[\s\S]*Reversed[\s\S]*Which later format/);
  run("revise", { id: source.id, body: chooseCard("Which replacement rule?") });
  assert.match((await renderInbox(svc.service, pages)).html, /Superseded/);
  assert.equal((await cmd(["unpin", String(source.id)])).code, 0);
  assert.equal((await post("pin", pages.origin.origin, submission)).status, 303);
  assert.deepEqual(run("pins").pins, []);
  assert.doesNotMatch((await renderInbox(svc.service, pages)).html, /<summary>Pinned decisions/);
});

test("history searches older prepared reviews by title, question and tag, and starts an independent follow-up", async (t) => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-history-"));
  let service = new Service(data);
  t.after(() => service.close());
  const actor = { machine: "laptop", session: "author" };
  const project = (service.global("project.create", { name: "Sample" }, actor)!.project as ProjectInfo).id;
  let engine = service.engine(project) as Engine;
  const run = (op: string, args: Record<string, unknown> = {}, opId?: string) => engine.run(op, args, actor, opId);
  const card = run("ask", { body: chooseCard("Which search layout?", { tags: ["archive-tools"] }) });
  const approval = run("ask", { body: approveCard("Approve the rollout?") });
  const source = String(card.review_id);
  const ref = `${card.id}@1`;
  const actionRef = `${approval.id}@1`;
  run("flush", { intent: { task_title: "First planning round", asked: "Pick a layout.", doing: "Plan the work.", scope_delta: "none" } });
  run("presented", { review: source, channel: "terminal-review" });
  assert.equal(run("answer", { id: ref, value: "b", channel: "terminal-review" }).code, 0);
  assert.equal(run("answer", { id: actionRef, value: "yes", channel: "terminal-review" }).code, 0);
  for (let i = 0; i < 12; i++) {
    run("ask", { body: chooseCard(`Which other layout for sample ${i}?`) });
    run("flush");
  }
  const privateDraft = run("ask", { body: chooseCard("Unpublished draft?") });
  for (const query of ["first PLANNING", "search layout", "archive-tools"]) {
    const found = run("history", { query });
    assert.equal(found.code, 0, found.message);
    assert.deepEqual((found.reviews as { review_id: string }[]).map(r => r.review_id), [source]);
  }
  assert.deepEqual(run("history", { query: "unpublished" }).reviews, []);
  const select = { review: source, cards: [ref, actionRef], title: "Second round", ideas: ["Search by date"] };
  const before = run("show", { id: source });
  assert.notEqual(run("follow-up", { ...select, cards: [ref, `${privateDraft.id}@1`] }).code, 0);
  const created = run("follow-up", select, "history-example");
  assert.equal(created.code, 0, created.message);
  assert.notEqual(created.review_id, source);
  assert.deepEqual(run("follow-up", select, "history-example"), created);
  assert.notEqual(run("follow-up", { ...select, ideas: [] }, "history-example").code, 0);
  const shown = run("show", { id: created.review_id }).review as ReviewView;
  assert.equal(shown.items.length, 3);
  assert.deepEqual(shown.items.map(c => c.answer), [null, null, null]);
  assert.deepEqual(shown.items[0]!.body.related, [card.id]);
  assert.equal(shown.items[0]!.body.options?.[1]?.label, "Second option");
  assert.ok(shown.items.every(c => !c.body.default && !c.body.options?.some(o => o.authorization)));
  assert.match(reviewMarkdown(shown), /Second option/);
  assert.ok(shown.intent?.already_done?.includes(ref));
  assert.ok(shown.intent?.already_done?.includes("Second option"));
  assert.equal(shown.follow_up?.cards[0]?.option_id, "b");
  assert.match(shown.items[2]!.body.question, /Search by date/);
  assert.deepEqual(run("show", { id: source }), before);
  assert.equal(run("status").open_review, privateDraft.review_id);
  service.close();
  service = new Service(data);
  engine = service.engine(project) as Engine;
  assert.deepEqual(run("show", { id: created.review_id }).review, shown);
});

test("the CLI searches the project and starts a follow-up from the returned revision and a UTF-8 idea file", async t => {
  const dir = repo();
  const data = mkdtempSync(path.join(tmpdir(), "utp-cli-history-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  t.after(() => svc.close());
  const config = { server: svc.url, token: createToken(data, "laptop") };
  const project = ((await call("project.create", { name: "Sample" }, { config })).project as ProjectInfo).id;
  const options = { config, project };
  const source = await call("ask", { body: chooseCard("Which layout?", { tags: ["catalog"] }) }, options);
  await call("flush", {}, options);
  const home = mkdtempSync(path.join(tmpdir(), "utp-cli-history-home-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  const cmd = (args: string[]) => utp(args, { cwd: dir, home, env: { UTP_PROJECT: project } });
  const search = await cmd(["history", "CaTaLog", "--json"]);
  assert.equal(search.code, 0, search.stderr);
  const saved = JSON.parse(search.stdout).reviews[0];
  assert.equal(saved.review_id, source.review_id);
  writeFileSync(path.join(dir, "round.json"), JSON.stringify({ title: "Next round", ideas: ["Café events"] }));
  const follow = await cmd(["follow-up", saved.review_id, saved.cards[0].ref, "--file", "round.json", "--json"]);
  assert.equal(follow.code, 0, follow.stdout + follow.stderr);
  const newer = JSON.parse(follow.stdout);
  const view = (await call("show", { id: newer.review_id }, options)).review as ReviewView;
  assert.equal(view.follow_up?.review, saved.review_id);
  assert.deepEqual(view.follow_up?.cards.map(c => c.ref), [saved.cards[0].ref]);
  assert.equal(view.items.length, 2);
  assert.match(view.items[1]!.body.question, /Café events/);
  assert.match((await cmd(["history", "Next round"])).stdout, /Next round[\s\S]+Café events/);
});

test("the inbox finds a saved review and opens a follow-up of the checked cards with a new idea", async (t) => {
  const service = new Service(mkdtempSync(path.join(tmpdir(), "utp-inbox-history-")));
  t.after(() => service.close());
  const actor = { machine: "laptop", session: "writer" };
  const project = (service.global("project.create", { name: "Sample" }, actor)!.project as ProjectInfo).id;
  const engine = service.engine(project) as Engine;
  const first = engine.run("ask", { body: chooseCard("Which first layout?") }, actor);
  const second = engine.run("ask", { body: chooseCard("Which second layout?") }, actor);
  engine.run("flush", { intent: { task_title: "Layout workshop", asked: "Choose layouts.", doing: "Gather answers.", scope_delta: "none" } }, actor);
  const pages = new ReviewPages(new URL("https://reviews.example.test"), service, Date.now, true);
  assert.match((await renderInbox(service, pages)).html, /action="\/history"/);
  const results = await renderInbox(service, pages, "/history?q=workshop");
  const detailPath = `/history/${project}/${first.review_id}`;
  assert.ok(results.html.includes(detailPath));
  const detail = await renderInbox(service, pages, detailPath);
  assert.equal(detail.status, 200);
  assert.ok(detail.html.includes(`value="${second.id}@1"`));
  const fields = new URLSearchParams({ card: `${second.id}@1`, title: "More ideas", ideas: "Browse by date" });
  for (const name of ["submission", "version"]) {
    const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(detail.html)?.[1];
    assert.ok(value, name);
    fields.set(name, value);
  }
  const route = detailPath + "/follow-up";
  assert.equal((await renderInbox(service, pages, route, "POST", { origin: "https://other.example.test" }, undefined, fields.toString())).status, 403);
  const submit = () => renderInbox(service, pages, route, "POST", { origin: pages.origin.origin }, undefined, fields.toString());
  const response = await submit();
  assert.equal(response.status, 303);
  assert.match(response.headers.location!, /^\/review\//);
  assert.equal((await submit()).status, 303);
  const found = engine.run("history", { query: "More ideas" }, actor).reviews as { review_id: string }[];
  assert.equal(found.length, 1);
  const review = engine.run("show", { id: found[0]!.review_id }, actor).review as ReviewView;
  assert.equal(review.items.length, 2);
  assert.ok(review.items[0]!.body.related?.includes(String(second.id)));
  assert.doesNotMatch(reviewMarkdown(review), /Which first layout/);
  fields.set("submission", "00000000-0000-4000-8000-000000000001");
  engine.run("presented", { review: first.review_id, channel: "terminal-review" }, actor);
  assert.equal(engine.run("answer", { id: `${second.id}@1`, channel: "terminal-review", value: "a" }, actor).code, 0);
  const changed = await submit();
  assert.equal(changed.status, 409);
  assert.match(changed.html, /First option/);
});

test("Idea 7: per-session draft queues isolate parallel sessions and utp stage checks D4, depends_on, and notice overlap", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-wf7-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cwd = repo();
    const home = mkdtempSync(path.join(tmpdir(), "utp-wf7-home-"));
    const run = (args: string[], session = "sess-a", input?: string) =>
      utp(args, { cwd, home, input, env: { UTP_SESSION: session } });
    assert.equal((await run(["connect", svc.url], "sess-a", createToken(data, "dev"))).code, 0);
    assert.equal((await run(["init"])).code, 0);

    // Parallel sessions queue into separate draft reviews without colliding.
    writeFileSync(path.join(cwd, "a.json"), JSON.stringify(chooseCard("Question from session A?")));
    writeFileSync(path.join(cwd, "b.json"), JSON.stringify(chooseCard("Question from session B?")));
    const askA = JSON.parse((await run(["ask", "a.json", "--json"], "sess-a")).stdout);
    const askB = JSON.parse((await run(["ask", "b.json", "--json"], "sess-b")).stdout);
    assert.notEqual(askA.review_id, askB.review_id);

    const statusA = JSON.parse((await run(["status", "--json"], "sess-a")).stdout);
    assert.equal(statusA.open_review, askA.review_id);
    assert.ok((statusA.open_reviews as string[]).includes(askA.review_id));
    assert.ok((statusA.open_reviews as string[]).includes(askB.review_id));

    // Flushing session A flushes only session A's review; session B stays draft and hidden from inbox.
    const flushA = JSON.parse((await run(["flush", "--json"], "sess-a")).stdout);
    assert.equal(flushA.review_id, askA.review_id);
    const statusB = JSON.parse((await run(["status", "--json"], "sess-b")).stdout);
    assert.equal(statusB.open_review, askB.review_id);
    const pages = new ReviewPages(new URL("https://reviews.example.test"), svc.service, Date.now, true);
    const inbox = await renderInbox(svc.service, pages);
    assert.equal(inbox.status, 200);
    assert.match(inbox.html, /Question from session A\?/);
    assert.doesNotMatch(inbox.html, /Question from session B\?/);

    // utp stage enforces D4 default eligibility (S29) and depends_on ordering (S30).
    const badBatch = {
      review: {
        intent: { task_title: "Stage validation", asked: "Validate staging rules.", doing: "Checking defaults and order.", scope_delta: "none" },
        requests: [
          chooseCard("Card 1 depends forward?", {
            id: "card-1",
            depends_on: ["card-2"],
            category: "design",
            default: {
              option: "a", consequence: "Picks first design.",
              eligibility: { local: true, scope_delta: "none", undo: "Revert file.", authority: "local repo", size: "small" },
            },
          }),
          chooseCard("Card 2 comes second?", { id: "card-2" }),
        ],
      },
    };
    writeFileSync(path.join(cwd, "bad-batch.json"), JSON.stringify(badBatch));
    const badStage = await run(["stage", "bad-batch.json", "--json"], "sess-stage");
    assert.equal(badStage.code, EXIT.CHECK_FAILED);
    const rules = (JSON.parse(badStage.stdout).failures as { rule: string }[]).map((f) => f.rule);
    assert.ok(rules.includes("S29-default-eligibility"), `expected S29 in ${rules.join(", ")}`);
    assert.ok(rules.includes("S30-depends-order"), `expected S30 in ${rules.join(", ")}`);

    // Queue an unlinked level-1 notice sharing a tag with a level-3 approval; stage surfaces warning and --flush prepares page.
    writeFileSync(path.join(cwd, "notice.json"), JSON.stringify({
      kind: "notice", question: "Changed schema config", why_now: "Updated migration settings.",
      level: 1, level_reason: "Informational notice.", stakes: { reversibility: "easy" }, tags: ["schema"],
    }));
    assert.equal((await run(["ask", "notice.json", "--json"], "sess-notice")).code, 0);

    const goodBatch = {
      review: {
        intent: {
          task_title: "Migration stage",
          asked: "Run migration checks and approve rollout.",
          doing: "Staging the review batch.",
          scope_delta: "none",
          already_done: "Verified staging backup.",
          shared_glossary: { "Rollout window": "The scheduled maintenance window for schema changes." },
          shared_evidence: [{ claim: "Staging backup verified.", kind: "observed", source: "backup.log", date: "2026-11-25" }],
        },
        requests: [
          chooseCard("Which Rollout window should we use?", { id: "win", tags: ["schema"] }),
          approveCard("Approve the Rollout window migration?", {
            id: "mig",
            depends_on: ["win"],
            tags: ["schema"],
            evidence: [],
          }),
        ],
      },
    };
    writeFileSync(path.join(cwd, "good-batch.json"), JSON.stringify(goodBatch));
    const staged = await run(["stage", "good-batch.json", "--flush", "--json"], "sess-stage");
    assert.equal(staged.code, 0, staged.stderr + staged.stdout);
    const parsed = JSON.parse(staged.stdout);
    assert.equal(parsed.flushed, true);
    assert.ok(parsed.review_id);
    assert.ok((parsed.warnings as string[]).some((w) => w.includes("unlinked queued notice")),
      `expected notice overlap warning, got ${JSON.stringify(parsed.warnings)}`);
  } finally {
    await svc.close();
  }
});

test("Idea 1: shared brief satisfies batch lint, options render agent_next, one-tap clarity chips, and inbox metadata", async () => {
  const batch = {
    review: {
      intent: {
        task_title: "Shared brief check",
        asked: "Approve the rollout plan.",
        doing: "Presenting shared facts once.",
        scope_delta: "none",
        already_done: "Ran unit tests on the parser.",
        shared_glossary: { "Widgetizer": "The helper that formats export rows." },
        shared_evidence: [{ claim: "Parser tests passed on staging.", kind: "observed", source: "ci.log", date: "2026-11-25" }],
      },
      requests: [
        chooseCard("How should Widgetizer format empty cells?"),
        approveCard("Allow Widgetizer to migrate production tables?", { evidence: [] }),
      ],
    },
  };
  assert.deepEqual(checkDocument(batch), []);

  const data = mkdtempSync(path.join(tmpdir(), "utp-wf1-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cfg: ClientConfig = { server: svc.url, token: createToken(data, "dev") };
    const project = ((await call("project.create", { name: "Demo Project" }, { config: cfg })).project as ProjectInfo).id;
    const as = (op: string, args: Record<string, unknown> = {}) => call(op, args, { config: cfg, project });

    // Create and answer a prior decision to test cross-review depends_on resolution.
    const prior = await as("ask", { body: chooseCard("Which database engine?") });
    const priorFlush = await as("flush", { intent: { task_title: "Engine", asked: "Pick engine", doing: "Choosing", scope_delta: "none" } });
    await as("presented", { review: priorFlush.review_id, channel: "conversation" });
    await as("answer", { id: `${prior.id}@1`, value: "a", channel: "terminal-review" });

    const shared = { glossary: batch.review.intent.shared_glossary, evidence: batch.review.intent.shared_evidence };
    await as("ask", { body: { ...batch.review.requests[0]!, depends_on: [String(prior.id)], origin: { platform: "codex", agent: "Codex" } }, shared });
    await as("ask", { body: batch.review.requests[1]!, shared });
    const flushed = await as("flush", { intent: batch.review.intent });
    const shown = (await as("show", { id: flushed.review_id })).review as ReviewView;
    const md = reviewMarkdown(shown);
    assert.match(md, /\*\*Already done\*\*\s+Ran unit tests on the parser\./);
    assert.match(md, /\*\*Shared terms\*\*\s+Widgetizer: The helper that formats export rows\./);
    assert.match(md, /\*\*Shared evidence\*\*\s+Parser tests passed on staging\./);
    assert.match(md, /Agent does next: Write the first implementation\./);
    assert.match(md, /Depends on R-[^\s]+ · Which database engine\? — chose First option/);

    const prepared = await as("review-page.prepare", { review: flushed.review_id });
    const { html } = await openReviewPage(String(prepared.url));
    assert.match(html, /Agent does next:/);
    assert.match(html, /Already done/);
    assert.match(html, /type="radio" name="feedback-0" value="clear"/);
    assert.match(html, /type="radio" name="sureness-0" value="sure"/);
    assert.doesNotMatch(html, /<select/);

    // Inbox renders task_title, age, origin, stakes while keeping <h2> strictly project label.
    const pages = new ReviewPages(new URL("https://reviews.example.test"), svc.service, Date.now, true);
    const inbox = await renderInbox(svc.service, pages);
    const h2s = [...inbox.html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(h2s, ["Demo Project"]);
    assert.match(inbox.html, /Shared brief check/);
    assert.match(inbox.html, /Codex on dev/);
    assert.match(inbox.html, /1 approval · 1 reversible/);
  } finally {
    await svc.close();
  }
});

test("Idea 2: partial save, radio-overwrite guard, strict-clarify on approvals, skip_if, and pre-save preview", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-wf2-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cfg: ClientConfig = { server: svc.url, token: createToken(data, "dev") };
    const project = ((await call("project.create", { name: "Partial Project" }, { config: cfg })).project as ProjectInfo).id;
    const as = (op: string, args: Record<string, unknown> = {}) => call(op, args, { config: cfg, project });

    const c1 = await as("ask", { body: chooseCard("Pick caching strategy?", { id: "cache" }) });
    const c2 = await as("ask", { body: chooseCard("Configure cache lifetime?", {
      id: "lifetime",
      skip_if: [{ card: "cache", option: "b", reason: "No cache lifetime needed when caching is disabled." }],
    }) });
    const c3 = await as("ask", { body: approveCard("Approve production migration?") });
    const c4 = await as("ask", { body: chooseCard("Defer formatting tweak?") });
    assert.equal(c1.code, 0);
    assert.equal(c2.code, 0);
    assert.equal(c3.code, 0);
    assert.equal(c4.code, 0);
    const flushed = await as("flush", { intent: { task_title: "Partial batch", asked: "Decide caching and migration.", doing: "Gathering choices.", scope_delta: "none" } });
    const prepared = await as("review-page.prepare", { review: flushed.review_id });
    const page = await openReviewPage(String(prepared.url));

    // Conflict guard: selecting both a radio option and typing custom text on a non-authorized card returns 400.
    const conflict = await page.post({ "choice-0": "b", "custom-0": "Actually do something else" });
    assert.equal(conflict.status, 400);
    assert.match(await conflict.text(), /optional note box/);

    // Combined plan preview (preview=1) shows skip_if auto-skip, strict-clarify warning, hide, and left-open without saving.
    const previewRes = await page.post({
      preview: "1",
      "choice-0": "b",
      "note-0": "Keep logs verbose.",
      "choice-2": "yes",
      "custom-2": "Only migrate alpha after 5pm",
      "action-3": "hide",
    });
    assert.equal(previewRes.status, 200);
    const previewHtml = await previewRes.text();
    assert.match(previewHtml, /Combined plan check/);
    assert.match(previewHtml, /Auto-skipped \(No cache lifetime needed when caching is disabled\.\)/);
    assert.match(previewHtml, /Approval withheld pending clarification/);
    assert.match(previewHtml, /Hide until tomorrow/);
    assert.equal((await as("wait", { id: c1.id })).code, EXIT.WAITING);

    // Real save: card 1 answered + note, card 2 auto-skipped by skip_if, card 3 routed to needs_clarification (NO grant!), card 4 hidden.
    const saveRes = await page.post({
      "choice-0": "b",
      "note-0": "Keep logs verbose.",
      "choice-2": "yes",
      "custom-2": "Only migrate alpha after 5pm",
      "action-3": "hide",
    });
    assert.equal(saveRes.status, 200);
    const receipt = await saveRes.text();
    assert.match(receipt, /2 answers, 1 hidden, 1 held for clarification/);
    assert.match(receipt, /Keep logs verbose\./);

    const w1 = await as("wait", { id: c1.id });
    assert.equal(w1.code, EXIT.OK);
    assert.equal((w1.answer as { value: string; note?: string }).value, "b");
    assert.equal((w1.answer as { note?: string }).note, "Keep logs verbose.");

    const w2 = await as("wait", { id: c2.id });
    assert.equal(w2.code, EXIT.OK);
    assert.equal((w2.answer as { disposition?: string }).disposition, "no_longer_matters");

    const w3 = await as("wait", { id: c3.id });
    assert.equal(w3.code, EXIT.NEEDS_CLARIFICATION);
    assert.equal(w3.answer, null);
    assert.equal(w3.grant, undefined);
    assert.equal((w3.clarification as { outcome?: string; note?: string }).outcome, "needs_clarification");
    assert.equal((w3.clarification as { note?: string }).note, "Only migrate alpha after 5pm");

    const s4 = (await as("show", { id: c4.id })).request as RequestView;
    assert.equal(s4.status, "hidden");
  } finally {
    await svc.close();
  }
});

test("Idea 2 (terminal) & Idea 4: terminal strict-clarify and automatic revision diff banners across triggers", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-wf4-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cwd = repo();
    const home = mkdtempSync(path.join(tmpdir(), "utp-wf4-home-"));
    const run = (args: string[], input?: string) => utp(args, { cwd, home, input, env: { UTP_SESSION: "sess-4" } });
    assert.equal((await run(["connect", svc.url], createToken(data, "dev"))).code, 0);
    assert.equal((await run(["init"])).code, 0);

    const basisFile = path.join(cwd, "schema.sql");
    writeFileSync(basisFile, "create table alpha(id int);\n");

    const card1 = approveCard("Approve schema migration?", { basis: { files: ["schema.sql"] } });
    writeFileSync(path.join(cwd, "card1.json"), JSON.stringify(card1));
    const ask1 = JSON.parse((await run(["ask", "card1.json", "--json"])).stdout);
    const flush1 = JSON.parse((await run(["flush", "--json"])).stdout);

    // Terminal '/' reply on an approve card withholds grant and requests clarification.
    const termClarify = await run(["review", flush1.review_id], "/\nCan we limit this to table alpha after 5pm?\n");
    assert.equal(termClarify.code, 0, termClarify.stderr + termClarify.stdout);
    assert.match(termClarify.stdout, /withholds the grant/);
    assert.equal((await run(["wait", ask1.id, "--json"])).code, EXIT.NEEDS_CLARIFICATION);

    // Revise card with narrowed scope + updated option consequence -> automatic clarification diff banner.
    const card2: RequestBody = {
      ...card1,
      options: [
        {
          id: "yes", label: "Apply after-hours migration", consequence: "Updates tables alpha and beta after 5pm.",
          authorization: { action: "migrate", target: "production schema", scope: "tables alpha, beta after 5pm", expected_effect: "both tables migrated" },
        },
        card1.options![1]!,
        card1.options![2]!,
      ],
    };
    writeFileSync(path.join(cwd, "card2.json"), JSON.stringify(card2));
    assert.equal((await run(["revise", ask1.id, "card2.json", "--json"])).code, 0);
    const flush2 = JSON.parse((await run(["flush", "--json"])).stdout);

    const shown2 = JSON.parse((await run(["show", flush2.review_id, "--json"])).stdout).review as ReviewView;
    const rev2 = shown2.items[0]!;
    assert.equal(rev2.revision_diff?.from_revision, 1);
    assert.equal(rev2.revision_diff?.to_revision, 2);
    assert.equal(rev2.revision_diff?.trigger.kind, "clarification");
    assert.match(rev2.revision_diff?.trigger.note ?? "", /after 5pm/);
    assert.ok(rev2.revision_diff?.changes.some((c) => c.includes("Option yes authorization changed")));
    assert.match(reviewMarkdown(shown2), /Updated from rev 1 -> rev 2/);

    const page2 = await openReviewPage(String(flush2.url));
    assert.match(page2.html, /revision-banner/);
    assert.match(page2.html, /Triggered by your clarification on rev 1/);

    // Answer rev 2, mutate basis file so wait marks stale, revise to rev 3 -> stale banner + read-only prior pick (NOT pre-selected).
    assert.equal((await page2.post({ "choice-0": "narrow" })).status, 200);
    writeFileSync(basisFile, "create table alpha(id int, name text);\n");
    const staleWait = await run(["wait", `${ask1.id}@2`, "--json"]);
    assert.equal(staleWait.code, EXIT.STALE);

    writeFileSync(path.join(cwd, "card3.json"), JSON.stringify({ ...card2, why_now: "Re-confirming after schema.sql added the name column." }));
    assert.equal((await run(["revise", ask1.id, "card3.json", "--json"])).code, 0);
    const flush3 = JSON.parse((await run(["flush", "--json"])).stdout);
    const page3 = await openReviewPage(String(flush3.url));
    assert.match(page3.html, /Rev 2 went stale/);
    assert.match(page3.html, /schema\.sql/);
    assert.match(page3.html, /Previous pick on rev 2/);
    assert.match(page3.html, /not pre-selected/);
    assert.doesNotMatch(page3.html, /name="choice-0"[^>]*checked/);

    // Unit-check computeRevisionDiff directly for added/removed options.
    const diff = computeRevisionDiff(
      { revision: 1, status: "presented", body: chooseCard("Pick one?") },
      {
        revision: 2,
        status: "presented",
        body: {
          ...chooseCard("Pick one?"),
          options: [
            { id: "a", label: "First option", consequence: "Uses the first approach." },
            { id: "c", label: "Third option", consequence: "New path." },
          ],
        },
      },
    );
    assert.ok(diff.changes.some((c) => c.includes("Added option Third option (c)")));
    assert.ok(diff.changes.some((c) => c.includes("Removed option Second option (b)")));
  } finally {
    await svc.close();
  }
});

test("Idea 6: actionable browser Keep/Switch on applied defaults, level-1 notice reversal disclosure, and enriched digest", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-wf6-data-"));
  const inboxDir = mkdtempSync(path.join(tmpdir(), "utp-wf6-inbox-"));
  const svc = await startServer({ dataDir: data, port: 0, inboxDir });
  try {
    const cfg: ClientConfig = { server: svc.url, token: createToken(data, "dev") };
    const project = ((await call("project.create", { name: "Catalog App" }, { config: cfg })).project as ProjectInfo).id;
    const as = (op: string, args: Record<string, unknown> = {}) => call(op, args, { config: cfg, project });

    // Apply two eligible level-2 defaults so we can test both Switch and Keep buttons.
    const mkDef = (q: string): RequestBody => ({
      kind: "choose",
      category: "approach",
      question: q,
      why_now: "Local formatting setting with easy undo.",
      options: [
        {
          id: "a", label: "Sort ascending", consequence: "Sorts entries A-Z.",
          authorization: { action: "format", target: "index.json", scope: "sort order", expected_effect: "sorted ascending" },
        },
        {
          id: "b", label: "Sort by date", consequence: "Sorts newest first.",
          authorization: { action: "format", target: "index.json", scope: "sort order", expected_effect: "sorted by date" },
        },
      ],
      default: {
        option: "a", consequence: "Sorts ascending.",
        eligibility: { local: true, scope_delta: "none", undo: "Switch sort key in config.", authority: "local repo", size: "small" },
      },
      stakes: { reversibility: "easy" },
      level: 2,
      level_reason: "Local reversible choice.",
    });
    const d1 = await as("ask", { body: mkDef("Default sort order for entries?") });
    const d2 = await as("ask", { body: mkDef("Default sort order for tags?") });
    const f1 = await as("flush", { intent: { task_title: "Sorting", asked: "Sort files", doing: "Applying defaults", scope_delta: "none" } });
    await as("presented", { review: f1.review_id, channel: "conversation" });
    for (const d of [d1, d2]) {
      const claim = await as("claim-default", { id: d.id });
      assert.equal(claim.code, EXIT.DEFAULT_CLAIMED);
      const grantId = (claim.grant as { id: string }).id;
      assert.equal((await as("begin", { grant: grantId })).code, EXIT.OK);
      assert.equal((await as("applied", {
        grant: grantId,
        evidence: { action: "format", target: "index.json", scope: "sort order", effect: "sorted ascending" },
      })).code, EXIT.OK);
    }

    // Queue a level-1 decide notice (reversible), an ordinary ask notice (NOT reversible), and a question to open a browser page.
    const decideNotice = await as("decide", {
      level: 1,
      body: {
        kind: "notice", question: "Switched lint rule to strict", why_now: "Catches unused variables.",
        level: 1, level_reason: "Reversible policy notice.", stakes: { reversibility: "easy" }, tags: ["lint-rule"],
      },
    });
    await as("ask", {
      body: {
        kind: "notice", question: "Build finished cleanly", why_now: "Plain informational note.",
        level: 1, level_reason: "Informational only.", stakes: { reversibility: "easy" },
      },
    });
    await as("ask", { body: chooseCard("Follow-up question?") });
    const f2 = await as("flush", { intent: { task_title: "Follow-up", asked: "Check defaults", doing: "Reviewing", scope_delta: "none" } });
    const p2 = await as("review-page.prepare", { review: f2.review_id });
    const page = await openReviewPage(String(p2.url));

    // Applied defaults render Keep & Switch buttons with undo text.
    assert.match(page.html, /Applied by default: change\?/);
    assert.match(page.html, /One-step undo: Switch sort key in config\./);
    assert.match(page.html, new RegExp(`value="keep:${d1.id}@1:a"`));
    assert.match(page.html, new RegExp(`value="switch:${d1.id}@1:b"`));

    // Only the level-1 decide notice (index 0) renders the reversal disclosure; the plain ask notice (index 1) does not.
    assert.match(page.html, /name="reverse-notice" value="0"/);
    assert.doesNotMatch(page.html, /name="reverse-notice" value="1"/);

    // Out-of-review default-action target is refused with 403.
    const bogusDefault = await page.post({ "default-action": "switch:R-20261125-deadbeef@1:b" });
    assert.equal(bogusDefault.status, 403);

    // Click Switch on d1 -> flags late_conflict; click Keep on d2 -> stays applied.
    const sw = await page.post({ "default-action": `switch:${d1.id}@1:b` });
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /flagged as a late conflict/);
    assert.equal(((await as("show", { id: d1.id })).request as RequestView).status, "late_conflict");

    const kp = await page.post({ "default-action": `keep:${d2.id}@1:a` });
    assert.equal(kp.status, 200);
    assert.match(await kp.text(), /Confirmed applied default/);
    assert.equal(((await as("show", { id: d2.id })).request as RequestView).status, "applied");

    // Click Flag for reversal on the level-1 decide notice -> appears in log reversals.
    const revRes = await page.post({ "reverse-notice": "0", "reverse-reason-0": "Strict mode breaks generated stubs." });
    assert.equal(revRes.status, 200);
    assert.match(await revRes.text(), /Flagged notice/);
    const logged = (await as("log", { tags: ["lint-rule"] })).entries as { id: string; reversals: { reason: string }[] }[];
    const match = logged.find((e) => e.id === decideNotice.id);
    assert.ok(match && match.reversals[0]?.reason === "Strict mode breaks generated stubs.");

    // Notice-only flush writes enriched morning report digest with project name, task title, and notice ID.
    const n3 = await as("decide", {
      level: 1,
      body: {
        kind: "notice", question: "Enabled strict exports", why_now: "Keeps public types tidy.",
        level: 1, level_reason: "Reversible update.", stakes: { reversibility: "easy" }, tags: ["exports"],
      },
    });
    await as("flush", { intent: { task_title: "Export cleanup", asked: "Clean exports", doing: "Applying", scope_delta: "none" } });
    const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    const digest = JSON.parse(readFileSync(path.join(inboxDir, files[0]!), "utf8"));
    assert.match(digest.title, /UTP notices · Catalog App: Export cleanup/);
    assert.ok(String(digest.body_md).includes(String(n3.id)));
    assert.match(String(digest.body_md), /utp reverse/);
  } finally {
    await svc.close();
  }
});

test("Idea 3: live pickup status, Recent & In Flight inbox with pre-begin edit/withdraw lock, review --recent, and utp resume", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-wf3-data-"));
  const svc = await startServer({ dataDir: data, port: 0, maxWaitMs: 5_000, recheckMs: 50 });
  try {
    const cwd = repo();
    const home = mkdtempSync(path.join(tmpdir(), "utp-wf3-home-"));
    const run = (args: string[], session = "sess-3", input?: string) =>
      utp(args, { cwd, home, input, env: { UTP_SESSION: session } });
    assert.equal((await run(["connect", svc.url], "sess-3", createToken(data, "dev"))).code, 0);
    assert.equal((await run(["init", "--name", "Carry App"])).code, 0);

    const basisFile = path.join(cwd, "plan.txt");
    writeFileSync(basisFile, "v1\n");

    const batch = {
      review: {
        intent: { task_title: "Carry-through batch", asked: "Approve and plan rollout.", doing: "Testing carry-through.", scope_delta: "none" },
        requests: [
          approveCard("Approve rollout step?", { id: "rollout", basis: { files: ["plan.txt"] }, origin: { platform: "codex", agent: "Codex" } }),
          chooseCard("Choose log format?", { id: "logs", depends_on: ["rollout"], origin: { platform: "codex", agent: "Codex" } }),
        ],
      },
    };
    writeFileSync(path.join(cwd, "batch.json"), JSON.stringify(batch));
    const staged = JSON.parse((await run(["stage", "batch.json", "--flush", "--json"])).stdout);
    const reviewId = String(staged.review_id);
    const shown = JSON.parse((await run(["show", reviewId, "--json"])).stdout).review as ReviewView;
    const card1Id = shown.items[0]!.id;
    const card2Id = shown.items[1]!.id;

    // Open review page and start a live HTTP waiter on card 1 to test live pickup status!
    const page = await openReviewPage(String(staged.url));
    const token = createToken(data, "waiter-host");
    const projectId = svc.service.projects()[0]!.id;
    const waiterPromise = fetch(`${svc.url}/v1/op`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "wait", project: projectId, session: "sess-3", args: { id: card1Id, timeout_s: 4 } }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    await new Promise((r) => setTimeout(r, 100));
    const saveRes = await page.post({ "choice-0": "yes", "choice-1": "a" });
    assert.equal(saveRes.status, 200);
    const savedText = await saveRes.text();
    assert.match(savedText, /Agent is listening now:/);
    assert.match(savedText, /sess-3 on waiter-host/);
    const waiterOut = await waiterPromise;
    assert.equal(waiterOut.code, EXIT.OK);
    // Issue grant from the actual owner session (sess-3 on dev) via CLI wait.
    const ownerWait = await run(["wait", card1Id, "--json"], "sess-3");
    assert.equal(ownerWait.code, EXIT.OK, ownerWait.stderr + ownerWait.stdout);
    const grant1 = JSON.parse(ownerWait.stdout).grant.id as string;

    // Test inbox Recent & In Flight (no <h2> inside recent section!) and pre-begin edit/withdraw window.
    const pages = new ReviewPages(new URL("https://reviews.example.test"), svc.service, Date.now, true);
    const inbox1 = await renderInbox(svc.service, pages);
    assert.match(inbox1.html, /No questions are waiting\./);
    assert.match(inbox1.html, /Recent &amp; In Flight/);
    assert.match(inbox1.html, /Carry App — Carry-through batch/);
    assert.match(inbox1.html, /Edit or withdraw \(before work begins\)/);
    assert.deepEqual([...inbox1.html.matchAll(/<h2>([^<]*)<\/h2>/g)], []);

    // Open edit page via POST /edit/<project>/<review>.
    const editRedirect = await renderInbox(svc.service, pages, `/edit/${projectId}/${reviewId}`, "POST",
      { origin: "https://reviews.example.test" });
    assert.equal(editRedirect.status, 303);
    const editPath = editRedirect.headers.location!;
    assert.match(editPath, /^\/review\//);

    // GET edit page -> capture cookie + token.
    const editGet = await renderInbox(svc.service, pages, editPath, "GET");
    assert.equal(editGet.status, 200);
    const editCookie = editGet.headers["set-cookie"]?.split(";")[0] ?? "";
    const editToken = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(editGet.html)?.[1] ?? "";
    assert.ok(editCookie && editToken);

    // Before begin: edit card 1 from "yes" to "narrow" (keyed by pinned id@rev) -> revokes old grant and updates answer!
    const editSave = await renderInbox(svc.service, pages, editPath, "POST",
      { origin: "https://reviews.example.test", cookie: editCookie, "content-type": "application/x-www-form-urlencoded" },
      undefined,
      new URLSearchParams({ presentation: editToken, "edit-save": `${card1Id}@1`, "choice-0": "narrow" }).toString());
    assert.equal(editSave.status, 200);
    assert.match(editSave.html, /Updated answer/);
    // Old grant is now revoked!
    assert.equal((await run(["begin", grant1, "--json"])).code, EXIT.REVOKED);

    // Withdraw card 2 before begin (keyed by pinned id@rev) -> card 2 returns to waiting inbox!
    const editWithdraw = await renderInbox(svc.service, pages, editPath, "POST",
      { origin: "https://reviews.example.test", cookie: editCookie, "content-type": "application/x-www-form-urlencoded" },
      undefined,
      new URLSearchParams({ presentation: editToken, "edit-withdraw": `${card2Id}@1` }).toString());
    assert.equal(editWithdraw.status, 200);
    assert.match(editWithdraw.html, /Withdrew answer/);
    const inboxAfterWithdraw = await renderInbox(svc.service, pages);
    assert.match(inboxAfterWithdraw.html, /Choose log format\?/);

    // Re-answer card 2 via terminal review, then test utp review --recent editing card 2 from "a" to "b".
    assert.equal((await run(["review", reviewId], "sess-3", "a\n")).code, 0);
    const recentCli = await run(["review", "--recent"], "sess-3", "2\nb\n\n");
    assert.equal(recentCli.code, 0, recentCli.stderr + recentCli.stdout);
    assert.match(recentCli.stdout, new RegExp(`Updated ${card2Id}@1 to b`));

    // Now wait -> begin -> applied on card 1 (narrow scope), then confirm edit page AND server edit op LOCK card 1!
    const wait2 = JSON.parse((await run(["wait", card1Id, "--json"])).stdout);
    assert.equal(wait2.code, EXIT.OK);
    const grant2 = wait2.grant.id as string;
    assert.equal((await run(["begin", grant2, "--json"])).code, EXIT.OK);

    const lockedEdit = await renderInbox(svc.service, pages, editPath, "POST",
      { origin: "https://reviews.example.test", cookie: editCookie, "content-type": "application/x-www-form-urlencoded" },
      undefined,
      new URLSearchParams({ presentation: editToken, "edit-save": `${card1Id}@1`, "choice-0": "yes" }).toString());
    assert.equal(lockedEdit.status, 409);
    assert.match(lockedEdit.html, /answers lock once execution begins/);

    const lockedRpc = await call("edit", { id: `${card1Id}@1`, channel: "terminal-review", withdraw: true },
      { config: { server: svc.url, token }, project: projectId });
    assert.equal(lockedRpc.code, EXIT.NOT_ALLOWED);

    writeFileSync(path.join(cwd, "ev.json"), JSON.stringify({
      action: "migrate", target: "production schema", scope: "tables alpha", effect: "Migrated table alpha cleanly.",
    }));
    assert.equal((await run(["applied", grant2, "--evidence", "ev.json", "--json"])).code, EXIT.OK);

    const inboxApplied = await renderInbox(svc.service, pages);
    assert.match(inboxApplied.html, /Applied: Migrated table alpha cleanly\./);

    // Revising card 2 invalidates the old edit link with 409 (preventing cross-card misbinding).
    writeFileSync(path.join(cwd, "rev-logs.json"), JSON.stringify(chooseCard("Choose updated log format?")));
    assert.equal((await run(["revise", card2Id, "rev-logs.json", "--json"], "sess-3")).code, EXIT.OK);
    const staleEditPost = await renderInbox(svc.service, pages, editPath, "POST",
      { origin: "https://reviews.example.test", cookie: editCookie, "content-type": "application/x-www-form-urlencoded" },
      undefined,
      new URLSearchParams({ presentation: editToken, "edit-withdraw": `${card2Id}@1` }).toString());
    assert.equal(staleEditPost.status, 409);
    assert.match(staleEditPost.html, /Review changed/);

    // Test single-call utp resume from a new session (applied card stays next_action="done" even after basis file changes!).
    writeFileSync(basisFile, "v2-changed\n");
    const resumed = await run(["resume", reviewId, "--json"], "sess-new");
    assert.equal(resumed.code, EXIT.OK, resumed.stderr + resumed.stdout);
    const packets = JSON.parse(resumed.stdout).cards as ResumeCardPacket[];
    assert.equal(packets.length, 1);
    assert.equal(packets[0]!.id, card1Id);
    assert.deepEqual(packets[0]!.stale_files, ["plan.txt"]);
    assert.equal(packets[0]!.status, "applied");
    assert.equal(packets[0]!.next_action, "done");

    // Also verify utp resume across the project returns the revised card 2 with needs_takeover.
    const resumedAll = await run(["resume", "--json"], "sess-new");
    assert.equal(resumedAll.code, EXIT.OK);
    const allPackets = JSON.parse(resumedAll.stdout).cards as ResumeCardPacket[];
    const revCard2 = allPackets.find((p) => p.id === card2Id && p.revision === 2);
    assert.ok(revCard2);
    assert.equal(revCard2.needs_takeover, true);
  } finally {
    await svc.close();
  }
});
