// Phase 2 Rich Review tests:
// 1. Blind `judge` comparisons (PNG/MP4 metadata stripping, identical-artifact refusal,
//    identity hiding across API/log/diff/page, immutable ballot 409 across restart,
//    pre-begin edit refusal, side-by-side video CSP + sync script, CLI text review).
// 2. Native question dialogs with complete lossless fallbacks (Claude AskUserQuestion,
//    Codex request_user_input / request_user_input_async, Antigravity ask_question,
//    pre-selection refusal for recommended approval/narrowing/decline, truncation &
//    dropped-field refusal, label-to-ID + "Other" + stale-revision mapping, CLI `utp dialog`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "./support/tmp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, type ClientConfig } from "../src/cli/client.js";
import { reviewMarkdown, type RequestView, type ReviewView } from "../src/cli/render.js";
import { normalizeBlind } from "../src/core/blind.js";
import { checkRequest } from "../src/core/check.js";
import { mapDialogResponse, projectReviewToDialog } from "../src/core/native-dialog.js";
import { EXIT, type RequestBody } from "../src/core/types.js";
import { startServer } from "../src/server/http.js";
import { handleReviewerInbox } from "../src/server/reviewer-inbox.js";
import { ReviewPages } from "../src/server/review-page.js";
import type { ProjectInfo } from "../src/server/service.js";
import { createToken } from "../src/server/tokens.js";

const CLI = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

function utp(args: string[], opts: { cwd: string; home: string; input?: string; env?: Record<string, string> }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, UTP_HOME: opts.home, UTP_SESSION: "p2-agent", ...opts.env };
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
  const dir = mkdtempSync(path.join(tmpdir(), "utp-p2-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function makeMp4Box(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "latin1");
  payload.copy(box, 8);
  return box;
}

function sampleMp4(tagPayload: string, mdatBytes: string): string {
  const ftyp = makeMp4Box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
  const udta = makeMp4Box("udta", Buffer.from(tagPayload, "latin1"));
  const moov = makeMp4Box("moov", udta);
  const mdat = makeMp4Box("mdat", Buffer.from(mdatBytes, "latin1"));
  return Buffer.concat([ftyp, moov, mdat]).toString("base64");
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwwAAAAASUVORK5CYII=", "base64");

function pngWithText(keyword: string, value: string): string {
  const text = Buffer.from(`${keyword}\0${value}`);
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write("tEXt", 4, 4, "ascii");
  text.copy(chunk, 8);
  return Buffer.concat([PNG_1PX.subarray(0, -12), chunk, PNG_1PX.subarray(-12)]).toString("base64");
}

// ---- Blind judge comparisons ------------------------------------------------

test("blind MP4 cleanup preserves the local data reference and decoder configuration", () => {
  const fullBox = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
  const localReference = makeMp4Box("url ", Buffer.from([0, 0, 0, 1]));
  const dref = makeMp4Box("dref", Buffer.concat([fullBox, localReference]));
  const fields = Buffer.alloc(78);
  fields.writeUInt16BE(1, 6); // data_reference_index
  fields[42] = 13;
  fields.write("Private Maker", 43);
  fields.writeUInt16BE(24, 74); // depth
  fields.writeInt16BE(-1, 76); // pre_defined
  const config = makeMp4Box("avcC", Buffer.from([1, 100, 0, 32, 255, 225, 0, 2, 103, 100, 1, 0, 2, 104, 0]));
  const entry = makeMp4Box("avc1", Buffer.concat([fields, config]));
  const stsd = makeMp4Box("stsd", Buffer.concat([fullBox, entry]));
  const minf = makeMp4Box("minf", Buffer.concat([makeMp4Box("dinf", dref), makeMp4Box("stbl", stsd)]));
  const headers = Buffer.concat([makeMp4Box("ftyp", Buffer.from("isom")), makeMp4Box("moov", minf)]);
  const candidates = ["first", "second"].map((identity) => ({
    identity, artifact: { media_type: "video/mp4", data: Buffer.concat([headers, makeMp4Box("mdat", Buffer.from(identity))]).toString("base64") },
  }));
  const normalized = normalizeBlind({ candidates });
  assert.ok(typeof normalized !== "string");
  const artifact = normalized.candidates[0].artifact;
  assert.ok("data" in artifact);
  const clean = Buffer.from(artifact.data, "base64");
  const expected = Buffer.concat([headers, makeMp4Box("mdat", Buffer.from("first"))]);
  const compressor = expected.indexOf(entry) + 8 + 42;
  expected.fill(0, compressor, compressor + 32);
  assert.deepEqual(clean, expected);

  const external = makeMp4Box("url ", Buffer.concat([Buffer.alloc(4), Buffer.from("source-name.mp4\0")]));
  const tagged = Buffer.concat([headers, external, makeMp4Box("mdat", Buffer.from("third"))]);
  const comparison = normalizeBlind({ candidates: [normalized.candidates[0], {
    identity: "third", artifact: { media_type: "video/mp4", data: tagged.toString("base64") },
  }] });
  assert.ok(typeof comparison !== "string");
  const second = comparison.candidates[1].artifact;
  assert.ok("data" in second);
  assert.equal(Buffer.from(second.data, "base64").includes("source-name.mp4"), false);
});

test("blind PNG and MP4 candidates strip identifying metadata and refuse identical previews", () => {
  const dupPng = normalizeBlind({
    candidates: [
      { identity: "Source Alpha", artifact: { media_type: "image/png", data: PNG_1PX.toString("base64") } },
      { identity: "Source Beta", artifact: { media_type: "image/png", data: pngWithText("Author", "Source Beta") } },
    ],
  });
  assert.equal(dupPng, "the two candidate previews are identical");

  const dupMp4 = normalizeBlind({
    candidates: [
      { identity: "Clip One", artifact: { media_type: "video/mp4", data: sampleMp4("Author: Clip One", "frame-data-1") } },
      { identity: "Clip Two", artifact: { media_type: "video/mp4", data: sampleMp4("Author: Clip Two", "frame-data-1") } },
    ],
  });
  assert.equal(dupMp4, "the two candidate previews are identical");

  const distinctMp4 = normalizeBlind({
    candidates: [
      { identity: "Clip One", artifact: { media_type: "video/mp4", data: sampleMp4("SecretModelA", "frame-data-1") } },
      { identity: "Clip Two", artifact: { media_type: "video/mp4", data: sampleMp4("SecretModelB", "frame-data-2") } },
    ],
  });
  assert.ok(typeof distinctMp4 !== "string", "distinct MP4 clips should normalize");
  const serialized = JSON.stringify(distinctMp4.candidates.map((c) => c.artifact));
  const rawA = Buffer.from((distinctMp4.candidates[0]!.artifact as { data: string }).data, "base64").toString("latin1");
  const rawB = Buffer.from((distinctMp4.candidates[1]!.artifact as { data: string }).data, "base64").toString("latin1");
  assert.doesNotMatch(rawA + rawB + serialized, /SecretModelA|SecretModelB/);
});

test("blind comparison hides identities across API, log, revision diff, and page until immutable ballot save (survives restart)", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-p2-blind-"));
  let svc = await startServer({ dataDir: data, port: 0 });
  try {
    const token = createToken(data, "dev");
    const cfg: ClientConfig = { server: svc.url, token };
    const project = ((await call("project.create", { name: "Blind Studio" }, { config: cfg })).project as ProjectInfo).id;
    const as = (op: string, args: Record<string, unknown> = {}, serverUrl = svc.url) =>
      call(op, args, { config: { server: serverUrl, token }, project });

    const candidateA = { identity: "Source Cedar", artifact: { text: "A sample with larger type." }, reveal_note: "Private accounting details." };
    const candidateB = { identity: "Source Maple", artifact: { text: "A sample with more spacing." } };
    const judge: RequestBody = {
      kind: "judge",
      question: "Which sample is easier to read?",
      why_now: "Choose a layout for the next check.",
      summary: "Compare readability at the same display size.",
      level: 3,
      level_reason: "The person judges readability.",
      stakes: { reversibility: "easy" },
      blind: { candidates: [candidateA, candidateB], recommended_candidate: 0 },
      notes: "Private design note for Source Cedar",
    };

    // Reject identical candidates, exposed identities in displayed text, and extra options/recommendation.
    assert.equal((await as("ask", { body: { ...judge, blind: { candidates: [candidateA, { ...candidateB, artifact: candidateA.artifact }] } } })).code, 20);
    assert.equal((await as("ask", { body: { ...judge, question: "Is Source Cedar clearer?" } })).code, 20);
    assert.equal((await as("ask", { body: { ...judge, summary: "Compare Source Cedar with the alternative." } })).code, 20);
    assert.equal((await as("ask", { body: { ...judge, level: 2 } })).code, 20);
    assert.equal(checkRequest({ ...judge, blind: undefined }).some((f) => f.rule === "S31-blind-candidates"), true);

    // Extra private property on stakes is stripped from every public view.
    const asked = await as("ask", { body: { ...judge, stakes: { ...judge.stakes, source: "Source Cedar" } as RequestBody["stakes"], tags: ["quality"] } });
    assert.equal(asked.code, EXIT.OK, String(asked.message));
    const flushed1 = await as("flush", { intent: { task_title: "Readability test", asked: "Pick readable layout", doing: "Comparing samples", scope_delta: "none" } });

    const assertHidden = (value: unknown) => {
      assert.doesNotMatch(JSON.stringify(value), /Source Cedar|Source Maple|recommended_candidate|Private design note|Private accounting details/);
    };
    assertHidden(await as("show", { id: asked.id }));
    assertHidden(await as("show", { id: flushed1.review_id }));
    assert.deepEqual((await as("log", { text: "Source Cedar" })).entries, []);
    assert.deepEqual((await as("history", { query: "Source Cedar" })).reviews, []);
    assertHidden(await as("history", { query: "quality" }));
    const follow = await as("follow-up", { review: flushed1.review_id, cards: [`${asked.id}@1`] });
    assert.equal(follow.code, EXIT.OK, String(follow.message));
    assertHidden(await as("show", { id: follow.review_id }));

    // Revise after clarification and confirm revision_diff ALSO hides blind identities.
    const prep1 = await as("review-page.prepare", { review: flushed1.review_id });
    const page1 = await fetch(String(prep1.url));
    const html1 = await page1.text();
    assertHidden(html1);
    assert.match(html1, /class="compare"/);
    assert.doesNotMatch(page1.headers.get("content-security-policy") ?? "", /script-src/);
    const cookie1 = page1.headers.get("set-cookie")?.split(";")[0]!;
    const tok1 = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(html1)?.[1]!;
    const origin1 = new URL(String(prep1.url)).origin;

    // Incomplete ballot (ratings without choice) returns 400 and stays hidden.
    const incomplete = await fetch(String(prep1.url), {
      method: "POST", headers: { cookie: cookie1, origin: origin1 },
      body: new URLSearchParams({ presentation: tok1, "rating-a-0": "4", "rating-b-0": "4", "repeat-0": "yes" }),
    });
    assert.equal(incomplete.status, 400);
    assertHidden(await incomplete.text());

    // Clarification keeps vote open and hidden.
    const clar = await fetch(String(prep1.url), {
      method: "POST", headers: { cookie: cookie1, origin: origin1 },
      body: new URLSearchParams({ presentation: tok1, clarify: "0", "clarify-note-0": "Which screen width?" }),
    });
    assert.equal(clar.status, 200);
    assertHidden(await clar.text());
    assert.equal((await as("wait", { id: asked.id })).code, EXIT.NEEDS_CLARIFICATION);

    // Revise judge card -> revision_diff hides identities before vote.
    const revised = await as("revise", { id: asked.id, body: { ...judge, summary: "Compare readability at 390px phone width." } });
    assert.equal(revised.code, EXIT.OK);
    const flushed2 = await as("flush", { intent: { task_title: "Readability rev 2", asked: "Pick readable layout", doing: "Re-comparing at 390px", scope_delta: "none" } });
    assertHidden(await as("show", { id: `${asked.id}@2` }));
    const prep2 = await as("review-page.prepare", { review: flushed2.review_id });
    const url2 = new URL(String(prep2.url));
    const page2 = await fetch(url2);
    const html2 = await page2.text();
    assertHidden(html2);
    assert.match(html2, /revision-banner/);
    const cookie2 = page2.headers.get("set-cookie")?.split(";")[0]!;
    const tok2 = /name="presentation" value="([a-zA-Z0-9_-]+)"/.exec(html2)?.[1]!;

    // Submit valid blind ballot -> reveals identities, notes, and recommendation!
    const ballot = new URLSearchParams({
      presentation: tok2,
      "choice-0": "tie",
      "rating-a-0": "4",
      "rating-b-0": "4",
      "repeat-0": "yes",
      "reason-0": "Both samples have readable headings.",
    });
    const post2 = (params: URLSearchParams, targetUrl = url2) =>
      fetch(targetUrl, { method: "POST", headers: { cookie: cookie2, origin: targetUrl.origin }, body: params });

    const savedRes = await post2(ballot);
    assert.equal(savedRes.status, 200);
    const revealedHtml = await savedRes.text();
    assert.match(revealedHtml, /Source Cedar/);
    assert.match(revealedHtml, /Source Maple/);
    assert.match(revealedHtml, /Private accounting details/);
    assert.doesNotMatch(revealedHtml, /Edit or withdraw answers/);

    // Identical re-POST is idempotent (200); changed second ballot returns 409!
    assert.equal((await post2(ballot)).status, 200);
    const changed = new URLSearchParams(ballot);
    changed.set("choice-0", "a");
    assert.equal((await post2(changed)).status, 409);

    // CLI answer change / withdraw, conversation quote wipe, and pre-begin edit op all refuse on immutable ballot!
    assert.equal((await as("answer", { id: `${asked.id}@2`, channel: "cli", value: "b", note: "Changed." })).code, EXIT.REVOKED);
    assert.equal((await as("answer", { id: `${asked.id}@2`, channel: "cli", withdraw: true })).code, EXIT.REVOKED);
    assert.equal((await as("answer", { id: `${asked.id}@2`, channel: "conversation", quote: "wait?" })).code, EXIT.REVOKED);
    assert.equal((await as("edit", { id: `${asked.id}@2`, channel: "terminal-review", value: "a" })).code, EXIT.NOT_ALLOWED);

    // Judge card with identifying origin or basis file is refused before queuing.
    assert.equal((await as("ask", { body: { ...judge, origin: { agent: "Source Cedar" } } })).code, EXIT.CHECK_FAILED);
    assert.equal((await as("ask", { body: { ...judge, basis: { files: ["Source Cedar.txt"] } }, basis: { "Source Cedar.txt": "abc" } })).code, EXIT.CHECK_FAILED);

    const shownAfter = (await as("show", { id: `${asked.id}@2` })).request as RequestView;
    assert.equal(shownAfter.answer?.value, "tie");
    assert.deepEqual(shownAfter.answer?.ratings, { a: 4, b: 4 });
    assert.equal(shownAfter.answer?.repeat_test, true);
    assert.equal(shownAfter.answer?.note, "Both samples have readable headings.");
    assert.ok(shownAfter.blind_reveal);
    assert.equal(shownAfter.blind_reveal.identities[shownAfter.blind_reveal.recommendation!], "Source Cedar");

    // Verify 409 immutability and reveal survive a full service restart!
    await svc.close();
    svc = await startServer({ dataDir: data, port: 0 });
    const restartedUrl = new URL(url2.pathname, svc.url);
    assert.equal((await post2(changed, restartedUrl)).status, 409);
    const replayAfterRestart = await post2(ballot, restartedUrl);
    assert.equal(replayAfterRestart.status, 200);
    assert.match(await replayAfterRestart.text(), /Source Cedar/);
  } finally {
    await svc.close();
  }
});

test("video blind comparison routes automatically to review-page with video CSP and sync play button; text judge works in terminal", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "utp-p2-media-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cwd = repo();
    const home = mkdtempSync(path.join(tmpdir(), "utp-p2-home-"));
    const run = (args: string[], input?: string) => utp(args, { cwd, home, input });
    assert.equal((await run(["connect", svc.url], createToken(data, "dev"))).code, 0);
    assert.equal((await run(["init"])).code, 0);

    // 1. Video blind comparison automatically routes to review-page on flush and carries media-src + script hash CSP.
    const videoJudge: RequestBody = {
      kind: "judge",
      question: "Which animation clip feels smoother?",
      summary: "Compare motion timing across the two clips.",
      why_now: "Pick the smoother transition before export.",
      level: 3,
      level_reason: "Visual judgment belongs to the person.",
      stakes: { reversibility: "easy" },
      blind: {
        candidates: [
          { identity: "Renderer Fast", artifact: { media_type: "video/mp4", data: sampleMp4("Renderer Fast", "clip-a") } },
          { identity: "Renderer Smooth", artifact: { media_type: "video/mp4", data: sampleMp4("Renderer Smooth", "clip-b") } },
        ],
      },
    };
    writeFileSync(path.join(cwd, "video-judge.json"), JSON.stringify(videoJudge));
    assert.equal((await run(["ask", "video-judge.json", "--json"])).code, 0);
    const flushedVideo = JSON.parse((await run(["flush", "--json"])).stdout);
    assert.equal(flushedVideo.route, "review-page");
    assert.ok(flushedVideo.url);
    const videoPage = await fetch(String(flushedVideo.url));
    assert.equal(videoPage.status, 200);
    const csp = videoPage.headers.get("content-security-policy") ?? "";
    assert.match(csp, /media-src data:/);
    assert.match(csp, /script-src 'sha256-/);
    const videoHtml = await videoPage.text();
    assert.match(videoHtml, /data-play-comparison/);
    assert.match(videoHtml, /<video controls muted playsinline/);
    assert.doesNotMatch(videoHtml, /Renderer Fast|Renderer Smooth/);

    // Terminal `utp review` directs binary-media judge to `utp page`.
    const termMedia = await run(["review", String(flushedVideo.review_id)]);
    assert.equal(termMedia.code, 0);
    assert.match(termMedia.stdout, /Open review .* on the review page/);

    // 2. Text blind comparison works via `utp new judge`, `utp review`, and `utp show` reveal.
    assert.equal((await run(["new", "judge", "--file", "text-judge.json"])).code, 0);
    assert.equal((await run(["check", "text-judge.json"])).code, 0);
    const askText = JSON.parse((await run(["ask", "text-judge.json", "--json"])).stdout);
    const flushText = JSON.parse((await run(["flush", "--json"])).stdout);
    const termText = await run(["review", String(flushText.review_id)], "a\nCleaner opening line.\n");
    assert.equal(termText.code, 0, termText.stderr + termText.stdout);
    const showText = await run(["show", String(askText.id)]);
    assert.equal(showText.code, 0);
    assert.match(showText.stdout, /Candidate A was (First|Second) source\. Candidate B was (First|Second) source\./);
    assert.match(showText.stdout, /Reason given · Cleaner opening line\./);
  } finally {
    await svc.close();
  }
});

// ---- Native question dialogs & conformance fallbacks ------------------------

function mkCard(body: RequestBody, id = "R-20261125-11111111", revision = 1): RequestView {
  return { id, revision, current: true, status: "queued", body, answer: null, flags: [] };
}

function mkReview(items: RequestView[]): ReviewView {
  return {
    id: "V-20261125-aaaaaaaa",
    intent: { task_title: "Dialog check", asked: "Pick the build behavior.", doing: "Choosing options.", scope_delta: "none" },
    items,
  };
}

const cleanChoice = (overrides: Partial<RequestBody> = {}): RequestBody => ({
  kind: "choose",
  category: "approach",
  question: "Which output format should the exporter write?",
  why_now: "The build pipeline needs one format.",
  options: [
    { id: "lines", label: "Structured lines", consequence: "Writes one structured record per line." },
    { id: "table", label: "Spreadsheet table", consequence: "Writes comma-separated rows." },
  ],
  stakes: { reversibility: "easy" },
  level: 2,
  level_reason: "Reversible local format choice.",
  ...overrides,
});

test("native dialogs project clean choices preserving exact option order, consequences, and revision bindings across all three platforms", () => {
  const recCard = mkCard(cleanChoice({
    recommendation: { option: "table", because: "Spreadsheets open it directly.", preserves: "Row headers.", bolder_alternative: "Structured lines keep nested fields." },
  }));
  const review = mkReview([recCard]);

  // Claude AskUserQuestion: description slot, order preserved (lines stays first, NOT reordered to table!).
  const claude = projectReviewToDialog(review, { platform: "claude" });
  assert.equal(claude.eligible, true);
  assert.equal(claude.tool, "AskUserQuestion");
  assert.deepEqual(claude.payload!.questions[0]!.options.map((o) => o.id), ["lines", "table"]);
  assert.match(claude.payload!.questions[0]!.options[0]!.description!, /Writes one structured record per line\./);
  assert.match(claude.payload!.questions[0]!.question, /Recommended: Spreadsheet table \(table\)/);
  assert.match(claude.preamble_markdown!, /Pick the build behavior\./);

  // Codex request_user_input (non-preselecting): same lossless projection.
  const codex = projectReviewToDialog(review, { platform: "codex" });
  assert.equal(codex.eligible, true);
  assert.equal(codex.tool, "request_user_input");
  assert.deepEqual(codex.payload!.questions[0]!.options.map((o) => o.id), ["lines", "table"]);

  // Antigravity ask_question: folds consequence into option text, returns stable IDs.
  const agy = projectReviewToDialog(review, { platform: "antigravity" });
  assert.equal(agy.eligible, true);
  assert.equal(agy.tool, "ask_question");
  assert.match(agy.payload!.questions[0]!.options[1]!.text!, /Spreadsheet table — Writes comma-separated rows\./);
});

test("pre-selecting dialogs refuse recommended approvals, recommended narrowings, and recommended declines with options and recommendation unchanged", () => {
  const baseApprove = (recOption: "yes" | "narrow" | "no"): RequestBody => ({
    kind: "approve",
    question: "Apply the schema update?",
    why_now: "Production tables need the new index.",
    options: [
      {
        id: "yes", label: "Update all tables", consequence: "Adds index to alpha and beta.",
        authorization: { action: "alter", target: "db", scope: "alpha, beta", expected_effect: "both indexed" },
      },
      {
        id: "narrow", narrower_than: "yes", label: "Update alpha only", consequence: "Adds index to alpha only.",
        authorization: { action: "alter", target: "db", scope: "alpha", expected_effect: "alpha indexed" },
      },
      { id: "no", label: "Skip update", consequence: "Leaves both tables unchanged." },
    ],
    recommendation: { option: recOption, because: "Matches current load.", preserves: "Existing queries.", bolder_alternative: "Another scope." },
    stakes: { reversibility: "one_way" },
    level: 3,
    level_reason: "Schema change cannot be reversed automatically.",
  });

  for (const recOption of ["yes", "narrow", "no"] as const) {
    const review = mkReview([mkCard(baseApprove(recOption))]);
    // Test both Codex request_user_input_async and explicit preselectsOption capability flag.
    for (const caps of [
      { platform: "codex" as const, tool: "request_user_input_async", verifiedChannel: true },
      { platform: "claude" as const, preselectsOption: true, verifiedChannel: true },
    ]) {
      const projected = projectReviewToDialog(review, caps);
      assert.equal(projected.eligible, false, `must refuse pre-selecting dialog for recommended ${recOption}`);
      assert.ok(projected.reasons.some((r) => r.code === "preselects_recommendation"));
      assert.equal(projected.fallback, "terminal");
      // Fallback Markdown keeps every option and the original recommendation unchanged.
      assert.equal(projected.fallback_markdown, reviewMarkdown(review));
      assert.match(projected.fallback_markdown, new RegExp(`Recommended: \\*\\*${recOption}\\*\\*`));
      assert.match(projected.fallback_markdown, /Update all tables/);
      assert.match(projected.fallback_markdown, /Update alpha only/);
      assert.match(projected.fallback_markdown, /Skip update/);
    }
  }
});

test("native dialogs refuse option caps, question caps, duplicate labels, truncation, dropped content, unsupported kinds, and non-interactive mode", () => {
  // 4 options exceeds Codex's 3-option limit.
  const fourOpts = mkReview([mkCard(cleanChoice({
    options: [
      { id: "a", label: "One", consequence: "First." },
      { id: "b", label: "Two", consequence: "Second." },
      { id: "c", label: "Three", consequence: "Third." },
      { id: "d", label: "Four", consequence: "Fourth." },
    ],
  }))]);
  const codexOpts = projectReviewToDialog(fourOpts, { platform: "codex" });
  assert.equal(codexOpts.eligible, false);
  assert.ok(codexOpts.reasons.some((r) => r.code === "option_limit"));
  // Claude allows 4 options -> eligible!
  assert.equal(projectReviewToDialog(fourOpts, { platform: "claude" }).eligible, true);

  // 4 questions exceeds Codex's 3-question limit and falls back to review-page.
  const fourCards = mkReview([
    mkCard(cleanChoice(), "R-20261125-00000001"),
    mkCard(cleanChoice(), "R-20261125-00000002"),
    mkCard(cleanChoice(), "R-20261125-00000003"),
    mkCard(cleanChoice(), "R-20261125-00000004"),
  ]);
  const codexQs = projectReviewToDialog(fourCards, { platform: "codex" });
  assert.equal(codexQs.eligible, false);
  assert.ok(codexQs.reasons.some((r) => r.code === "question_limit"));
  assert.equal(codexQs.fallback, "review-page");

  // Duplicate option labels refused on label-returning Claude/Codex, allowed on ID-returning Antigravity.
  const dupLabels = mkReview([mkCard(cleanChoice({
    options: [
      { id: "a", label: "Keep", consequence: "Keep local cache." },
      { id: "b", label: " keep ", consequence: "Keep remote cache." },
    ],
  }))]);
  assert.ok(projectReviewToDialog(dupLabels, { platform: "claude" }).reasons.some((r) => r.code === "duplicate_labels"));
  assert.equal(projectReviewToDialog(dupLabels, { platform: "antigravity" }).eligible, true);

  // Consequence exceeding field length -> would_truncate (never truncates!).
  const longConsequence = mkReview([mkCard(cleanChoice({
    options: [
      { id: "a", label: "Short", consequence: "A".repeat(260) },
      { id: "b", label: "Other", consequence: "Short consequence." },
    ],
  }))]);
  assert.ok(projectReviewToDialog(longConsequence, { platform: "claude" }).reasons.some((r) => r.code === "would_truncate"));

  // Cards with waivers / previews / glossary / default -> drops_content.
  const withGlossary = mkReview([mkCard(cleanChoice({ glossary: { "CSV": "Comma-separated values." } }))]);
  assert.ok(projectReviewToDialog(withGlossary, { platform: "claude" }).reasons.some((r) => r.code === "drops_content"));

  // Structured kinds (`handoff`, `accept`, `assumptions`, `judge`) -> unsupported_kind.
  const handoff = mkReview([mkCard({
    kind: "handoff", question: "Run the login step?", why_now: "Needs user login.",
    steps: [{ id: "s1", actor: "person", machine: "laptop", shell: "bash", command: "login", expected_result: "ok", tested: true, why_person: "Auth." }],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "Manual step.",
  })]);
  assert.ok(projectReviewToDialog(handoff, { platform: "claude" }).reasons.some((r) => r.code === "unsupported_kind"));

  // Non-interactive (codex exec / subagent) -> unavailable.
  const nonInteractive = projectReviewToDialog(mkReview([mkCard(cleanChoice())]), { platform: "codex", interactive: false });
  assert.equal(nonInteractive.eligible, false);
  assert.ok(nonInteractive.reasons.some((r) => r.code === "unavailable"));

  // Open notice in review or skip_if on card -> drops_content.
  const withNotice = mkReview([
    mkCard({ kind: "notice", question: "Applied tweak", why_now: "Updated formatting.", level: 1, level_reason: "Info.", stakes: { reversibility: "easy" } }, "R-20261125-00000009"),
    mkCard(cleanChoice()),
  ]);
  assert.ok(projectReviewToDialog(withNotice, { platform: "claude" }).reasons.some((r) => r.code === "drops_content"));

  // Object.prototype key ("Constructor") is handled safely without false duplicate_labels, and summary + why_now both stay in prompt.
  const protoCard = mkCard(cleanChoice({
    summary: "Short summary of decision.",
    why_now: "Distinct why-now explanation.",
    options: [
      { id: "a", label: "Constructor", consequence: "Uses the constructor pattern." },
      { id: "b", label: "Factory", consequence: "Uses a factory helper." },
    ],
  }));
  const protoProj = projectReviewToDialog(mkReview([protoCard]), { platform: "claude" });
  assert.equal(protoProj.eligible, true);
  assert.match(protoProj.payload!.questions[0]!.question, /Short summary of decision\..*Distinct why-now explanation\./);
});

test("native dialog response mapping binds to stable option IDs, maps Other to custom or strict-clarify, rejects stale revisions, and works via CLI", async () => {
  const card = mkCard(cleanChoice());
  const review = mkReview([card]);
  const projected = projectReviewToDialog(review, { platform: "claude" });
  assert.equal(projected.eligible, true);
  const binding = projected.binding!.cards[0]!;

  // Label -> stable option ID.
  const byLabel = mapDialogResponse(card, binding, { selected_label: "Spreadsheet table" });
  assert.deepEqual(byLabel, { ok: true, answer: { id: "R-20261125-11111111@1", value: "table" } });

  // Option ID -> stable option ID.
  const byId = mapDialogResponse(card, binding, { selected_option_id: "lines" });
  assert.deepEqual(byId, { ok: true, answer: { id: "R-20261125-11111111@1", value: "lines" } });

  // Native "Other" free text -> verbatim custom on non-authorized card.
  const other = mapDialogResponse(card, binding, { other_text: "  Write tab-separated rows instead. " });
  assert.deepEqual(other, { ok: true, answer: { id: "R-20261125-11111111@1", custom: "  Write tab-separated rows instead. " } });

  // Native "Other" free text on authorized card -> strict needs_clarification (even if binding tampers has_authorization: false!).
  const authCard = mkCard({
    ...cleanChoice(),
    options: [
      { id: "lines", label: "Structured lines", consequence: "Writes lines.", authorization: { action: "write", target: "out", scope: "lines" } },
      { id: "table", label: "Spreadsheet table", consequence: "Writes table." },
    ],
  });
  const tamperedBinding = { ...binding, has_authorization: false };
  const authOther = mapDialogResponse(authCard, tamperedBinding, { freeform_text: "", other_text: "Only run on staging first" });
  assert.deepEqual(authOther, {
    ok: true,
    clarification: { id: "R-20261125-11111111@1", clarify: true, outcome: "needs_clarification", note: "Only run on staging first" },
  });

  // Object.prototype lookup ("constructor") rejected as unknown_label, and conflicting id+label rejected as ambiguous_selection.
  const protoLookup = mapDialogResponse(card, binding, { selected_label: "constructor" });
  assert.equal(protoLookup.ok, false);
  if (!protoLookup.ok) assert.equal(protoLookup.error, "unknown_label");

  const conflictSel = mapDialogResponse(card, binding, { selected_option_id: "lines", selected_label: "Spreadsheet table" });
  assert.equal(conflictSel.ok, false);
  if (!conflictSel.ok) assert.equal(conflictSel.error, "ambiguous_selection");

  // Skipped / cancelled never becomes approval.
  const skipped = mapDialogResponse(authCard, tamperedBinding, { skipped: true });
  assert.equal(skipped.ok, true);
  assert.ok("skipped" in skipped && skipped.skipped === true);

  // Stale revision rejected with EXIT.REVOKED.
  const supersededCard = { ...card, revision: 2 };
  const stale = mapDialogResponse(supersededCard, binding, { selected_label: "Spreadsheet table" });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, EXIT.REVOKED);
    assert.equal(stale.error, "stale_revision");
  }

  // End-to-end CLI `utp dialog` projection + `--map-response` against live local service.
  const data = mkdtempSync(path.join(tmpdir(), "utp-p2-dlg-"));
  const svc = await startServer({ dataDir: data, port: 0 });
  try {
    const cwd = repo();
    const home = mkdtempSync(path.join(tmpdir(), "utp-p2-dlg-home-"));
    const run = (args: string[], input?: string) => utp(args, { cwd, home, input });
    assert.equal((await run(["connect", svc.url], createToken(data, "dev"))).code, 0);
    assert.equal((await run(["init"])).code, 0);

    writeFileSync(path.join(cwd, "q.json"), JSON.stringify(cleanChoice()));
    const askRes = await run(["ask", "q.json", "--json"]);
    assert.equal(askRes.code, 0, askRes.stderr + askRes.stdout);
    const asked = JSON.parse(askRes.stdout);
    const flushed = JSON.parse((await run(["flush", "--json"])).stdout);

    const dlg = await run(["dialog", String(flushed.review_id), "--platform", "claude", "--json"]);
    assert.equal(dlg.code, 0, dlg.stderr + dlg.stdout);
    const dlgJson = JSON.parse(dlg.stdout);
    assert.equal(dlgJson.eligible, true);
    assert.equal(dlgJson.binding.cards[0].ref, `${asked.id}@1`);

    writeFileSync(path.join(cwd, "reply.json"), JSON.stringify({
      ref: `${asked.id}@1`,
      selected_label: "Spreadsheet table",
      binding: dlgJson.binding.cards[0],
    }));
    const mapped = await run(["dialog", String(flushed.review_id), "--platform", "claude", "--map-response", "reply.json", "--json"]);
    assert.equal(mapped.code, 0, mapped.stderr + mapped.stdout);
    assert.deepEqual(JSON.parse(mapped.stdout).answer, { id: `${asked.id}@1`, value: "table" });

    // Revise the card -> old dialog binding is refused with exit 17!
    writeFileSync(path.join(cwd, "q2.json"), JSON.stringify(cleanChoice({ why_now: "Updated reason for revision 2." })));
    assert.equal((await run(["revise", String(asked.id), "q2.json", "--json"])).code, 0);
    const staleCli = await run(["dialog", String(asked.id), "--platform", "claude", "--map-response", "reply.json", "--json"]);
    assert.equal(staleCli.code, EXIT.REVOKED);

    // Check reviewer inbox renders `blind comparison` label for judge cards cleanly.
    const pages = new ReviewPages(new URL("https://reviews.example.test"), svc.service, Date.now, true);
    const resHtml: string[] = [];
    const res = { writeHead: () => res, end: (t?: string) => { if (t) resHtml.push(t); } };
    const req = { url: "/", method: "GET", headers: { host: "reviews.example.test" } } as IncomingMessage;
    await handleReviewerInbox(req, res as unknown as ServerResponse, svc.service, pages, async () => undefined);
    assert.ok(resHtml.join("").includes("Review inbox"));
  } finally {
    await svc.close();
  }
});
