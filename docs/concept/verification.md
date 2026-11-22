---
title: UTP verification
status: v0.9, store moved to the home server per decision D2
updated: 2026-11-22
---

# UTP verification

How each claim in [the concept](concept.md) and [lifecycle](lifecycle.md) is
tested, what ends each phase, and how the measures are defined.

## Test layers

| Layer | What it proves | How |
|---|---|---|
| Schema and rules | Each structural check and heuristic fires on its own failure and only there | Unit tests per rule id |
| State machine | Every sequence of commands reaches only allowed states; retried operations write nothing new | Property tests that replay random command sequences against the transition table, including the late-conflict path after `applied`, `stale` from `answered`, `granted`, and `default_claimed`, a revised answer returning `granted` to `answered`, a withdrawn one returning it to `presented`, supersession from `answered`, `granted`, and `default_claimed`, an unused default claim returning to `presented` with no answer recorded, every reconciliation outcome, and `late_conflict` to `granted` or `stale` |
| Writer crashes | The store survives the service being killed mid-write, and retries are exact | Kill the service after the payload write, during the event append, and just after the append, on NTFS, APFS, and ext4. After each, retry the same operation id and assert exactly one committed mutation and the original result; replay must succeed, a torn last line must be quarantined, and no event may reference a missing payload |
| Concurrency | Parallel `ask`, `answer`, `wait`, and `claim-default` from many clients produce one winner per race and an intact log | Stress tests with parallel client processes against one service, plus a second service instance refused by the store lock, using Windows and POSIX file locking |
| Execution grants and external effects | Acting is safe to interrupt, revoke, and recover, and recovery never invents certainty | Kill the agent before `begin`, after `begin` but before the effect, and after the effect but before `applied`, for both an answer's grant and a claimed default's grant: an unused answer grant returns the request to `answered` when its lease runs out, an unused default claim returns it to `presented` with no answer recorded and can be claimed again without a new question, a used grant becomes `outcome_unknown`, and none is retried automatically. Recovery runs through `reconcile`: proof that nothing happened re-grants under the current answer without asking; a partial effect re-grants only the rest, and that grant reaches `begin` and completes the remaining effect against the recorded recovery basis, while an unrelated change to the target after the partial effect makes the request `stale`; a different effect ends `applied` and flagged. A default A that was begun, followed by the person's answer B and a confirmed zero effect, reconciles to `answered`, and B gets a fresh grant and `begin` with no repeated question, no duplicate answer, and no renewed A default. A withdrawal or narrowing sent after `begin` holds through recovery: after zero-effect and partial-effect reconciliation, nothing is re-granted after a withdrawal and only the narrowed scope after a narrowing, without the person repeating the correction. A revised or withdrawn answer makes `begin` refuse the outstanding grant; a correction after `begin` is recorded as reconciliation. Takeover of an unused grant succeeds once the owner session has ended or after the idle period, and the former owner's later `begin` fails; takeover of a used grant is refused until its lease ran out and its outcome was reconciled, or the person authorized it. A paused old owner that resumes after a takeover has its `begin` refused for the old epoch; the case where it had already passed `begin` is run against a target with an idempotency key and observed, and the residual risk is reported, not hidden |
| Binding | Answers apply only to what was seen and chosen | An answer to an old revision is refused for the new one; a new revision with unchanged preconditions revokes the old revision's grant, and that grant's `begin` fails; choosing the narrower `approve` option and then reporting the wider scope in `applied` is flagged; an approved delete that removes exactly the authorized files is recorded as `applied`, not `stale`; expiry, dismissal, and timeouts never yield approval; a precondition change before `begin` returns `stale`, including one that happens before `claim-default`, while a change to unrelated files does not; `claim-default` after an answer returns the answer, and an answer arriving after the claim but before `begin` releases the claim; a contradicting answer after a default-based `applied` becomes `late_conflict`, and an agreeing one is recorded as a confirmation; resolving a conflict by redoing the work runs under a fresh grant through `begin` and `applied` (default A changes the target, applied, late answer B, conflict, redo, applied), checked against the state A left so it isn't re-asked because A was applied, while an unrelated change to the target in between makes it `stale`; keeping the default records the resolution with no new grant; a level-3 `choose` card whose cited evidence is unchanged but whose target changed goes `stale` before execution; a level-3 `choose` answer that authorizes an outward action is held to the approval rules, and on Antigravity it is routed to the terminal review; a logged answer with weaker provenance doesn't authorize a level-3 action through authority reuse, while one with adequate provenance isn't asked again |
| Deduplication | Only equivalent requests share an answer | Same key and same content attach; same key with a different target, scope, option, or basis creates a separate request; an attached observer can't record `applied` for an external action |
| Project identity | Logs don't mix or split by accident | A worktree joins its checkout's project; a second clone with the same remote, on this machine or another, joins only after `utp link`; linking a clone that has its own records keeps them searchable as a read-only archive, with a prior reversal still found by lookups, and `utp link` refuses while either store has open requests or grants; a fork stays separate; a shallow clone and a repository with no commits register normally |
| Presentation receipts | "Presented" means the person could see it | A prepared but never presented review doesn't count; a conversation presentation is confirmed against the transcript where possible; a level-3 card carries the level-1 decisions it depends on; notices close on presentation without asking for acknowledgement |
| End to end, per platform | The whole flow works from each agent | A scripted run, kept as a test, for Claude Code, Codex, and Antigravity: ask, independent work, flush, presentation, answer, wait, begin, applied; a claimed default through `begin` and `applied`; `applied` before `begin` refused; a cancel; a late answer before and after `applied`. Each runs against the service on the home server, in the platform's default restricted sandbox after `utp setup`; once without that setup and once with the service stopped, each confirming exit code 32. In one run the agent process exits at a blocker, the person answers in `utp review` from another terminal, and the documented resume path continues the work. Run on PowerShell 7 and Git Bash (Windows), zsh (macOS), and bash over SSH (Linux); the resulting log must match an expected record |
| Conversation answers | Quotes and approvals are handled safely | A quote in a person-typed turn after the presentation is `verified: transcript`; a quote from before the presentation (an old message using the same words) is refused; a later correcting turn makes the answer `unsure`; a bare "yes" as the next turn after a single fresh card is accepted; "yes, approve deleting only the ten listed exports" is accepted when that scope matches an option and becomes `needs clarification` when it matches none; "D1: yes, delete those exports; D2: decline" records both cards by id; "approve deleting only files A and B" on a card offering ten files is recorded as a custom approval with that scope and repeated back, while "delete all twelve" becomes `needs clarification`; "what happens to the backups?" is a response, never an approval; a bare "yes" while several cards were open, a "yes, wait", or the wrong card letter is `unsure` or refused; an approval relayed by another agent is refused; on a platform without a checkable transcript, a level-3 approval in the conversation is refused and routed to the terminal review |
| Renderer conformance | No channel drops required content | Review level: the intent block, and every `depends_on` link shown on the dependent card; a combined answer resolves to one plan (for example, choosing to bring blind judging into phase 1 on one card moves the dependent item on another card to phase 1, keeping both answers as given). Every card: the question, every option label and consequence line, the default and its consequence, the recommendation's reason, any waiver. Kind-specific: the action, target, and scope of each option carried out as an action, on `approve` and on any other kind; each `handoff` step's actor, machine, shell, tested status, and expected result; goal mappings and evidence for `accept` and completion reports; change text for `assumptions`. Every flagged code is defined or shows its waiver. A channel that can't carry a request refuses it and falls back to Markdown; a native dialog's free-text "Other" maps to a `custom` answer; a dialog that pre-selects an option is never used for a card with a recommendation: a recommended approval, a recommended narrowing, and a recommended decline all fall back to Markdown or the terminal review on the demonstrated tool surface, with options and recommendation unchanged |
| Close-out hook | Completion is never turned into an acceptance gate | With a valid completion report and no `accept` request, the Claude Code Stop hook lets the turn end; without a report after files changed, it asks the agent (not the person) to write one |
| Asking policy | The ladder is applied and auditable | The evidence's silent-decision cases replayed with an expected minimum level; an instruction such as "fix, test, and publish" produces no new request for the publish, while a wider target does; a lookup with a shared tag shows a prior reversal; a level-1 to 3 record without a level and reason is refused |
| Review page (phase 1) | The person can inspect and answer a batch in one window | One save binds every answer to the displayed revision. A post without the presentation token, with a foreign Origin, or with a rebinding Host header is refused. The token stays out of `utp serve` output |
| Blind judge (phase 2) | Blind means blind | The recommendation and candidate identities are absent from the served page and API before the ballot is saved; a changed second ballot returns 409; byte-identical candidates are blocked before the review opens |
| Leaks | Nothing private reaches the public repository | CI runs generic patterns over committed fixtures and exports; the private deny-list check runs locally before push and on every export |

## Lint fixtures from the evidence

The fixture plan is built so the rules can't pass by construction.

1. Each of the 60 evidence cases is classified as lint-detectable, policy or
   adapter (for example, a choice the agent never wrote down), or human
   review (for example, a false claim stated with a date). Only the first
   class becomes lint fixtures; the others are covered by the asking-policy,
   adapter, and conversation-answer tests above, or by the person's review.
2. The person confirms a sample of at least ten classifications before any
   fixture is written.
3. Each lint-detectable case becomes a "before" request that must fail on a
   named rule id and an "after" request that must pass.
4. Rules are written against a seeded random half of the cases and measured
   on the other half. Targets: the right rule fires on at least 80% of
   held-out "befores" (recall), and at least 90% of must-accept requests pass
   untouched (specificity, the true-negative rate). Precision, the share of
   all flags that point at a real failure, is reported with the evaluation mix
   stated (held-out befores, must-accepts, and platform-drafted requests),
   because it depends on how many failures the mix contains; phase 1 sets no
   precision target.
5. The 7 went-well cases and the 5 rewritten asks are must-accept fixtures.
6. Each platform drafts requests for sample tasks without seeing the rules;
   those requests measure real-world misses and false positives.
7. Fixtures are paraphrased, pass the leak check, and get a provenance review
   before they are committed to the public repository.

## Phase exit criteria

Phase 0 ended when the decisions from
[review 0001](../decisions/0001-concept-review.answers.json) and
[review 0002](../decisions/0002-followup-review.answers.json) were published.

Phase 1 ends when all of these hold:

- **AC1 Lint.** The fixture targets above are met on the held-out half.
  Across the first 15 real requests, waivers stay at or under 10%, and every
  waiver is visible on its card.
- **AC2 Lifecycle.** The state machine, writer-crash, concurrency,
  execution-grant, binding, deduplication, identity, presentation,
  close-out hook, and end-to-end layers pass on Windows, macOS, and Linux.
- **AC3 Real use.** Across at least 5 real tasks spanning Claude Code, Codex,
  and Antigravity: at least 80% of cards given feedback are marked `clear`;
  no decision is asked twice without a material change in between; reviews
  per task are no higher than the structured-question rounds per task in the
  retrospective baseline; and no notification is sent per request. Active
  response time is reported where the channel measures it, with no target in
  phase 1.
- **AC4 Content.** Renderer conformance passes at review level and for every
  phase-1 kind, so each review shows the intent block, a consequence line for
  every option and default, the kind-specific fields, and a definition or a
  visible waiver for every flagged code. Verify the phase 1 review page
  with a batch of three or more.
- **AC5 Close-out.** At least 3 real tasks that changed files close with a
  completion report mapping every stated goal, with queued notices shown,
  and none of them waited on the person to finish.
- **AC6 Lookup.** A logged reversal is shown to an agent deciding with a
  shared tag, and the agent's level and reason are recorded.

Later phases' exit criteria are in the concept's build-phase table and get
the same treatment when their phase starts.

## Measures

| Measure | Definition | Source | Baseline |
|---|---|---|---|
| Reversal rate, answered | Answered decisions reversed within 30 days, divided by answered decisions whose 30 days have passed | UTP log | Retrospective: structured questions answered in the two weeks before UTP starts, found by the same transcript extractor |
| Reversal rate, agent-decided | Level-1 decisions and applied defaults reversed within 30 days, divided by those logged whose 30 days have passed | UTP log | None; before UTP these decisions weren't logged |
| Silent reversals | Reversals of decisions that were never logged, as a count per task | Transcript extractor | The same count over the two weeks before UTP starts |
| Open windows | Decisions younger than 30 days, reported as a count and left out of both rates until their window closes | UTP log | Not applicable |
| Clarity | Cards marked `clear` divided by cards given feedback | Answers | None; new |
| Recommendation override | Answers other than the recommendation divided by answered requests, per `choose` category; dismissals reported separately | Answers | 37 of the 72 answered questions with a recommendation (18 other listed options, 19 own answers), plus 5 dismissed; selected cases, mixed question types, no per-category counts |
| Own answers | `custom` answers divided by answered requests | Answers | 19 of 72 (selected cases) |
| Interruptions | Reviews presented per task; decisions asked twice without a material change; time dependent work waited on an answer | UTP log and request `origin` | Retrospective count of structured-question rounds per task |
| Active response time | Time from a card being opened to being answered, where the channel can tell | Review page and terminal review | None; reported without a target |
| Delivery latency | Time from presentation to answer | Presentation receipts and answers | Reported, never used as a target |
| Misreads | Applied actions that don't match the typed answer, in a sample of 20 applied records a month | Manual audit | None; new |
| Waiver rate | Waivers per rule divided by requests where the rule applied | Check results | None; new |

A measure whose source isn't logged by the end of phase 1 is dropped from
phase 1 claims rather than estimated.
