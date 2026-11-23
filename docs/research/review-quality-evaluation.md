# Review quality evaluation

A frozen version of `utp check` caught the expected defect in 9 of 11 reserved
requests. All 12 requests drawn from successful reviews passed untouched.

| Measure | Count | Result | Target |
|---|---:|---:|---:|
| Held-out requests that triggered their named rule | 9 / 11 | 81.8% recall | ≥80% |
| Must-accept requests that passed without edits or waivers | 12 / 12 | 100% specificity | ≥90% |
| Held-out repairs that passed without waivers | 11 / 11 | 100% | All |
| Flags that identified a labelled defect across the evaluation mix | 14 / 15 | 93.3% precision | Reported |

## What was measured

The reviewer confirmed ten sample classifications before fixtures were written.
Of 60 retrospective cases, 21 contained a feature the checker can test,
23 concerned policy or platform behavior, and 16 called for human judgment.
Each of the 21 has a fictional before-and-after pair. For a successful source
case, the before removes the feature that made the original request work.

We assigned the 21 public case numbers before reading the evaluation half.
Sorting by the SHA-256 digest of `utp-review-quality-v1:<case-id>` selected
the first ten for development and reserved the other eleven. The checker was
frozen at `06574be`. The reserved pairs, their named rules, the positive
controls and the draft labels were frozen at `5003565` before scoring.

The positive controls cover seven successful cases and five rewritten
questions that the person answered together. The source also included a
sixth, optional item that called for no answer. The controls use separate
fictional examples. Six of the seven successful source cases also contribute
a before-and-after pair. The five rewrites come from one interaction that
also contributed a held-out case. These are small, related samples.

Claude Code, Codex and Antigravity each drafted two requests from the same
fictional briefs. One asked how to group seed packets. The other asked how
to schedule book pickups given a dated tally. Each platform received the
request field names and briefs. The evaluation preserves their unedited
form data. Before scoring, the draft labels counted reader-facing prose
including the level explanation and glossary for the 220-word budget.

| Platform | Drafts | Correct flags | Extra flags | Missed flags |
|---|---:|---:|---:|---:|
| Claude Code | 2 | 2 | 0 | 1 |
| Codex | 2 | 1 | 0 | 0 |
| Antigravity | 2 | 2 | 1 | 1 |

Precision counts each rule once per request across 11 held-out befores,
12 positive controls and 6 platform drafts. Development pairs and repaired
cards have their own checks. The fixtures passed a private identifier scan,
a generic leak scan and a review against the private sources before publication.

## Where the checker missed

- A default said to wait for a particular person to return. It gave no
  deadline or cost, and the scope warning missed it.
- A card offered to update a secondary entry without explaining what the
  change meant. Its question and timing fields contained text, so it passed.
- Two platform cards exceeded the reading budget once the glossary and level
  explanation were counted. The checker counted a smaller set of fields.
- A platform draft said the seed exchange was ready to organize packets.
  The checker treated this statement of intent as a claim of completed work.

After building, run `node scripts/score-lint.mjs` to reproduce the result.
Add `--json` to see the exact rule misses and extra flags, or
`--development` to check only the ten development pairs. The published
cases now serve as regression tests. A future claim about unseen requests
requires a fresh sample.
