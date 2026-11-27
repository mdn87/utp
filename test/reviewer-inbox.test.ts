import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./support/tmp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Engine } from "../src/core/engine.js";
import { handleReviewerInbox, inboxLabel } from "../src/server/reviewer-inbox.js";
import type { ReviewPages } from "../src/server/review-page.js";
import { Service, type ProjectInfo } from "../src/server/service.js";

const project = (fields: Partial<ProjectInfo>): ProjectInfo =>
  ({ id: "prj-0123456789ab", created_at: "2026-01-01T00:00:00.000Z", ...fields });
const hash = "3f9a1c0b7d2e4f6a8b9c0d1e2f3a4b5c6d7e8f90";

test("old metadata named after a detached commit hash shows the repository basename", () => {
  for (const name of [hash, hash.toUpperCase(), "a".repeat(40), "a".repeat(64)]) {
    assert.equal(inboxLabel(project({ name, remote: "git.example.test/sample-org/sample-repo" })), "sample-repo");
  }
  assert.equal(inboxLabel(project({ remote: "git.example.test/sample-org/sample-repo" })), "sample-repo");
});

test("meaningful explicit names are kept as written", () => {
  for (const name of ["Sample Project", "sample-repo", "defaced", "release 2", "v1.2.3", "dead1234"]) {
    assert.equal(inboxLabel(project({ name, remote: "git.example.test/sample-org/other-repo" })), name);
  }
});

test("unsafe remote shapes never leak URLs, credentials or query strings", () => {
  const unsafe = [
    "https://user:s3cret-token@git.example.test/sample-org/sample-repo.git?access_token=abc123#frag",
    "ssh://git@git.example.test:2222/sample-org/sample-repo.git",
    "git.example.test:sample-org/sample-repo.git/",
    "git.example.test/sample-org/sample-repo?token=xyz",
    "C:\\repos\\sample-repo",
  ];
  for (const remote of unsafe) {
    const label = inboxLabel(project({ name: hash, remote }));
    assert.equal(label, "sample-repo", remote);
    assert.doesNotMatch(label, /[:@?#=/\\]|s3cret|token|example/);
  }
});

test("a readable fallback replaces a hash when no safe basename exists", () => {
  const remotes = [undefined, "", "git.example.test", "https://git.example.test/?token=abc", "https://git.example.test:8443",
    "git.example.test/org/" + hash,
    "git.example.test/org/%2e%2e", "git.example.test/org/..", "git.example.test/org/" + "x".repeat(200)];
  for (const remote of remotes) {
    const label = inboxLabel(project({ name: hash, ...(remote === undefined ? {} : { remote }) }));
    assert.equal(label, "Unnamed project", String(remote));
  }
  assert.equal(inboxLabel(project({})), "Unnamed project");
});

test("the inbox page renders safe headings for old hash-named metadata without changing stored project data", async (t) => {
  const service = new Service(mkdtempSync(path.join(tmpdir(), "utp-inbox-label-")));
  t.after(() => service.close());
  const actor = { machine: "laptop", session: "sample-session" };
  const create = (name: string) => (service.global("project.create", { remote: "git.example.test/sample-org/placeholder", name }, actor)!
    .project as ProjectInfo).id;
  const old = create(hash);
  const named = create("Sample Project");
  const oldFile = path.join(service.storesDir, old, "project.json");
  const stored = { id: old, created_at: "2026-01-01T00:00:00.000Z", name: hash,
    remote: "https://user:s3cret-token@git.example.test/sample-org/sample-repo.git?access_token=abc123" };
  writeFileSync(oldFile, JSON.stringify(stored, null, 2) + "\n");
  const before = readFileSync(oldFile, "utf8");
  for (const id of [old, named]) {
    const engine = service.engine(id) as Engine;
    engine.run("ask", { body: {
      kind: "choose", category: "approach", question: `Which sample for ${id}?`, why_now: "A sample step needs one.",
      options: [{ id: "a", label: "First", consequence: "Uses the first." }, { id: "b", label: "Second", consequence: "Uses the second." }],
      stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.",
    } }, actor);
    engine.run("flush", {}, actor);
  }
  let html = "";
  let status = 0;
  const res = { writeHead: (code: number) => { status = code; return res; }, end: (text?: string) => { html += text ?? ""; } };
  const pages = { origin: new URL("https://reviews.example.test") } as ReviewPages;
  const req = { url: "/", method: "GET", headers: { host: "reviews.example.test" } } as IncomingMessage;
  await handleReviewerInbox(req, res as unknown as ServerResponse, service, pages, async () => undefined);
  assert.equal(status, 200);
  const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]).sort();
  assert.deepEqual(headings, ["Sample Project", "sample-repo"]);
  assert.doesNotMatch(html, new RegExp(`${hash}|s3cret|access_token|git\\.example\\.test`));
  assert(html.includes(`/open/${old}/`) && html.includes(`/open/${named}/`));
  assert.equal(readFileSync(oldFile, "utf8"), before);
  assert.deepEqual(service.projects().find((p) => p.id === old), stored);
});
