// Read an anonymized field snapshot, fieldStart (UTC) and verified taskCount as
// one JSON object on stdin. Only aggregate measurements go to stdout.
import { readFileSync } from "node:fs";

const { requests, reviews, fieldStart, taskCount } = JSON.parse(readFileSync(0, "utf8"));
const start = Date.parse(fieldStart);
if (!Number.isFinite(start) || !Number.isSafeInteger(taskCount) || taskCount < 0) {
  throw new Error("Supply the field start time and the number of verified tasks.");
}
if (new Set(requests.map(row => row.request)).size !== requests.length ||
    new Set(reviews.map(row => row.review)).size !== reviews.length) {
  throw new Error("The snapshot must contain one record per request and per review.");
}

const eligible = requests.filter(row => !row.historicalBackfill)
  .sort((a, b) => Date.parse(a.firstAsked) - Date.parse(b.firstAsked));
const first = eligible.slice(0, 15);
const field = eligible.filter(row => Date.parse(row.firstAsked) >= start);
const questions = field.filter(row => row.kind !== "notice");
const fieldReviewIds = new Set(field.map(row => row.review));
const fieldReviews = reviews.filter(row => fieldReviewIds.has(row.review));
if (fieldReviews.length !== fieldReviewIds.size) throw new Error("A field request is missing its review.");

const questionsPerReview = new Map();
for (const question of questions) {
  questionsPerReview.set(question.review, (questionsPerReview.get(question.review) ?? 0) + 1);
}
const questionReviews = fieldReviews.filter(review => questionsPerReview.has(review.review));
const flushed = questionReviews.filter(review => review.status === "prepared");
const presented = fieldReviews.filter(review => review.presentations.length > 0);
const presentedQuestions = presented.filter(review => questionsPerReview.has(review.review));
const ratings = questions.map(row => row.feedback).filter(Boolean);
const clear = ratings.filter(rating => rating === "clear").length;
const clearPercent = ratings.length ? Math.round(1000 * clear / ratings.length) / 10 : null;
const repeats = questions.length - new Set(questions.map(row => row.questionFingerprint)).size;
const hasReceipts = fieldReviews.every(review => Number.isSafeInteger(review.pushReceipts) && review.pushReceipts >= 0);

const counts = {
  AC1: {
    eligibleUniqueRequests: first.length,
    targetRequests: 15,
    requestsWithWaivers: first.filter(row => row.waiverCountsByRevision.some(count => count > 0)).length,
    revisionsChecked: first.reduce((sum, row) => sum + row.waiverCountsByRevision.length, 0),
    postActivationRequests: field.length,
    historicalEntriesExcluded: requests.length - eligible.length,
  },
  AC3: {
    tasks: taskCount,
    clarity: { cardsRated: ratings.length, clear, clearPercent, targetPercent: 80 },
    questionCards: questions.length,
    repeatedQuestionTexts: repeats,
    // Repeated wording can refer to a decision whose terms changed.
    duplicateQuestions: repeats ? null : 0,
    questionReviewsFlushed: flushed.length,
    questionReviewsPresented: presentedQuestions.length,
    noticeOnlyReviewsPresented: presented.length - presentedQuestions.length,
    allReviewsPresentedPerTask: taskCount ? presented.length / taskCount : null,
    pushReceipts: hasReceipts ? fieldReviews.reduce((sum, review) => sum + review.pushReceipts, 0) : null,
    cardActiveResponseMs: field.map(row => row.activeCardMs).filter(ms => ms != null),
    pageActiveResponseMs: fieldReviews.map(review => review.activePageMs).filter(ms => ms != null),
  },
  AC4: {
    largestPostActivationQuestionBatch: flushed.reduce((max, review) => Math.max(max, questionsPerReview.get(review.review)), 0),
    verifiedPageSavesOfThreeOrMore: flushed.flatMap(review => review.pageSaves ?? []).filter(size => size >= 3).length,
  },
};
process.stdout.write(JSON.stringify(counts) + "\n");
