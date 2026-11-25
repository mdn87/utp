import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fieldStart = "2030-01-01T00:00:00Z";

function card(id: number, review: string, changes: Record<string, unknown> = {}) {
  return {
    request: `card-${id}`, firstAsked: `2030-01-${String(id).padStart(2, "0")}T12:00:00Z`,
    review, kind: "clarify", questionFingerprint: `wording-${id}`, waiverCountsByRevision: [0], ...changes,
  };
}

function review(id: string, changes: Record<string, unknown> = {}) {
  return { review: id, status: "prepared", presentations: ["review-page"], pushReceipts: 1, ...changes };
}

function report(requests: object[], reviews: object[], taskCount = 2) {
  const run = spawnSync(process.execPath, ["scripts/phase1-field-counts.mjs"], {
    input: JSON.stringify({ requests, reviews, fieldStart, taskCount }), encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("an additional review contributes its cards, rating and receipt once", () => {
  const requests = [
    card(1, "first"), card(2, "first"), card(3, "first"), card(4, "second"),
    card(5, "third", { feedback: "clear", activeCardMs: 0 }),
    card(6, "third", { kind: "notice" }), card(7, "digest", { kind: "notice" }),
  ];
  const reviews = [
    review("first", { pageSaves: [3] }), review("second"),
    review("third", { presentations: ["review-page", "review-page"], pageSaves: [1], activePageMs: 550 }),
    review("digest", { presentations: ["morning-report-inbox"], pushReceipts: 0 }),
  ];
  const { AC1, AC3, AC4 } = report(requests, reviews);
  assert.equal(AC1.postActivationRequests, 7);
  assert.equal(AC3.questionCards, 5);
  assert.equal(AC3.questionReviewsFlushed, 3);
  assert.equal(AC3.questionReviewsPresented, 3);
  assert.equal(AC3.noticeOnlyReviewsPresented, 1);
  assert.equal(AC3.allReviewsPresentedPerTask, 2);
  assert.equal(AC3.pushReceipts, 3);
  assert.equal(AC3.duplicateQuestions, 0);
  assert.deepEqual(AC3.clarity, { cardsRated: 1, clear: 1, clearPercent: 100, targetPercent: 80 });
  assert.deepEqual(AC3.cardActiveResponseMs, [0]);
  assert.deepEqual(AC3.pageActiveResponseMs, [550]);
  assert.deepEqual(AC4, { largestPostActivationQuestionBatch: 3, verifiedPageSavesOfThreeOrMore: 1 });
});

test("repeated wording, low clarity and missing delivery evidence stay visible", () => {
  const { AC3, AC4 } = report([card(1, "one", { feedback: "needed_more" }), card(2, "two", { questionFingerprint: "wording-1" })], [
    review("one", { pushReceipts: undefined }), review("two", { status: "open", presentations: [], pushReceipts: 0 }),
  ]);
  assert.equal(AC3.questionCards, 2);
  assert.equal(AC3.questionReviewsFlushed, 1);
  assert.equal(AC3.questionReviewsPresented, 1);
  assert.equal(AC3.repeatedQuestionTexts, 1);
  assert.equal(AC3.duplicateQuestions, null);
  assert.equal(AC3.clarity.clearPercent, 0);
  assert.equal(AC3.pushReceipts, null);
  assert.equal(AC4.largestPostActivationQuestionBatch, 1);
});

test("a notice-only sample has no question batches or clarity percentage", () => {
  const { AC3, AC4 } = report([card(1, "digest", { kind: "notice" })],
    [review("digest", { presentations: ["morning-report-inbox"], pushReceipts: 0 })]);
  assert.equal(AC3.noticeOnlyReviewsPresented, 1);
  assert.equal(AC3.questionReviewsFlushed, 0);
  assert.equal(AC3.pushReceipts, 0);
  assert.equal(AC3.clarity.clearPercent, null);
  assert.deepEqual(AC4, { largestPostActivationQuestionBatch: 0, verifiedPageSavesOfThreeOrMore: 0 });
});

test("only the first fifteen eligible requests contribute waivers while later field reviews still count", () => {
  const requests = Array.from({ length: 17 }, (_, i) => card(i + 1, "questions", {
    waiverCountsByRevision: i === 1 || i === 16 ? [0, 1] : [0],
  })).reverse();
  requests.push(card(18, "archive", { historicalBackfill: true, firstAsked: "2029-01-01T00:00:00Z" }));
  const { AC1, AC3 } = report(requests, [review("questions"), review("archive")]);
  assert.deepEqual(AC1, {
    eligibleUniqueRequests: 15, targetRequests: 15, requestsWithWaivers: 1, revisionsChecked: 16,
    postActivationRequests: 17, historicalEntriesExcluded: 1,
  });
  assert.equal(AC3.questionCards, 17);
});
