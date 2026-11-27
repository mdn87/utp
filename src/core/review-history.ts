import type { RequestBody } from "./types.js";

export interface HistoryCard {
  ref: string;
  question: string;
  tags: string[];
  status: string;
  answer?: string;
  option_id?: string;
  reversals: string[];
  /** One line per revisit that kept or amended this decision. A revisit that reversed it is in reversals. */
  revisits?: string[];
}

export interface FollowUpSource {
  review: string;
  cards: HistoryCard[];
}

export function earlierCard(source: FollowUpSource | undefined, body: RequestBody): HistoryCard | undefined {
  return source?.cards.find(card => body.related?.includes(card.ref.split("@")[0]!));
}

export interface HistoryReview {
  review_id: string;
  task_title?: string;
  updated_at: string;
  cards: HistoryCard[];
  source_review?: string;
}

export function matchesHistory(review: HistoryReview, terms: string[]): boolean {
  const text = [review.task_title, review.review_id, ...review.cards.flatMap(c => [c.question, ...c.tags])]
    .join(" ").toLowerCase();
  return terms.every(term => text.includes(term));
}

export function previousDecision(card: HistoryCard): string {
  const outcome = card.answer ?? "No answer recorded";
  return [outcome, ...card.reversals.map(reason => `Reversed — ${reason}`), ...(card.revisits ?? []),
    `(${card.status.replaceAll("_", " ")})`].join(" ");
}

/** Follow-ups gather new preferences. An earlier action, deadline or default belongs to its original request. */
export function followUpCard(topic: string, source?: { id: string; body: RequestBody }): RequestBody {
  const b = source?.body;
  const reuseChoices = b && (b.kind === "choose" || b.kind === "clarify") && b.stakes.reversibility === "easy"
    && !b.options?.some(o => o.authorization) && !b.depends_on?.length && !b.skip_if?.length && !b.basis?.files?.length;
  const subject = topic.trim().replace(/[?!.]+$/, "");
  return {
    kind: "choose", category: reuseChoices ? b.category ?? "priority" : "priority",
    question: reuseChoices ? topic : source ? "Should we revisit this earlier decision?" : `Should we pursue “${subject}”?`,
    why_now: "Choose what to carry forward in this round.",
    options: reuseChoices ? b.options!.map(({ id, label, consequence }) => ({ id, label, consequence })) : [
      { id: "pursue", label: "Pursue", consequence: "Include this idea in the next plan." },
      { id: "defer", label: "Defer", consequence: "Leave this idea for a later round." },
      { id: "drop", label: "Drop", consequence: "Leave this idea out of the plan." },
    ],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "This choice sets the direction of the next plan.",
    ...(source ? { related: [source.id] } : {}),
    ...(b?.tags?.length ? { tags: b.tags } : {}),
    ...(b?.glossary ? { glossary: b.glossary } : {}),
    ...(reuseChoices ? { summary: b.summary, evidence: b.evidence, previews: b.previews, waivers: b.waivers } : {}),
  };
}
