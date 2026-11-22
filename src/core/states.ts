// Request states and the allowed transitions, as specified in
// docs/concept/lifecycle.md ("States"). Every state change in the engine goes
// through assertTransition, so the table is the single source of truth.

export const STATES = [
  "draft",
  "queued",
  "presented",
  "hidden",
  "answered",
  "default_claimed",
  "granted",
  "executing",
  "applied",
  "late_conflict",
  "stale",
  "outcome_unknown",
  "closed",
  "expired",
  "cancelled",
  "superseded",
] as const;

export type State = (typeof STATES)[number];

const ALLOWED: Readonly<Record<State, readonly State[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["presented", "cancelled", "superseded"],
  presented: ["answered", "hidden", "default_claimed", "stale", "expired", "cancelled", "superseded", "closed"],
  hidden: ["presented", "answered", "cancelled", "superseded"],
  answered: ["granted", "answered", "presented", "stale", "cancelled", "superseded"],
  default_claimed: ["executing", "answered", "presented", "stale", "cancelled", "superseded"],
  granted: ["executing", "answered", "presented", "stale", "cancelled", "superseded"],
  executing: ["applied", "outcome_unknown"],
  applied: ["late_conflict"],
  late_conflict: ["applied", "granted", "stale"],
  stale: ["superseded"],
  outcome_unknown: ["applied", "answered", "presented", "stale"],
  closed: [],
  expired: [],
  cancelled: [],
  superseded: [],
};

export const TERMINAL: ReadonlySet<State> = new Set(
  STATES.filter((s) => ALLOWED[s].length === 0),
);

/** States in which a request still needs something from the person or the agent. */
export const OPEN: ReadonlySet<State> = new Set(
  STATES.filter((s) => !TERMINAL.has(s) && s !== "applied"),
);

export function canTransition(from: State, to: State): boolean {
  return ALLOWED[from].includes(to);
}

export class TransitionError extends Error {
  constructor(
    readonly from: State,
    readonly to: State,
  ) {
    super(`not allowed in the current state: ${from} -> ${to}`);
  }
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
