// The revisit card: reconsidering a logged decision whose basis changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "./support/tmp.js";
import { checkRequest } from "../src/core/check.js";
import { Engine, type DecisionLogEntry } from "../src/core/engine.js";
import { projectReviewToDialog } from "../src/core/native-dialog.js";
import { EventStore } from "../src/core/store.js";
import { cardMarkdown, reviewMarkdown, type RequestView, type ReviewView } from "../src/cli/render.js";
import { reviewHtml } from "../src/server/review-html.js";
import type { Actor, OpResult, RequestBody } from "../src/core/types.js";

const AGENT: Actor = { machine: "laptop", session: "s1" };
const PERSON: Actor = { machine: "desk", session: "default" };
const CLI = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

class Harness {
  readonly dir = mkdtempSync(path.join(tmpdir(), "utp-revisit-"));
  t = Date.parse("2026-11-24T12:00:00Z");
  store = new EventStore(this.dir);
  engine: Engine;
  constructor() {
    this.store.open();
    this.engine = new Engine(this.store, () => new Date(this.t));
    this.engine.load();
  }
  run(op: string, args: Record<string, unknown> = {}, actor: Actor = AGENT): OpResult {
    return this.engine.run(op, args, actor);
  }
  ok(op: string, args: Record<string, unknown> = {}, actor: Actor = AGENT): OpResult {
    const r = this.run(op, args, actor);
    assert.equal(r.code, 0, `${op} failed: ${JSON.stringify(r)}`);
    return r;
  }
  /** Asks, flushes, and records a presentation. Returns the request id and its review. */
  present(body: RequestBody, basis?: Record<string, string>): { id: string; review: string } {
    const asked = this.ok("ask", { body, basis });
    const flushed = this.ok("flush");
    this.ok("presented", { review: flushed.review_id, channel: "conversation" });
    return { id: asked.id as string, review: flushed.review_id as string };
  }
  answer(id: string, value: string): void {
    this.t += 60_000;
    this.ok("answer", { id, channel: "terminal-review", value }, PERSON);
  }
  view(id: string): RequestView & Record<string, unknown> {
    return this.ok("show", { id }).request as RequestView & Record<string, unknown>;
  }
  entry(id: string): DecisionLogEntry {
    const entries = this.ok("log", { related: id }).entries as DecisionLogEntry[];
    return entries.find((e) => e.id === id)!;
  }
  reopen(): void {
    this.store.close();
    this.store = new EventStore(this.dir);
    this.store.open();
    this.engine = new Engine(this.store, () => new Date(this.t));
    this.engine.load();
  }
}

const BASIS = "Every supplier file had complete rows.";
const CHANGE = "One supplier now sends rows without a price.";
const AMENDED = "Stay strict, but list rows without a price instead of stopping";

const earlier = (over: Partial<RequestBody> = {}): RequestBody => ({
  kind: "choose", category: "approach", question: "Which parser should the import use?", why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.", tags: ["import"], ...over,
});

const revisit = (decision: string, over: Partial<RequestBody> = {}): RequestBody => ({
  kind: "revisit", question: "Should the strict parser stay now that one supplier sends rows without a price?",
  why_now: "The next import runs tomorrow.",
  revisit: { decision, original_basis: BASIS, change: CHANGE },
  options: [
    { id: "keep", label: "Keep the strict parser", consequence: "A file with a row that has no price stops the import." },
    { id: "amend", label: AMENDED, consequence: "The import finishes and reports the rows it left out." },
    { id: "reverse", label: "Switch to the lenient parser", consequence: "Bad rows of every kind are skipped and listed." },
  ],
  evidence: [{ claim: "Tuesday's supplier file had 14 rows without a price.", kind: "observed", source: "Import log", date: "2026-11-24" }],
  stakes: { reversibility: "easy" }, level: 2, level_reason: "It changes a decision the person made.", tags: ["supplier"], ...over,
});

const rules = (body: unknown): string[] => [...new Set(checkRequest(body).map((f) => f.rule))];
const PLACEHOLDER = "R-20261122-0a1b2c3d";

test("a revisit names the earlier decision, what it rested on and what changed, and offers keep, amend and reverse", () => {
  const card = revisit(PLACEHOLDER);
  assert.deepEqual(checkRequest(card), []);
  assert.deepEqual(rules({ ...card, revisit: undefined }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, revisit: { ...card.revisit!, change: " " } }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, revisit: { ...card.revisit!, original_basis: "" } }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, revisit: { ...card.revisit!, decision: "the parser decision" } }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, options: card.options!.slice(0, 2) }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, options: card.options!.map((o) => (o.id === "amend" ? { ...o, id: "change" } : o)) }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, evidence: undefined }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, default: { option: "keep", consequence: "The strict parser stays." } }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...card, level: 1 }), ["S32-revisit"]);
  assert.deepEqual(rules({ ...earlier(), revisit: card.revisit }), ["S32-revisit"]);
});

test("a revisit must point at a decision the person answered, and UTP shows that decision as it was recorded", () => {
  const h = new Harness();
  try {
    assert.equal(h.run("ask", { body: revisit(PLACEHOLDER) }).code, 40);
    const first = h.present(earlier());
    const unanswered = h.run("ask", { body: revisit(first.id) });
    assert.equal(unanswered.code, 19);
    assert.match(String(unanswered.message), /answered or applied/);
    h.answer(first.id, "a");

    const second = h.present(revisit(first.id));
    const shown = h.view(second.id);
    assert.equal(shown.body.revisit!.decision, `${first.id}@1`);
    assert.ok(shown.body.related!.includes(first.id));
    const before = shown.earlier_decision as { ref: string; question: string; answer?: string };
    assert.equal(before.ref, `${first.id}@1`);
    assert.equal(before.question, "Which parser should the import use?");
    assert.equal(before.answer, "Strict (a)");

    assert.equal(h.run("revise", { id: second.id, body: revisit(PLACEHOLDER) }).code, 40);
    const revised = h.ok("revise", { id: second.id, body: revisit(first.id, { why_now: "The next import runs tonight." }) });
    assert.equal(h.view(`${second.id}@${String(revised.revision)}`).body.revisit!.decision, `${first.id}@1`);

    const flushed = h.ok("flush");
    h.ok("presented", { review: flushed.review_id, channel: "conversation" });
    h.answer(`${second.id}@2`, "keep");
    const again = h.run("ask", { body: revisit(second.id) });
    assert.equal(again.code, 19);
    assert.match(String(again.message), /original decision/);
  } finally { h.store.close(); }
});

test("keeping a decision is recorded on it and does not count as a reversal", () => {
  const h = new Harness();
  try {
    const first = h.present(earlier());
    h.answer(first.id, "a");
    const second = h.present(revisit(first.id));
    assert.equal(h.entry(first.id).revisits, undefined);
    h.answer(second.id, "keep");

    const entry = h.entry(first.id);
    assert.deepEqual(entry.reversals, []);
    assert.equal(entry.revisits!.length, 1);
    const record = entry.revisits![0]!;
    assert.equal(record.outcome, "keep");
    assert.equal(record.request, `${second.id}@1`);
    assert.equal(record.revision, 1);
    assert.equal(record.change, CHANGE);
    assert.deepEqual((h.ok("consider", { level: 2, tags: ["import"] }).reversals as unknown[]), []);
    assert.equal((h.view(first.id).revisits as unknown[]).length, 1);
    assert.match(cardMarkdown(h.view(first.id)), /Revisited 2026-11-24: kept\. One supplier now sends rows without a price\./);
    assert.equal(h.ok("log", { kind: "revisit" }).entries instanceof Array, true);
    assert.equal((h.ok("log", { text: "without a price" }).entries as DecisionLogEntry[]).some((e) => e.id === first.id), true);

    h.reopen();
    assert.equal(h.entry(first.id).revisits![0]!.outcome, "keep");
  } finally { h.store.close(); }
});

test("reversing through a revisit counts as a reversal wherever reversals are read, and follows the latest answer", () => {
  const h = new Harness();
  try {
    const first = h.present(earlier());
    h.answer(first.id, "a");
    h.ok("pin", { id: first.id });
    const second = h.present(revisit(first.id));
    h.answer(second.id, "reverse");

    const entry = h.entry(first.id);
    assert.equal(entry.reversals.length, 1);
    assert.match(entry.reversals[0]!.reason, /One supplier now sends rows without a price\./);
    assert.deepEqual(entry.reversals[0]!.tags, ["supplier"]);
    assert.equal(entry.revisits![0]!.outcome, "reverse");
    const related = h.ok("consider", { level: 2, tags: ["import"] }).reversals as Array<{ id: string }>;
    assert.deepEqual(related.map(({ id }) => id), [first.id]);
    assert.deepEqual((h.ok("consider", { level: 2, tags: ["supplier"] }).reversals as Array<{ id: string }>).map(({ id }) => id), [first.id]);
    assert.equal(h.run("decide", { level: 2, tags: ["import"], body: earlier({ question: "Which parser should the export use?" }) }).code, 19);
    assert.ok(h.engine.decisionPins()[0]!.reasons.includes("reversed"));
    assert.match(h.engine.historyReview(first.review)!.cards[0]!.reversals.join(" "), /without a price/);
    assert.equal(h.run("wait", { id: first.id }).code, 17);

    h.answer(second.id, "keep");
    assert.deepEqual(h.entry(first.id).reversals, []);
    assert.equal(h.entry(first.id).revisits![0]!.outcome, "keep");
    assert.deepEqual(h.engine.decisionPins()[0]!.reasons, []);

    h.ok("cancel", { id: second.id });
    assert.equal(h.entry(first.id).revisits, undefined);
  } finally { h.store.close(); }
});

test("amending records the amended wording and retires the earlier answer as authority", () => {
  const h = new Harness();
  const files = { "exports/list.txt": "sha-1" };
  const authorization = { action: "delete", target: "exports/", scope: "the ten listed files" };
  try {
    const approval = h.present({
      kind: "approve", question: "Delete the ten old exports?", why_now: "They block the release build.",
      narrowing_reason: "The release uses this export set as one unit.",
      evidence: [{ claim: "The manifest lists ten exports.", kind: "observed", source: "Release manifest", date: "2026-11-22" }],
      options: [
        { id: "yes", label: "Delete them", consequence: "The ten files are gone for good.", authorization },
        { id: "no", label: "Keep them", consequence: "The release build stays blocked." },
      ],
      stakes: { reversibility: "one_way" }, level: 3, level_reason: "Deleting can't be undone.", basis: { files: ["exports/list.txt"] },
    }, files);
    h.answer(approval.id, "yes");
    h.ok("pin", { id: approval.id });
    const notice = { kind: "notice", question: "Use the existing approval.", why_now: "Continue the approved release.",
      stakes: { reversibility: "easy" }, level: 1, level_reason: "Existing authority covers these files." };
    const cite = { level: 3, body: notice, authority: { decision_id: approval.id, authorization } };
    assert.equal(h.ok("consider", cite).use_request, `${approval.id}@1`);

    const second = h.present(revisit(approval.id, { question: "Should all ten exports still be deleted now that two are referenced?" }));
    h.answer(second.id, "amend");
    const record = h.entry(approval.id).revisits![0]!;
    assert.equal(record.outcome, "amend");
    assert.equal(record.amendment, AMENDED);
    assert.deepEqual(h.entry(approval.id).reversals, []);
    assert.equal(h.run("consider", cite).code, 19);
    const waited = h.run("wait", { id: approval.id, basis: files });
    assert.equal(waited.code, 17);
    assert.match(String(waited.message), /amended/);
    assert.ok(h.engine.decisionPins()[0]!.reasons.includes("amended"));
    assert.match(h.engine.historyReview(approval.review)!.cards[0]!.revisits!.join(" "), /amended to .*Stay strict/);
  } finally { h.store.close(); }
});

test("the revisit card shows the earlier decision, its basis and the change in Markdown and on the page, and never in a dialog", () => {
  const h = new Harness();
  try {
    const first = h.present(earlier());
    h.answer(first.id, "a");
    const second = h.present(revisit(first.id, { question: "Should the <strict> parser stay?",
      glossary: { strict: "A parser that stops at the first bad row." } }));
    const review = h.ok("show", { id: second.review }).review as ReviewView;

    const markdown = reviewMarkdown(review);
    assert.match(markdown, /\*\*Earlier decision\*\*\nWhich parser should the import use\? — Strict \(a\) \(R-[^,]+@1, decided 2026-11-24\)/);
    assert.match(markdown, /\*\*It rested on\*\*\nEvery supplier file had complete rows\./);
    assert.match(markdown, /\*\*What changed\*\*\nOne supplier now sends rows without a price\./);
    assert.ok(markdown.indexOf("**What changed**") < markdown.indexOf("**What this question addresses**"));

    const html = reviewHtml(review, "token");
    assert.match(html, /<span class="badge">Revisit<\/span>/);
    assert.match(html, /Earlier decision<\/h3>[\s\S]*Which parser should the import use\? — Strict \(a\)/);
    assert.match(html, /It rested on<\/h3>[\s\S]*Every supplier file had complete rows\./);
    assert.match(html, /What changed<\/h3>[\s\S]*One supplier now sends rows without a price\./);
    assert.ok(html.includes("Should the &lt;strict&gt; parser stay?"));

    for (const platform of ["claude", "codex", "antigravity"] as const) {
      const dialog = projectReviewToDialog(review, { platform });
      assert.equal(dialog.eligible, false);
      assert.ok(dialog.reasons.some((r) => r.code === "drops_content" && /revisit/.test(r.message)), platform);
      assert.match(dialog.fallback_markdown, /\*\*What changed\*\*/);
    }
  } finally { h.store.close(); }
});

test("utp new revisit writes a template that passes utp check", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "utp-revisit-new-")), "revisit.json");
  const made = spawnSync(process.execPath, [CLI, "new", "revisit", "--file", file], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const checked = spawnSync(process.execPath, [CLI, "check", file], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
