import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDocument, checkRequest } from "../src/core/check.js";
import { cardMarkdown, type RequestView } from "../src/cli/render.js";
import { reviewHtml } from "../src/server/review-html.js";
import type { RequestBody } from "../src/core/types.js";

const valid = (): RequestBody => ({
  kind: "choose", category: "approach", question: "Which parser should the import use?", why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  recommendation: { option: "b", because: "Some exports contain bad rows.", preserves: "Valid rows still import.",
    bolder_alternative: "Stop and fix every bad row first." },
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.",
});

const rules = (body: unknown) => checkRequest(body).map((f) => f.rule);

test("a complete request passes", () => {
  assert.deepEqual(checkRequest(valid()), []);
});

test("each structural gap is reported with its rule id", () => {
  assert.deepEqual(rules({ ...valid(), why_now: " " }), ["S03-why-now"]);
  const a = valid().options![0]!;
  assert.deepEqual(rules({ ...valid(), recommendation: undefined, options: [a] }), ["S07-options"]);
  assert.deepEqual(rules({ ...valid(), recommendation: undefined, options: [a, a] }), ["S08-option-id"]);
  assert.deepEqual(rules({ ...valid(), options: [a] }), ["S07-options", "S13-recommendation"], "a dangling recommendation is its own problem");
  assert.deepEqual(rules({ ...valid(), recommendation: { option: "z", because: "x" } }), ["S13-recommendation"]);
  assert.deepEqual(rules({ ...valid(), kind: "approve" }), ["S12-approve-authorization"]);
  assert.deepEqual(rules({ ...valid(), stakes: { reversibility: "maybe" } }), ["S06-stakes"]);
  assert.deepEqual(rules("not an object"), ["S00-shape"]);
});

test("a level-3 request can't carry a default, because it always waits for the person", () => {
  const body = { ...valid(), level: 3, default: { option: "a", consequence: "Strict parsing is used." } };
  assert.deepEqual(rules(body), ["S15-default-level"]);
  assert.deepEqual(rules({ ...body, level: 2 }), []);
});

test("a warning blocks queuing until fixed or waived with a reason; structural gaps cannot be waived", () => {
  const draft = { ...valid(), category: "approach", recommendation: undefined, question: "Use the QXJ tray?" };
  assert.deepEqual(rules(draft), ["H01-definition"]);
  assert.deepEqual(rules({ ...draft, glossary: { QXJ: "The tray for unclaimed packets" } }), []);
  const waivers = [{ rule: "H01-definition", reason: "This workshop uses the printed tray code." }];
  assert.deepEqual(rules({ ...draft, waivers }), []);
  assert(rules({ ...draft, waivers: [{ rule: "H01-definition", reason: " " }] }).includes("S25-waiver"));
  const invalid = { ...draft, why_now: "", waivers: [...waivers, { rule: "S03-why-now", reason: "Skip" }] };
  assert(rules(invalid).includes("S03-why-now"));
  assert(rules(invalid).includes("S25-waiver"));
});

test("each heuristic explains a distinct repair and accepts the corrected card", () => {
  const clean = valid();
  const evidence = [{ claim: "The sample imported.", kind: "observed", source: "Import report", date: "2026-02-06" }];
  const pairs: [string, Partial<RequestBody>, Partial<RequestBody>][] = [
    ["H01-definition", { question: "Use the GRC bins?" }, { question: "Use the garden return counter (GRC)?" }],
    ["H02-status", { why_now: "The import is fixed." }, { why_now: "The import is fixed.", evidence }],
    ["H03-evidence", { evidence: [{ ...evidence[0]!, kind: "maybe" }] }, { evidence }],
    ["H04-focus", { question: "Use the strict parser? Change the input too?" }, { question: "Use the strict parser?" }],
    ["H05-recommendation", { recommendation: { option: "a", because: "Stops at the first bad row." } },
      { recommendation: clean.recommendation }],
    ["H06-scope", { default: { option: "a", consequence: "Change things as needed." } },
      { default: { option: "a", consequence: "Stop at the first bad row." } }],
    ["H07-review-target", { question: "How would you rate the design sample?" },
      { question: "How would you rate the design sample?", previews: [{ label: "Sample", text: "Planting calendar" }] }],
  ];
  for (const [rule, before, after] of pairs) {
    const issues = checkRequest({ ...clean, ...before });
    assert.deepEqual(issues.map(f => f.rule), [rule]);
    assert(issues[0]!.waivable && issues[0]!.message.length);
    assert.deepEqual(checkRequest({ ...clean, ...after }), []);
  }
});

test("approval requires dated evidence and either distinct scopes or an explanation", () => {
  const base = { ...valid(), kind: "approve", recommendation: undefined, options: [
    { id: "all", label: "Replace the sheet", consequence: "The workshop uses the new sheet.",
      authorization: { action: "replace", target: "workshop sheet", scope: "all rows" } },
    { id: "keep", label: "Keep it", consequence: "All current rows remain." },
  ] };
  assert.deepEqual(rules(base), ["S23-narrower", "S24-approval-evidence"]);
  const full = { ...base, narrowing_reason: "The sheet is printed on one page.",
    evidence: [{ kind: "observed", claim: "One page was counted.", date: "2026-02-06", source: "Print preview" }] };
  assert.deepEqual(rules(full), []);
  assert.deepEqual(rules({ ...valid(), category: "undefined" }), ["S22-category"]);
});

test("a reasoned waiver travels with its revision to the terminal and the escaped browser page", () => {
  const body = { ...valid(), question: "Use the RSL tray?", waivers: [
    { rule: "H01-definition", reason: "The printed label reads <RSL>." }] };
  assert.deepEqual(checkRequest(body), []);
  const card: RequestView = { id: "example", revision: 1, current: true, status: "presented", body, answer: null, flags: [] };
  assert.match(cardMarkdown(card), /Waived H01-definition.*RSL.*The printed label reads <RSL>/);
  const html = reviewHtml({ id: "sample", items: [card] }, "form");
  assert.match(html, /saved without a stated purpose or scope/);
  assert.match(html, /Waived H01-definition.*RSL.*The printed label reads &lt;RSL&gt;/);
  assert(!html.includes("reads <RSL>"));
});

test("a batch file requires the author's intent and identifies the card needing repair", () => {
  assert.deepEqual(checkDocument({ review: { requests: [valid()] } }).map(f => f.rule), ["S28-intent"]);
  const intent = { asked: "Prepare the import.", doing: "Choose a parser.", scope_delta: "none" };
  assert.deepEqual(checkDocument({ review: { intent, requests: [valid()] } }), []);
  const withTitle = (title: unknown) => checkDocument({ review: { intent: { ...intent, task_title: title }, requests: [valid()] } });
  assert.deepEqual(withTitle("Résumé settings"), []);
  for (const invalid of ["  ", "Import\nsettings", "a".repeat(81), 4]) {
    assert.match(withTitle(invalid)[0]?.message ?? "", /task title/i);
  }
  const problems = checkDocument({ review: { intent, requests: [valid(), { ...valid(), why_now: "" }] } });
  assert.equal(problems[0]?.rule, "S03-why-now");
  assert.match(problems[0]!.message, /Request 2/);
});
