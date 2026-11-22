import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Engine, GRANT_LEASE_MS, TAKEOVER_IDLE_MS } from "../src/core/engine.js";
import { EventStore } from "../src/core/store.js";
import type { Actor, Grant, OpResult, RequestBody } from "../src/core/types.js";

const AGENT: Actor = { machine: "laptop", session: "s1" };
const OTHER: Actor = { machine: "laptop", session: "s2" };
const PERSON: Actor = { machine: "desk", session: "default" };
const MINUTE = 60_000;

class Harness {
  readonly dir = mkdtempSync(path.join(tmpdir(), "utp-engine-"));
  t = Date.parse("2026-11-22T12:00:00Z");
  store = new EventStore(this.dir);
  engine: Engine;
  constructor() {
    this.store.open();
    this.engine = new Engine(this.store, () => new Date(this.t));
    this.engine.load();
  }
  run(op: string, args: Record<string, unknown> = {}, actor: Actor = AGENT, opId?: string): OpResult {
    return this.engine.run(op, args, actor, opId);
  }
  ok(op: string, args: Record<string, unknown> = {}, actor: Actor = AGENT): OpResult {
    const r = this.run(op, args, actor);
    assert.equal(r.code, 0, `${op} failed: ${JSON.stringify(r)}`);
    return r;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  /** Asks, flushes, and records a presentation in the conversation. */
  present(body: RequestBody, basis?: Record<string, string>, actor: Actor = AGENT): string {
    const asked = this.ok("ask", { body, basis }, actor);
    const flushed = this.ok("flush");
    this.ok("presented", { review: flushed.review_id, channel: "conversation" });
    return asked.id as string;
  }
  status(id: string): string {
    return (this.ok("show", { id }).request as { status: string }).status;
  }
  reopen(): Engine {
    this.store.close();
    this.store = new EventStore(this.dir);
    this.store.open();
    const e = new Engine(this.store, () => new Date(this.t));
    e.load();
    return e;
  }
}

const choose = (over: Partial<RequestBody> = {}): RequestBody => ({
  kind: "choose", question: "Which parser should the import use?", why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.", ...over,
});

const approve = (over: Partial<RequestBody> = {}): RequestBody => ({
  kind: "approve", question: "Delete the ten old exports?", why_now: "They block the release build.",
  options: [
    { id: "yes", label: "Delete them", consequence: "The ten files are gone for good.",
      authorization: { action: "delete", target: "exports/", scope: "the ten listed files" } },
    { id: "no", label: "Keep them", consequence: "The release build stays blocked." },
  ],
  stakes: { reversibility: "one_way" }, level: 3, level_reason: "Deleting can't be undone.",
  basis: { files: ["exports/list.txt"] }, ...over,
});

const H1 = { "exports/list.txt": "sha-1" };
const EVIDENCE = { action: "delete", target: "exports/", scope: "the ten listed files", effect: "ten files removed" };

/** Presents an approval, records a terminal-review yes, and returns the grant. */
function granted(h: Harness): { id: string; grant: string } {
  const id = h.present(approve(), H1);
  h.ok("answer", { id, value: "yes", channel: "terminal-review" }, PERSON);
  const w = h.ok("wait", { id, basis: H1 });
  return { id, grant: (w.grant as { id: string }).id };
}

test("a choose request goes from ask to answer, and wait returns the answer without a grant", () => {
  const h = new Harness();
  const asked = h.ok("ask", { body: choose() });
  const id = asked.id as string;
  assert.match(id, /^R-20261122-[0-9a-f]{8}$/);
  assert.equal(h.run("wait", { id }).code, 10);
  assert.equal(h.run("answer", { id, value: "b", channel: "conversation" }, PERSON).code, 19, "not presented yet");
  const flushed = h.ok("flush");
  assert.deepEqual(flushed.items, [`${id}@1`]);
  h.ok("presented", { review: flushed.review_id, channel: "conversation" });
  h.ok("answer", { id, value: "b", channel: "conversation", quote: "b, lenient", addressed: true }, PERSON);
  const w = h.ok("wait", { id });
  assert.equal((w.answer as { value: string }).value, "b");
  assert.equal(w.grant, null);
  assert.equal(h.status(id), "answered");
});

test("presenting before a flush is refused, and an unknown option is a usage error", () => {
  const h = new Harness();
  const asked = h.ok("ask", { body: choose() });
  assert.equal(h.run("presented", { review: asked.review_id, channel: "conversation" }).code, 19);
  h.ok("presented", { review: h.ok("flush").review_id, channel: "conversation" });
  const bad = h.run("answer", { id: asked.id, value: "z", channel: "conversation" }, PERSON);
  assert.equal(bad.code, 1);
  assert.match(String(bad.message), /isn't on this card/);
});

test("a level-3 effect needs an answer from a channel the agent doesn't control", () => {
  const h = new Harness();
  const id = h.present(approve(), H1);
  h.ok("answer", { id, value: "yes", channel: "conversation", quote: "yes delete them" }, PERSON);
  assert.equal(h.run("wait", { id, basis: H1 }).code, 18);
  h.ok("answer", { id, value: "yes", channel: "terminal-review" }, PERSON);
  const w = h.ok("wait", { id, basis: H1 });
  const grant = w.grant as { id: string; provenance: string; epoch: number; authorization: { scope: string } };
  assert.equal(grant.provenance, "channel");
  assert.equal(grant.epoch, 1);
  assert.equal(grant.authorization.scope, "the ten listed files");
  h.ok("begin", { grant: grant.id, basis: H1 });
  assert.equal(h.status(id), "executing");
  const done = h.ok("applied", { grant: grant.id, evidence: EVIDENCE });
  assert.equal(done.status, "applied");
  assert.equal(h.status(id), "applied");
  assert.equal(h.run("begin", { grant: grant.id, basis: H1 }).code, 19, "a grant allows one action");
});

test("revising or withdrawing the answer before begin revokes the grant", () => {
  const h = new Harness();
  const first = granted(h);
  h.ok("answer", { id: first.id, value: "no", channel: "terminal-review" }, PERSON);
  assert.equal(h.run("begin", { grant: first.grant, basis: H1 }).code, 17);
  assert.equal(h.ok("wait", { id: first.id, basis: H1 }).grant, null, "'no' authorizes nothing");

  const second = granted(h);
  h.ok("answer", { id: second.id, withdraw: true, channel: "terminal-review" }, PERSON);
  assert.equal(h.status(second.id), "presented");
  assert.equal(h.run("begin", { grant: second.grant, basis: H1 }).code, 17);
});

test("a precondition that changed before begin makes the request stale and blocks the effect", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  const r = h.run("begin", { grant, basis: { "exports/list.txt": "sha-2" } });
  assert.equal(r.code, 11);
  assert.deepEqual(r.changed, ["exports/list.txt"]);
  assert.equal(h.status(id), "stale");
  const revised = h.ok("revise", { id, body: approve(), basis: { "exports/list.txt": "sha-2" } });
  assert.equal(revised.revision, 2);
  assert.equal(h.run("begin", { grant, basis: H1 }).code, 17);
  assert.equal(h.run("answer", { id: `${id}@1`, value: "yes", channel: "terminal-review" }, PERSON).code, 17);
  assert.equal(h.run("answer", { id, value: "yes", channel: "terminal-review" }, PERSON).code, 19, "revision 2 isn't presented yet");
});

test("an equivalent request attaches as an observer, which receives the answer but never a grant", () => {
  const h = new Harness();
  const body = approve({ dedupe_key: "old-exports" });
  const owner = h.ok("ask", { body, basis: H1 });
  const watcher = h.ok("ask", { body, basis: H1 }, OTHER);
  assert.equal(watcher.id, owner.id);
  assert.equal(watcher.role, "observer");
  const different = h.ok("ask", { body: approve({ dedupe_key: "old-exports", question: "Delete all exports?" }), basis: H1 }, OTHER);
  assert.notEqual(different.id, owner.id);
  assert.equal(different.near_duplicate, owner.id);
  h.ok("presented", { review: h.ok("flush").review_id, channel: "conversation" });
  h.ok("answer", { id: owner.id, value: "yes", channel: "terminal-review" }, PERSON);
  const seen = h.ok("wait", { id: owner.id, basis: H1 }, OTHER);
  assert.equal(seen.role, "observer");
  assert.equal(seen.grant, null);
  assert.equal((seen.answer as { value: string }).value, "yes");
});

test("an unused grant's lease runs out back to answered; a used one becomes outcome_unknown until reconciled", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  h.advance(GRANT_LEASE_MS + MINUTE);
  assert.equal(h.status(id), "answered");
  assert.equal(h.run("begin", { grant, basis: H1 }).code, 13);
  const fresh = (h.ok("wait", { id, basis: H1 }).grant as { id: string }).id;
  assert.notEqual(fresh, grant);
  h.ok("begin", { grant: fresh, basis: H1 });
  h.advance(GRANT_LEASE_MS + MINUTE);
  assert.equal(h.status(id), "outcome_unknown");
  assert.equal(h.run("applied", { grant: fresh, evidence: EVIDENCE }).code, 19);
  assert.equal(h.run("wait", { id, basis: H1 }).code, 19, "reconcile comes first");
  const rec = h.ok("reconcile", { grant: fresh, outcome: "not-performed", evidence: { found: "all ten files still there" } });
  assert.equal(rec.status, "answered");
  assert.ok((h.ok("wait", { id, basis: H1 }).grant as { id: string }).id);
});

test("a partial effect narrows the next grant and checks the recovery basis instead of the original", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  h.ok("begin", { grant, basis: H1 });
  const applied = h.ok("applied", { grant, evidence: { ...EVIDENCE, scope: "six of the ten files", effect: "disk filled" } });
  assert.equal(applied.status, "outcome_unknown");
  assert.deepEqual(applied.mismatch, ["scope"]);
  const H3 = { "exports/list.txt": "sha-3" };
  const rec = h.ok("reconcile", {
    grant, outcome: "partial", evidence: { found: "six removed" }, recovery_basis: H3, remaining_scope: "the four files left",
  });
  assert.equal(rec.status, "answered");
  const next = h.ok("wait", { id, basis: H3 }).grant as { id: string; authorization: { scope: string } };
  assert.equal(next.authorization.scope, "the four files left");
  assert.equal(h.run("begin", { grant: next.id, basis: H1 }).code, 11, "the original fingerprint no longer counts");
});

const recoveryBasis = { "exports/list.txt": "after-partial-effect" };

function recoveryGrant(h: Harness): { id: string; grant: string } {
  const request = approve();
  request.options?.splice(1, 0, {
    id: "narrow", label: "Remove only the two confirmed exports", consequence: "All other exports stay.",
    authorization: { action: "delete", target: "exports/", scope: "the two confirmed exports" },
  });
  const id = h.present(request, H1);
  h.ok("answer", { id, value: "yes", channel: "terminal-review" }, PERSON);
  const grant = h.ok("wait", { id, basis: H1 }).grant as Grant;
  h.ok("begin", { grant: grant.id, basis: H1 });
  return { id, grant: grant.id };
}

test("withdrawing after begin prevents a second grant after zero or partial effects", () => {
  for (const outcome of ["not-performed", "partial"]) {
    const h = new Harness();
    const { id, grant } = recoveryGrant(h);
    h.ok("answer", { id, withdraw: true, channel: "terminal-review" }, PERSON);
    h.advance(GRANT_LEASE_MS + MINUTE);
    const result = h.ok("reconcile", {
      grant, outcome, evidence: { checked: true }, recovery_basis: recoveryBasis, remaining_scope: "four listed exports",
    });
    assert.equal(result.status, "presented");
    assert.equal(h.run("wait", { id, basis: recoveryBasis }).code, 10);
    assert.notEqual(h.run("begin", { grant, basis: H1 }).code, 0);
  }
});

test("finding zero effect re-grants the latest narrower authorization", () => {
  const h = new Harness();
  const { id, grant } = recoveryGrant(h);
  h.ok("answer", { id, value: "narrow", channel: "terminal-review" }, PERSON);
  h.advance(GRANT_LEASE_MS + MINUTE);
  h.ok("reconcile", { grant, outcome: "not-performed", evidence: { checked: true } });
  const next = h.ok("wait", { id, basis: H1 }).grant as Grant;
  assert.equal(next.authorization.scope, "the two confirmed exports");
});

test("partial recovery refuses a remaining scope under a superseded answer", () => {
  const h = new Harness();
  const { id, grant } = recoveryGrant(h);
  h.ok("answer", { id, value: "narrow", channel: "terminal-review" }, PERSON);
  h.advance(GRANT_LEASE_MS + MINUTE);
  const report = { grant, outcome: "partial", evidence: { checked: true }, recovery_basis: recoveryBasis };
  assert.equal(h.run("reconcile", { ...report, remaining_scope: "four listed exports" }).code, 19);
  h.ok("reconcile", { ...report, remaining_scope: "the two confirmed exports" });
  const next = h.ok("wait", { id, basis: recoveryBasis }).grant as Grant;
  assert.equal(next.authorization.scope, "the two confirmed exports");
});

test("a later narrowing requires fresh evidence before a partial recovery can resume", () => {
  const h = new Harness();
  const { id, grant } = recoveryGrant(h);
  h.advance(GRANT_LEASE_MS + MINUTE);
  const report = { grant, outcome: "partial", evidence: { checked: true }, recovery_basis: recoveryBasis };
  h.ok("reconcile", { ...report, remaining_scope: "four listed exports" });
  h.ok("answer", { id, value: "narrow", channel: "terminal-review" }, PERSON);
  assert.equal(h.run("wait", { id, basis: recoveryBasis }).code, 19);
  h.ok("reconcile", { ...report, remaining_scope: "the two confirmed exports" });
  h.engine = h.reopen();
  h.ok("takeover", { id }, OTHER);
  assert.equal(h.run("begin", { grant, basis: H1 }).code, 31);
  const next = h.ok("wait", { id, basis: recoveryBasis }, OTHER).grant as Grant;
  assert.equal(next.authorization.scope, "the two confirmed exports");
  h.ok("begin", { grant: next.id, basis: recoveryBasis }, OTHER);
  h.ok("applied", { grant: next.id, evidence: { ...EVIDENCE, scope: "the two confirmed exports" } }, OTHER);
  assert.equal(h.status(id), "applied");
});

test("replaying a legacy partial recovery retains the authorization behind its grant", () => {
  const h = new Harness();
  const { id, grant } = recoveryGrant(h);
  h.ok("answer", { id, value: "narrow", channel: "terminal-review" }, PERSON);
  h.advance(GRANT_LEASE_MS + MINUTE);
  assert.equal(h.status(id), "outcome_unknown");
  h.store.append({
    at: new Date(h.t).toISOString(), type: "grant.reconciled", actor: AGENT,
    data: { op: "reconcile", grant, outcome: "partial", recovery_basis: recoveryBasis, remaining_scope: "four listed exports" },
  });
  h.engine = h.reopen();
  assert.equal(h.run("wait", { id, basis: recoveryBasis }).code, 19);
});

test("an unknown effect blocks a retry and a different effect stays flagged", () => {
  const h = new Harness();
  const { id, grant } = recoveryGrant(h);
  h.advance(GRANT_LEASE_MS + MINUTE);
  const report = { grant, evidence: { checked: true } };
  assert.equal(h.ok("reconcile", { ...report, outcome: "unknown" }).status, "outcome_unknown");
  assert.equal(h.run("wait", { id, basis: H1 }).code, 19);
  assert.equal(h.run("takeover", { id }, OTHER).code, 19);
  assert.equal(h.ok("reconcile", { ...report, outcome: "different" }).status, "applied");
  const { flags } = h.ok("show", { id }).request as { flags: string[] };
  assert.ok(flags.includes("reconciled as different from what was authorized"));
  assert.notEqual(h.run("begin", { grant, basis: H1 }).code, 0);
});

test("takeover waits for 15 idle minutes, raises the epoch, and refuses the old owner's begin", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  const early = h.run("takeover", { id }, OTHER);
  assert.equal(early.code, 19);
  assert.ok(Number(early.retry_after_s) > 0);
  h.advance(TAKEOVER_IDLE_MS);
  const took = h.ok("takeover", { id }, OTHER);
  assert.equal(took.epoch, 2);
  assert.equal(h.run("begin", { grant, basis: H1 }).code, 31);
  const mine = h.ok("wait", { id, basis: H1 }, OTHER).grant as { id: string; epoch: number };
  assert.equal(mine.epoch, 2);
  assert.equal(h.run("begin", { grant: mine.id, basis: H1 }).code, 19, "another session's grant");
  h.ok("begin", { grant: mine.id, basis: H1 }, OTHER);
  assert.equal(h.run("takeover", { id }, AGENT).code, 19, "no takeover while an effect is under way");
});

test("an owner can release an unused grant, which allows an immediate takeover", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  assert.equal(h.run("release", { grant }, OTHER).code, 19);
  h.ok("release", { grant });
  assert.equal(h.status(id), "answered");
  h.ok("takeover", { id }, OTHER);
});

test("retrying an operation id returns the first result and commits nothing new", () => {
  const h = new Harness();
  const id = h.present(approve(), H1);
  const first = h.run("answer", { id, value: "yes", channel: "terminal-review" }, PERSON, "op-answer-1");
  const again = h.run("answer", { id, value: "no", channel: "terminal-review" }, PERSON, "op-answer-1");
  assert.deepEqual(again, first);
  const g1 = h.run("wait", { id, basis: H1 }, AGENT, "op-wait-1");
  const events = h.store.all().length;
  const g2 = h.run("wait", { id, basis: H1 }, AGENT, "op-wait-1");
  assert.deepEqual(g2, g1);
  assert.equal(h.store.all().length, events);
  assert.equal(h.run("cancel", { id }, AGENT, "op-wait-1").code, 1, "an op id belongs to one operation");
});

test("the projection rebuilt from the log matches the live one", () => {
  const h = new Harness();
  const { id, grant } = granted(h);
  h.ok("begin", { grant, basis: H1 });
  h.ok("applied", { grant, evidence: EVIDENCE });
  const other = h.present(choose());
  h.ok("answer", { id: other, hide_until: new Date(h.t + 60 * MINUTE).toISOString(), channel: "terminal-review" }, PERSON);
  const live = [h.ok("status"), h.ok("show", { id }), h.ok("show", { id: other }), h.ok("log", {})];
  const rebuilt = h.reopen();
  const replayed = [{}, { id }, { id: other }, {}].map((args, i) =>
    rebuilt.run(["status", "show", "show", "log"][i] as string, args, AGENT));
  assert.deepEqual(replayed, live);
});

test("a notice closes when presented and needs no answer", () => {
  const h = new Harness();
  const id = h.present({
    kind: "notice", question: "I renamed the config loader.", why_now: "You may see the new name in logs.",
    stakes: { reversibility: "easy" }, level: 1, level_reason: "Reversible, and you might care.",
  });
  assert.equal(h.status(id), "closed");
  assert.equal(h.run("answer", { id, value: "a", channel: "terminal-review" }, PERSON).code, 19);
  assert.equal(h.run("wait", { id }).code, 0);
});

test("a hidden card comes back when its time passes, and an unanswered one expires", () => {
  const h = new Harness();
  const id = h.present(choose({ expires_at: new Date(h.t + 120 * MINUTE).toISOString() }));
  h.ok("answer", { id, hide_until: new Date(h.t + 60 * MINUTE).toISOString(), channel: "terminal-review" }, PERSON);
  assert.equal(h.run("wait", { id }).code, 10);
  assert.equal(h.status(id), "hidden");
  h.advance(61 * MINUTE);
  assert.equal(h.status(id), "presented");
  h.advance(60 * MINUTE);
  assert.equal(h.run("wait", { id }).code, 13);
});

test("only the owner cancels, and cancelling ends the wait", () => {
  const h = new Harness();
  const id = h.present(choose());
  assert.equal(h.run("cancel", { id }, OTHER).code, 19);
  h.ok("cancel", { id });
  assert.equal(h.run("wait", { id }).code, 12);
});

test("a recorded reversal is found by its tag", () => {
  const h = new Harness();
  const id = h.present(choose({ tags: ["parser"] }));
  assert.equal(h.run("reverse", { id, reason: "too early" }).code, 19, "nothing was decided yet");
  h.ok("answer", { id, value: "a", channel: "terminal-review" }, PERSON);
  h.ok("reverse", { id, reason: "strict parsing rejected real data", tags: ["import"] });
  const found = h.ok("log", { tags: ["import"] }).entries as { id: string; reversals: unknown[] }[];
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, id);
  assert.equal(h.ok("log", { text: "real data" }).entries instanceof Array, true);
  assert.equal((h.ok("log", { text: "nothing like this" }).entries as unknown[]).length, 0);
});
