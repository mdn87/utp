// Reconsidering a logged decision whose basis changed
// (docs/concept/lifecycle.md, "Revisiting a decision").

import { REVISIT_OUTCOMES, type RequestBody, type RevisitOutcome } from "./types.js";

/** One answered revisit, kept with the earlier decision it reconsidered. */
export interface RevisitRecord {
  /** The revisit card that asked, as id@revision. */
  request: string;
  /** The revision of the earlier decision that was reconsidered. */
  revision: number;
  outcome: RevisitOutcome;
  change: string;
  /** The amended decision in the card's words, when the outcome is amend. */
  amendment?: string;
  at: string;
  tags: string[];
}

/** The earlier decision as UTP recorded it, shown on the revisit card. */
export interface EarlierDecision {
  ref: string;
  question: string;
  answer?: string;
  decided_at: string;
  status: string;
}

export const isRevisitOutcome = (value: unknown): value is RevisitOutcome =>
  REVISIT_OUTCOMES.some((outcome) => outcome === value);

/** One line for the earlier decision's own record, for example in `utp show` and the history page. */
export function revisitText(record: RevisitRecord): string {
  const outcome = record.outcome === "keep" ? "kept" : record.outcome === "reverse" ? "reversed"
    : `amended to "${record.amendment ?? ""}"`;
  return `Revisited ${record.at.slice(0, 10)}: ${outcome}. ${record.change} (${record.request})`;
}

/** The labelled lines every renderer shows at the top of a revisit card. */
export function revisitContext(body: RequestBody, earlier?: EarlierDecision): [string, string][] {
  if (body.kind !== "revisit" || !body.revisit) return [];
  const decided = earlier
    ? `${earlier.question}${earlier.answer ? ` — ${earlier.answer}` : ""} (${earlier.ref}, decided ${earlier.decided_at.slice(0, 10)})`
    : body.revisit.decision;
  return [["Earlier decision", decided], ["It rested on", body.revisit.original_basis], ["What changed", body.revisit.change]];
}
