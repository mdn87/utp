import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, STATES, TERMINAL, type State } from "../src/core/states.js";

// The allowed transitions, copied from docs/concept/lifecycle.md.
const DOCUMENTED: Record<State, State[]> = {
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

test("the table allows exactly the documented transitions", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const expected = DOCUMENTED[from].includes(to);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
});

test("terminal states have no way out", () => {
  for (const s of TERMINAL) assert.deepEqual(DOCUMENTED[s], [], s);
  assert.deepEqual([...TERMINAL].sort(), ["cancelled", "closed", "expired", "superseded"]);
});

test("nothing reaches an execution grant from expiry, cancellation, hiding, or a closed notice", () => {
  for (const from of ["expired", "cancelled", "hidden", "closed"] as State[]) {
    assert.equal(canTransition(from, "granted"), false, from);
    assert.equal(canTransition(from, "executing"), false, from);
  }
});

test("an effect under way can't be cancelled or superseded until it is reconciled", () => {
  for (const to of ["cancelled", "superseded", "answered", "presented"] as State[]) {
    assert.equal(canTransition("executing", to), false, to);
  }
});
