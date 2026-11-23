// End to end: real utp processes against an in-process service, in
// throwaway Git checkouts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server/http.js";
import { createToken } from "../src/server/tokens.js";
import type { RequestBody } from "../src/core/types.js";

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

function repo(remote?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "utp-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

test("a terminal reviewer sees what the question decides and can ask for an explanation", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-clarity-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-clarity-home-")) };
    const run = async (args: string[], input?: string) => {
      const result = await utp(args, { ...o, input });
      assert.equal(result.code, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    await run(["connect", svc.url], createToken(data, "reviewer"));
    await run(["init"]);
    await run(["new", "choose", "--file", "card.json"]);
    const file = path.join(o.cwd, "card.json");
    const card = JSON.parse(readFileSync(file, "utf8"));
    card.summary = "This decides which rows the import will keep.";
    writeFileSync(file, JSON.stringify(card));
    const { id, review_id } = JSON.parse(await run(["ask", "card.json", "--json"]));
    await run(["flush", "--json"]);
    const review = await run(["review", review_id], "?\nExplain how choice A changes the output.\n");
    assert.match(review, /This decides which rows the import will keep/);
    assert.match(review, /What should the agent explain/);
    assert.match(review, /Clarification requested/);
    const waiting = await utp(["wait", id, "--json"], o);
    assert.equal(waiting.code, 21);
    const pending = JSON.parse(waiting.stdout);
    assert.equal(pending.answer, null);
    assert.equal(pending.clarification.note, "Explain how choice A changes the output.");
    await run(["revise", id, "card.json"]);
    const revised = JSON.parse(await run(["show", id, "--json"])).request;
    assert.equal(revised.revision, 2);
    assert.equal(revised.clarification, undefined);
  } finally {
    await svc.close();
  }
});

test("utp setup previews only the selected session's sandbox settings", async () => {
  const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-setup-home-")) };
  writeFileSync(path.join(o.home, "config.json"), JSON.stringify({ server: "https://utp.example.test:7340", token: "synthetic" }));
  const before = readdirSync(o.cwd);
  const plan = async (platform: string) => {
    const result = await utp(["setup", platform, "--json"], o);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual((await plan("codex")).args, ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]);
  const claudeSettings = JSON.parse((await plan("claude")).args[1]);
  assert.deepEqual(claudeSettings.sandbox.network.allowedDomains, ["utp.example.test:7340"]);
  assert.equal(claudeSettings.sandbox.failIfUnavailable, true);
  const agy = await plan("antigravity");
  assert.equal(agy.program, "agy");
  const allow = JSON.parse(agy.args[2]).permissions.allow;
  assert.equal(allow[0], "read_url(utp.example.test)");
  assert.ok(allow.includes(`read_file(${process.execPath})`));
  assert.ok(allow.includes(`read_file(${path.join(o.home, "config.json")})`));
  assert.deepEqual(readdirSync(o.cwd), before);
  if (process.platform === "win32") {
    const nativeClaude = await utp(["setup", "claude", "--apply"], o);
    assert.equal(nativeClaude.code, 1);
    assert.match(nativeClaude.stderr, /inside WSL2/);
  }
});

test("utp uses the sandbox HTTP proxy for the decision service", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-proxy-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  const remote = new URL(svc.url);
  const proxy = createServer();
  let connections = 0;
  proxy.on("connect", (request, client, head) => {
    if (request.url !== `utp.example.test:${remote.port}`) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const server = connect(Number(remote.port), remote.hostname, () => {
      connections++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      server.write(head);
      client.pipe(server);
      server.pipe(client);
    });
    client.on("error", () => server.destroy());
    server.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    const o = {
      cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-proxy-home-")),
      env: { http_proxy: proxyUrl, no_proxy: "" }, input: createToken(data, "synthetic-proxied-client"),
    };
    const result = await utp(["connect", `http://utp.example.test:${remote.port}`], o);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(connections, 1);
  } finally {
    await svc.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("utp connect honors the service path on a private HTTPS proxy", async () => {
  const seen: string[] = [];
  const ingress = createServer((req, res) => {
    seen.push(req.url ?? "");
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 0, machine: "synthetic-laptop" }));
  });
  await new Promise<void>((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const port = (ingress.address() as AddressInfo).port;
  try {
    const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-base-url-")), input: "synthetic" };
    for (const suffix of ["/utp", "/utp/"]) {
      const result = await utp(["connect", `http://127.0.0.1:${port}${suffix}`], o);
      assert.equal(result.code, 0, result.stderr + result.stdout);
    }
    assert.deepEqual(seen, ["/utp/v1/op", "/utp/v1/op"]);
  } finally {
    ingress.closeAllConnections();
    await new Promise<void>((resolve) => ingress.close(() => resolve()));
  }
});

test("the report machine can import a remote notice once", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-report-data-"));
  const svc = await startServer({ dataDir: data, port: 0, reportExport: true });
  try {
    const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-report-home-")) };
    const run = async (args: string[], input?: string) => {
      const result = await utp(args, { ...o, input });
      assert.equal(result.code, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    await run(["connect", svc.url], createToken(data, "report-machine"));
    await run(["init"]);
    await run(["new", "notice", "--file", "notice.json"]);
    await run(["ask", "notice.json"]);
    assert.match(await run(["flush"]), /queued for the morning report/);
    const inbox = path.join(o.cwd, "inbox");
    assert.match(await run(["report-import", "--inbox", inbox]), /items imported: 1/);
    assert.match(await run(["report-import", "--inbox", inbox]), /items imported: 0/);
    assert.equal(readdirSync(inbox).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await svc.close();
  }
});

test("a choose request runs end to end through the utp command and the terminal review", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
    const cwd = repo("https://example.com/team/app.git");
    const o = { cwd, home };
    const connected = await utp(["connect", svc.url], { ...o, input: createToken(data, "laptop") });
    assert.equal(connected.code, 0, connected.stderr);
    const init = await utp(["init", "--json"], o);
    assert.equal(init.code, 0, init.stderr);
    const project = JSON.parse(init.stdout).project as string;
    assert.match((await utp(["init"], o)).stdout, /already registered/);

    assert.equal((await utp(["new", "choose", "--file", "req.json"], o)).code, 0);
    const req = JSON.parse(readFileSync(path.join(cwd, "req.json"), "utf8")) as Record<string, unknown>;
    Object.assign(req, { question: "Which parser should the import use?", why_now: "The import step needs one." });
    writeFileSync(path.join(cwd, "req.json"), JSON.stringify(req));
    assert.equal((await utp(["check", "req.json"], o)).code, 0);

    const asked = await utp(["ask", "req.json", "--json"], o);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    const id = (JSON.parse(asked.stdout) as { id: string }).id;
    assert.equal((await utp(["wait", id], o)).code, 10);

    const flushed = await utp(["flush"], o);
    assert.equal(flushed.code, 0);
    assert.match(flushed.stdout, /### A\. Which parser should the import use\?/);
    const review = /utp presented (V-\S+) --channel conversation/.exec(flushed.stdout)?.[1];
    assert.ok(review, flushed.stdout);
    assert.equal((await utp(["presented", review], o)).code, 0);

    const person = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-review-person-")),
      env: { UTP_SESSION: "separate-review-terminal" } };
    assert.equal((await utp(["connect", svc.url], { ...person, input: createToken(data, "reviewer") })).code, 0);
    assert.equal((await utp(["link", project], person)).code, 0);
    const answered = await utp(["review", "--feedback"], { ...person, input: "zzz\nb\nsure\nclear\n" });
    assert.equal(answered.code, 0, answered.stderr);
    assert.match(answered.stdout, /zzz isn't one of this card's options/);
    assert.match(answered.stdout, /How sure are you/);
    assert.match(answered.stdout, /Saved 1 answer/);

    const waited = await utp(["wait", id, "--json"], o);
    assert.equal(waited.code, 0);
    const answer = JSON.parse(waited.stdout).answer;
    assert.deepEqual([answer.value, answer.channel, answer.verified, answer.machine], ["b", "terminal-piped", "none", "reviewer"]);
    assert.equal(answer.sureness, "sure");
    assert.equal(answer.feedback, "clear");
    assert.ok(!("active_response_ms" in answer));
    assert.match((await utp(["show", id], o)).stdout, /Answered: b \(through terminal-piped, unverified\)/);
  } finally {
    await svc.close();
  }
});

test("an approval answered without proof is refused a grant, and a basis file changed before begin blocks the effect", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
    const cwd = repo();
    const o = { cwd, home };
    await utp(["connect", svc.url], { ...o, input: createToken(data, "laptop") });
    assert.equal((await utp(["init"], o)).code, 0);
    mkdirSync(path.join(cwd, "exports"));
    writeFileSync(path.join(cwd, "exports", "list.txt"), "ten files\n");
    writeFileSync(path.join(cwd, "approve.json"), JSON.stringify({
      kind: "approve", question: "Delete the ten old exports?", why_now: "They block the release build.",
      narrowing_reason: "The release consumes the export set together.",
      evidence: [{ claim: "The list contains ten exports.", kind: "observed", source: "Export list", date: "2026-11-22" }],
      options: [
        { id: "yes", label: "Delete them", consequence: "The ten files are gone for good.",
          authorization: { action: "delete", target: "exports/", scope: "the ten listed files" } },
        { id: "no", label: "Keep them", consequence: "The release build stays blocked." },
      ],
      stakes: { reversibility: "one_way" }, level: 3, level_reason: "Deleting can't be undone.",
      basis: { files: ["exports/list.txt"] },
    }));
    const id = (JSON.parse((await utp(["ask", "approve.json", "--json"], o)).stdout) as { id: string }).id;
    const review = (JSON.parse((await utp(["flush", "--json"], o)).stdout) as { review_id: string }).review_id;
    await utp(["presented", review], o);
    await utp(["review"], { ...o, input: "yes\n" });
    const refused = await utp(["wait", id], o);
    assert.equal(refused.code, 18, refused.stdout);
    assert.match(refused.stdout, /utp review/);

    writeFileSync(path.join(cwd, "regen.json"), JSON.stringify({
      kind: "choose", category: "approach", question: "Regenerate the fixtures from the export list?", why_now: "The tests read them next.",
      options: [
        { id: "go", label: "Regenerate", consequence: "Every fixture is rebuilt from the list.",
          authorization: { action: "regenerate", target: "fixtures/", scope: "all fixtures" } },
        { id: "keep", label: "Keep them", consequence: "The tests run on the old fixtures." },
      ],
      stakes: { reversibility: "easy" }, level: 2, level_reason: "Fixtures are regenerated in seconds.",
      basis: { files: ["exports/list.txt"] },
    }));
    const regen = (JSON.parse((await utp(["ask", "regen.json", "--json"], o)).stdout) as { id: string }).id;
    const second = (JSON.parse((await utp(["flush", "--json"], o)).stdout) as { review_id: string }).review_id;
    await utp(["presented", second], o);
    await utp(["review"], { ...o, input: "go\n" });
    const waited = await utp(["wait", regen, "--json"], o);
    assert.equal(waited.code, 0, waited.stdout);
    const grant = (JSON.parse(waited.stdout) as { grant: { id: string } }).grant.id;
    writeFileSync(path.join(cwd, "exports", "list.txt"), "eleven files now\n");
    const stale = await utp(["begin", grant], o);
    assert.equal(stale.code, 11, stale.stdout);
    assert.match(stale.stdout, /exports\/list\.txt/);
  } finally {
    await svc.close();
  }
});

test("a second clone with the same remote is pointed at the existing project and links to it", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
    const first = repo("git@example.com:team/app.git");
    const second = repo("https://example.com/team/app");
    await utp(["connect", svc.url], { cwd: first, home, input: createToken(data, "laptop") });
    const created = JSON.parse((await utp(["init", "--json"], { cwd: first, home })).stdout) as { project: string };
    const pointed = await utp(["init"], { cwd: second, home });
    assert.equal(pointed.code, 19);
    assert.match(pointed.stdout, new RegExp(`utp link`));
    assert.match(pointed.stdout, new RegExp(created.project));
    assert.equal((await utp(["link", created.project], { cwd: second, home })).code, 0);
    assert.equal((await utp(["status"], { cwd: second, home })).code, 0);
    assert.equal((await utp(["status"], { cwd: tmpdir(), home })).code, 40, "outside any checkout");
  } finally {
    await svc.close();
  }
});

test("relink keeps a searchable, read-only snapshot with the original project after restart", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  let svc = await startServer({ dataDir: data, port: 0 });
  const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
  const source = { cwd: repo(), home };
  const destination = { cwd: repo(), home };
  const token = createToken(data, "laptop");
  const run = async (args: string[], opts: Parameters<typeof utp>[1] = source) => {
    const result = await utp(args, opts);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const json = async (args: string[], opts = source) => JSON.parse(await run([...args, "--json"], opts));
  try {
    await run(["connect", svc.url], { ...source, input: token });
    const { project: from } = await json(["init"]);
    const { project: to } = await json(["init"], destination);
    const requestPath = path.join(source.cwd, "request.json");
    await run(["new", "choose", "--file", requestPath]);
    const body = JSON.parse(readFileSync(requestPath, "utf8"));
    writeFileSync(requestPath, JSON.stringify({
      ...body, question: "Choose an import parser", notes: "Archived search term", related: ["earlier-choice"],
    }));
    const { id, review_id: review } = await json(["ask", requestPath]);
    await run(["flush"]);
    await run(["presented", review]);
    await run(["answer", id, "--option", "b"]);
    const reasonPath = path.join(source.cwd, "reason.json");
    writeFileSync(reasonPath, JSON.stringify({ reason: "A later check found missing rows", tags: ["import"] }));
    await run(["reverse", id, "--file", reasonPath]);

    await run(["link", to, "--op-id", "relink-source"], source);
    const args = ["log", "--tags", "import", "--kind", "choose", "--related", "earlier-choice", "--text", "archived search term"];
    const { entries } = await json(args);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].answer, "b");
    assert.equal(entries[0].origin_project, from);
    assert.equal(entries[0].archived, true);
    assert.equal(entries[0].reversals[0].reason, "A later check found missing rows");
    assert.match(await run(args), new RegExp(`archived from ${from}`));
    assert.equal((await utp(["answer", id, "--option", "a"], source)).code, 40);
    assert.equal((await utp(["wait", id], source)).code, 40);
    writeFileSync(reasonPath, JSON.stringify({ reason: "A newer source-only reversal" }));
    await run(["reverse", id, "--file", reasonPath], { ...source, env: { UTP_PROJECT: from } });

    await svc.close();
    svc = await startServer({ dataDir: data, port: 0 });
    await run(["connect", svc.url], { ...source, input: token });
    assert.deepEqual((await json(args)).entries, entries);

    const { project: next } = await json(["init"], { cwd: repo(), home });
    await run(["link", next]);
    assert.deepEqual((await json(args)).entries, entries);
  } finally {
    await svc.close();
  }
});

test("every command fails with exit code 32 when the service is down", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
  const cwd = repo();
  await utp(["connect", svc.url], { cwd, home, input: createToken(data, "laptop") });
  await utp(["init"], { cwd, home });
  await svc.close();
  const r = await utp(["status"], { cwd, home });
  assert.equal(r.code, 32);
  assert.match(r.stderr, /can't reach the UTP service/);
});

test("the CLI reports an applied default and redoes an authorized late choice", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  const home = mkdtempSync(path.join(tmpdir(), "utp-home-"));
  const cwd = repo();
  const run = async (args: string[], code = 0) => {
    const result = await utp(args, { cwd, home });
    assert.equal(result.code, code, result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    const connected = await utp(["connect", svc.url], { cwd, home, input: createToken(data, "laptop") });
    assert.equal(connected.code, 0, connected.stdout + connected.stderr);
    await run(["init"]);
    const fixture = path.join(cwd, "fixture.json");
    writeFileSync(fixture, "initial");
    const authorization = { action: "write", target: "fixture.json", scope: "one fixture" };
    const request = {
      kind: "choose", category: "approach", question: "Which fixture mode should we use?", why_now: "The test needs a mode.",
      options: [
        { id: "a", label: "Strict", consequence: "Use strict parsing.", authorization },
        { id: "b", label: "Lenient", consequence: "Skip bad rows.", authorization },
      ],
      default: { option: "a", consequence: "Use strict parsing for now.", eligibility: {
        local: true, scope_delta: "none", undo: "Replace the fixture in one edit.",
        authority: "The person asked for a fixture update.", size: "small",
      } },
      basis: { files: ["fixture.json"] }, stakes: { reversibility: "easy" }, level: 2, level_reason: "One edit reverses the change.",
    };
    const card = path.join(cwd, "request.json");
    writeFileSync(card, JSON.stringify(request));
    const { id, review_id: review } = JSON.parse(await run(["ask", card, "--json"]));
    await run(["flush"]);
    await run(["presented", review]);
    const { grant } = JSON.parse(await run(["claim-default", id, "--json"], 15));
    await run(["begin", grant.id]);
    writeFileSync(fixture, "strict");
    const evidence = path.join(cwd, "evidence.json");
    writeFileSync(evidence, JSON.stringify({ ...authorization, effect: "Fixture written." }));
    await run(["applied", grant.id, "--evidence", evidence]);

    writeFileSync(card, JSON.stringify({ ...request, question: "Should we also test CSV fixtures?",
      glossary: { CSV: "Comma-separated values" } }));
    await run(["ask", card]);
    assert.match(await run(["flush"]), /Applied by default: change\?/);
    await run(["answer", id, "--option", "b"]);
    await run(["wait", id], 14);
    const { grant: redo } = JSON.parse(await run(["resolve-late", id, "--resolution", "redo", "--json"]));
    await run(["begin", redo.id]);
    writeFileSync(fixture, "lenient");
    await run(["applied", redo.id, "--evidence", evidence]);
    assert.equal(readFileSync(fixture, "utf8"), "lenient");
  } finally {
    await svc.close();
  }
});

test("export removes private details and checks public files before publication", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-home-")) };
  try {
    await utp(["connect", svc.url], { ...o, input: createToken(data, "test-fixture") });
    assert.equal((await utp(["init"], o)).code, 0);
    writeFileSync(path.join(o.home, "deny-list.json"), JSON.stringify(["Private fixture name"]));
    const card = path.join(o.cwd, "request.json");
    const publicPath = path.join(o.cwd, "review.export.json");
    const fakeToken = `utp_${"x".repeat(24)}`;
    const privateDetails = `private fixture name alex@example.test 192.0.2.42 2001:db8::5 C:\\Users\\Example\\fixture.txt /home/example/fixture.txt ${fakeToken}`;
    writeFileSync(card, JSON.stringify({
      kind: "choose", category: "approach", question: `Select the parser for ${privateDetails}?`, why_now: "The fixture needs a parser.",
      options: [
        { id: "a", label: "Strict", consequence: "Reject bad rows." },
        { id: "b", label: "Lenient", consequence: "Skip bad rows." },
      ],
      notes: "This internal note is omitted.",
      stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to undo.",
    }));
    const asked = await utp(["ask", card, "--json"], o);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    const { id, review_id: review } = JSON.parse(asked.stdout);
    await utp(["flush"], o);
    await utp(["presented", review], o);
    await utp(["answer", id, "--option", "a"], o);
    assert.equal((await utp(["export", id, "--file", publicPath], o)).code, 1);
    const exported = await utp(["export", id, "--redact", "--file", publicPath], o);
    assert.equal(exported.code, 0, exported.stdout + exported.stderr);
    const result = readFileSync(publicPath, "utf8");
    assert.equal(JSON.parse(result).decisions[0].answer, "a");
    assert.match(result, /Select the parser for \[redacted\]/);
    for (const detail of [...privateDetails.split(" ").filter(part => part.length > 7), "This internal note is omitted.", id]) {
      assert.ok(!result.includes(detail), detail);
    }
    assert.equal((await utp(["leak-check", publicPath], o)).code, 0);
    assert.equal((await utp(["leak-check", card], o)).code, 20);
  } finally {
    await svc.close();
  }
});

test("all seven templates keep their review context and decision content across three views", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-data-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  const o = { cwd: repo(), home: mkdtempSync(path.join(tmpdir(), "utp-home-")) };
  const kinds = ["choose", "approve", "handoff", "clarify", "accept", "assumptions", "notice"];
  try {
    const connected = await utp(["connect", svc.url], { ...o, input: createToken(data, "test") });
    assert.equal(connected.code, 0);
    assert.equal((await utp(["init"], o)).code, 0);
    const ids: Record<string, string> = {};
    const requests: RequestBody[] = [];
    let reviewId = "";
    for (const kind of kinds) {
      const file = path.join(o.cwd, kind + ".json");
      const made = await utp(["new", kind, "--file", file], o);
      assert.equal(made.code, 0, made.stdout + made.stderr);
      const card: RequestBody = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "choose") {
        card.id = "order";
        card.notes = "Match the printed RSL label.";
        card.waivers = [{ rule: "H01-definition", reason: "The sample reproduces the printed label." }];
        card.default = { option: "b", consequence: "The current edition keeps its order." };
        card.previews = [{ label: "Sample entry", text: "Map index" }];
      }
      if (kind === "clarify") card.depends_on = ["order"];
      if (kind === "accept") card.depends_on = [ids.approve + "@1"];
      writeFileSync(file, JSON.stringify(card));
      requests.push(card);
      assert.equal((await utp(["check", file], o)).code, 0);
      const asked = await utp(["ask", file, "--json"], o);
      assert.equal(asked.code, 0, asked.stdout + asked.stderr);
      const queued = JSON.parse(asked.stdout);
      ids[kind] = queued.id;
      reviewId = queued.review_id;
    }
    const intent = { asked: "Organize the sample catalogue.", doing: "Define the entry order.",
      scope_delta: { narrowed: [{ item: "Print edition", reason: "The digital edition has its own index." }],
        deferred: [{ item: "Cover design", reason: "The title is still open." }],
        added: [{ item: "Index proof", reason: "The printer asked for a sample." }] } };
    writeFileSync(path.join(o.cwd, "batch.json"), JSON.stringify({ review: { intent, requests } }));
    const flushed = await utp(["flush", reviewId, "--intent", "batch.json"], o);
    assert.equal(flushed.code, 0, flushed.stdout + flushed.stderr);
    assert.match(flushed.stdout, /review page to answer the batch in one save/);
    const url = flushed.stdout.trim().split("\n").at(-1)!;
    const reopened = await utp(["show", reviewId], o);
    assert.equal(reopened.code, 0);
    const prepared = JSON.parse((await utp(["show", reviewId, "--json"], o)).stdout).review;
    assert.deepEqual(prepared.presentations, []);
    const terminal = await utp(["review", reviewId], { ...o, input: "\n".repeat(6) });
    assert.equal(terminal.code, 0, terminal.stdout + terminal.stderr);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const browser = html.replace(/<style>[\s\S]*?<\/style>|<[^>]+>/g, " ").replaceAll("&#39;", "'");
    const required = [intent.asked, intent.doing, ...Object.values(intent.scope_delta).flatMap(changes =>
      changes.flatMap(change => [change.item, change.reason])),
      ...requests.flatMap(card => [card.question, card.why_now, card.level_reason,
        ...Object.values(card.glossary ?? {}), ...(card.options ?? []).flatMap(o => [o.label, o.consequence])]),
      "Why.", "What it keeps.", "The braver choice.", "The current edition keeps its order.",
      "H01-definition", "The sample reproduces the printed label.", "Map index",
      "the action", "what it acts on", "the smaller scope", "the state after",
      "the person", "where to run it", "the shell to use", "what success looks like", "needs a shell check",
      "step-1", "goal-1", "partly covered", "Describe what you observed.", "Where to verify it", "observed",
      "assumption-1", "What it changes in the plan.", ...Object.values(ids).map(id => id + "@1")];
    for (const [surface, output] of Object.entries({ markdown: reopened.stdout, terminal: terminal.stdout, browser })) {
      for (const detail of required) assert.ok(output.includes(detail), `${surface} omitted ${detail}`);
      assert.ok(output.indexOf(intent.asked) < output.indexOf(requests[0]!.question), surface);
      assert.ok(output.includes(`order (${ids.choose}@1) · ${requests[0]!.question}`), surface + " omitted a named dependency");
      assert.ok(output.includes(`${ids.approve}@1 · ${requests[1]!.question}`), surface + " omitted a pinned dependency");
    }
    const reviewed = await utp(["review"], { ...o, input: "a\nno\ndone\nObserved the test result\n/\n  Use both readings.  \npartly\nchange\n  Revised assumption  \n" });
    assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
    assert.match(reviewed.stdout, /Saved 6 answers/);
    for (const [kind, item, answer, detail] of [
      ["handoff", "step-1", "done", "Observed the test result"],
      ["accept", "goal-1", "partly", undefined],
      ["assumptions", "assumption-1", "change", "  Revised assumption  "],
    ] as const) {
      const shown = await utp(["show", ids[kind]!, "--json"], o);
      assert.equal(shown.code, 0);
      const result = JSON.parse(shown.stdout).request.answer;
      assert.equal(result.items[item], answer);
      assert.equal(result.details?.[item], detail);
    }
    const savedReview = await utp(["review", reviewId], o);
    assert.ok(savedReview.stdout.includes(intent.asked));
    assert.ok(savedReview.stdout.includes("  Use both readings.  "));
    assert.ok(savedReview.stdout.includes("  Revised assumption  "));
    assert.equal((await utp(["revise", ids.clarify!, "clarify.json"], o)).code, 0);
    const history = await utp(["show", reviewId], o);
    assert.ok(history.stdout.includes(ids.clarify + "@1") && history.stdout.includes("  Use both readings.  "));
    assert.ok(!history.stdout.includes(ids.clarify + "@2"));
    const notice = await utp(["show", ids.notice!, "--json"], o);
    assert.equal(JSON.parse(notice.stdout).request.status, "closed");
    const invalid = path.join(o.cwd, "invalid-answer.json");
    writeFileSync(invalid, JSON.stringify({ items: { "assumption-1": "change" } }));
    const refused = await utp(["answer", ids.assumptions!, "--file", invalid], o);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /needs its result or replacement text/);
  } finally {
    await svc.close();
  }
});
