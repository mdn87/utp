// Run after the TypeScript build. --development opens only the training half.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = process.env.UTP_BUILD_DIR || path.join(root, "dist");
const { checkRequest } = await import(pathToFileURL(path.resolve(build, "src/core/check.js")).href);
const load = name => JSON.parse(readFileSync(path.join(root, "test/fixtures/review-quality", name + ".json"), "utf8"));
const findings = body => [...new Set(checkRequest(body).map(issue => issue.rule))];
const ids = rows => rows.map(row => row.id).sort();

const seed = "utp-review-quality-v1";
const splitKey = id => createHash("sha256").update(seed + ":" + id).digest("hex");
const ranked = Array.from({ length: 21 }, (_, i) => "case-" + String(i + 1).padStart(2, "0")).sort((a, b) =>
  splitKey(a).localeCompare(splitKey(b), "en"));
const development = load("development");
assert.deepEqual(ids(development), ranked.slice(0, 10).sort(), "development IDs differ from the seeded split");
for (const row of development) {
  assert(findings(row.before).includes(row.rule), row.id + " no longer catches its development defect");
  assert.deepEqual(findings(row.after), [], row.id + " repair");
}
if (process.argv.includes("--development")) {
  console.log("All " + development.length + " development pairs passed.");
  process.exit(0);
}

const holdout = load("holdout");
const controls = load("must-accept");
const drafts = load("platform-drafts");
assert.deepEqual(ids(holdout), ranked.slice(10).sort(), "held-out IDs differ from the seeded split");
assert.equal(new Set(ids(controls)).size, 12);
assert.equal(controls.filter(row => row.group === "went-well").length, 7);
assert.equal(controls.filter(row => row.group === "rewritten").length, 5);
assert.equal(drafts.length, 6);
assert.equal(new Set(ids(drafts)).size, 6);
for (const platform of ["Claude Code", "Codex", "Antigravity"]) {
  assert.deepEqual(drafts.filter(row => row.platform === platform).map(row => row.brief).sort(), ["book pickups", "seed labels"]);
}

function judge(id, expected, body) {
  assert(!body.waivers?.length, id + " must be scored without waivers");
  const actual = findings(body);
  return { id, expected, actual, correct: actual.filter(rule => expected.includes(rule)),
    extra: actual.filter(rule => !expected.includes(rule)), missed: expected.filter(rule => !actual.includes(rule)) };
}
const before = holdout.map(row => judge(row.id, [row.rule], row.before));
const after = holdout.map(row => judge(row.id, [], row.after));
const accepted = controls.map(row => judge(row.id, [], row.body));
const platformResults = drafts.map(row => ({ ...judge(row.id, row.expectedRules, row.body), platform: row.platform }));
const mix = [...before, ...accepted, ...platformResults];
const ratio = (count, total) => ({ count, total, percent: total ? Math.round(1000 * count / total) / 10 : null });
const clean = rows => ratio(rows.filter(row => row.actual.length === 0).length, rows.length);
const recall = ratio(before.filter(row => row.missed.length === 0).length, before.length);
const specificity = clean(accepted);
const repairs = clean(after);
const precision = ratio(mix.reduce((n, row) => n + row.correct.length, 0), mix.reduce((n, row) => n + row.actual.length, 0));
const platformCounts = {};
for (const row of platformResults) {
  const p = platformCounts[row.platform] ??= { drafts: 0, correctlyFlaggedRules: 0, extraRules: 0, missedRules: 0 };
  p.drafts++;
  p.correctlyFlaggedRules += row.correct.length;
  p.extraRules += row.extra.length;
  p.missedRules += row.missed.length;
}
const report = { seed, development: development.length, recall, specificity, repairs, precision,
  precisionMix: { heldOutBefores: before.length, mustAccept: accepted.length, platformDrafts: platformResults.length },
  platformCounts, discrepancies: mix.filter(row => row.extra.length || row.missed.length),
  failedRepairs: after.filter(row => row.actual.length) };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  for (const [name, result] of Object.entries({ recall, specificity, repairs, precision })) {
    console.log(`${name}  ${result.count}/${result.total}  ${result.percent ?? "undefined"}%`);
  }
  console.log("Precision mix", report.precisionMix);
  console.table(platformCounts);
  for (const row of [...report.discrepancies, ...report.failedRepairs]) {
    console.log(row.id, "missed", row.missed.join(", ") || "none", "extra", row.extra.join(", ") || "none");
  }
}
if (recall.count / recall.total < 0.8 || specificity.count / specificity.total < 0.9 || repairs.count !== repairs.total) {
  process.exitCode = 1;
}
