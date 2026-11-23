---
title: UTP concept
status: v0.9, updated with the answers to review 0001
updated: 2026-11-22
---

# UTP concept

Companion documents: [lifecycle](lifecycle.md) (storage, states, binding,
concurrency, the command-line contract) and [verification](verification.md)
(tests, phase exit criteria, metrics). Open decisions are written as UTP
requests in [decisions/0001-concept-review.md](../decisions/0001-concept-review.md).

## In brief

When an agent needs something only the person can supply (a decision, a
judgment, an observation, or an acceptance), UTP has the agent write it as a
typed request, checks that the request carries what the person needs to
answer well, shows it as one card per decision in a batched review, and
returns the answer to the agent as data bound to exactly what the person saw.
Every request, answer, and reversal goes into a decision log the next session
can search. The command line and plain files are the contract; answering in
the conversation, a review page, the app's own question dialog, and a
phone inbox are ways to reach the same request.

## The problem, from the evidence

A review of one operator's recent agent sessions found 60 decision cases: 35
decisions that had to be reversed, 17 that were hard to follow, 1 latent
inconsistency, and 7 that went well (see
[decision failure patterns](../research/decision-failure-patterns.md)).

- **Most bad decisions were never asked.** In 28 of the 53 cases that went
  badly, the agent decided without putting the choice to the person. All 7
  cases that went well were proposals the person answered.
- **The causes are presentation failures more than hard problems.** The
  leading root causes were a consequence not stated when the choice was made
  (11), an undefined label or code (9), an assumption never surfaced (9), a
  status word such as "done" not tied to the person's goal (8), an unclear
  handoff of a manual step (8), and an inference stated as fact (7).
- **Recommendations are not rubber-stamped.** Of 77 structured questions with
  a recommended option, the person chose it 35 times, chose another listed
  option 18 times, and wrote their own answer 19 times. Overrides clustered in
  design questions, where the recommendation tended to keep the agent's
  existing design.
- **Restructuring works.** Five decisions buried in a long report went
  unanswered; rewritten as one block per decision (the ask, the answer shape,
  what each answer does), all five were answered in one line.

Four presentation features would have addressed 40 of the 53 cases that went
badly: a consequence line per option and per default; completion claims tied
to the person's stated goal, with evidence they can see; a header showing what
the person asked for next to what the agent will do; and one card per
decision, ask first.

## What UTP is

- A **request format**: a typed description of one thing the agent needs from
  the person.
- **`utp check`**: structural checks that every request must pass (it binds
  to an action, its options have ids, it carries a consequence line per option)
  plus presentation heuristics that can be waived with a visible, logged
  reason (undefined codes, status words without evidence, length).
- **Reviews**: batches of requests that open with the intent echo (what the
  person asked for, what the agent is doing, what changed in scope) and send
  at most one notification per batch.
- An **answer format**: a small fixed vocabulary of typed answers, the
  person's own answer kept verbatim, and dispositions such as "answered
  elsewhere" and "hide until tomorrow".
- A **decision log**: an append-only record of requests, answers, what the
  agent did with them, reversals, and what would reopen each decision.
- An **asking policy** that keeps routine choices out of the person's way and
  makes silent decisions visible before work is built on them.
- A **learning loop**: evidence cases become test fixtures, and signals from
  real reviews drive revisions to templates and the asking policy.

## What UTP is not

- Not a way to simplify every decision. It orders complex decisions so a person
  can work through them.
- Not an approval gate. It must reduce interruptions, not add them.
- Not a form builder, survey tool, or project tracker.
- Not tied to one agent product.
- Not a guarantee. It can make an agent's fabricated or careless answer
  visible and auditable; it cannot make one impossible.

## Design principles

1. **Ask first.** Each card opens with the question in one sentence and the
   answer shape. Background comes after.
2. **Echo the intent.** Every review opens with what the person asked for (in
   their words), what the agent is doing, and what it narrowed, deferred, or
   added, with a reason for each, or an explicit "no change".
3. **Consequences beside the choice.** Every option and every default has a
   line saying what changes for the person, how often, and how to reverse it.
4. **Options by outcome.** Options are named by what the person gets. A
   recommendation says why, what it preserves, and what a bolder option would
   change.
5. **The person's own answer is a real choice,** kept verbatim and never
   executed until its scope is unambiguous.
6. **Define every label** where it appears, or replace it.
7. **Claims carry their source:** observed or inferred, where from, and when.
8. **Status means the person's goal.** "Done" is a mapping from each stated
   goal or risk to covered, partly covered, or not covered, with evidence the
   person can see or hear.
9. **Say who acts.** A manual step names the person, machine, and shell, says
   whether its command was tested in that shell, and what success looks like.
   If the agent can do the step, it offers that first.
10. **Show the thing.** A judgment about an artifact shows the artifact.
11. **Answers bind to what was seen.** An answer names the request revision it
    answers and counts only when given after that revision was presented. An
    approval authorizes the action, target, and scope of the option chosen;
    timeouts, expiry, and dismissals never become approval.
12. **Authority already given is reused.** When the person's instruction or a
    logged decision already covers an action, the agent proceeds and cites it
    instead of asking again.
13. **Batch and stay quiet.** Requests queue into the current review; the
    person is notified once per review, never per request.
14. **Command line first.** Everything works from a terminal over SSH; app
    features are conveniences over the same store.
15. **UTP reviews itself.** UTP's own design decisions go through UTP.

## Request kinds

Ranked by how often each decision type appeared in the evidence. Phase 1
covers the first six plus `notice` digests (decision D1). By decision
type, the six kinds map to 50 of the 60 evidence cases; review batching and
the evidence rules cover 6 more (3 batches, 3 diagnosis claims). Judging an
artifact (2) and understanding an answer (2) wait for later phases. These
are case counts; the evidence doesn't measure rework cost.

| Kind | What the agent needs | What the person gives | Evidence |
|---|---|---|---|
| `choose` | A choice among approaches, designs, priorities, or rules | An option id, or their own answer | 8 approach, 7 process, 4 prioritization |
| `approve` | A go or no-go on one consequential action | Approve, approve the narrower option, or decline | 8 |
| `handoff` | A step only the person can do or observe | Per-step result with what they saw | 8 |
| `clarify` | The meaning or scope of a request | The agent's stated reading, another reading, or their own | 7, plus 9 unstated assumptions |
| `accept` | Acceptance of a result, when acceptance is the person's call (routine work closes with an informational completion report instead) | Per goal: accepted, partly, not accepted | 5, plus 8 status-word failures |
| `assumptions` | A check of the defaults and assumptions in a plan before work starts | Per item: keep or change | 3 plan defaults, 2 skipped plan reviews |
| `judge` (phase 2) | A quality or taste judgment of artifacts, often blind | Ratings, a preference, reasons | 2, plus three blind-ballot experiments |
| `revisit` (phase 3) | Reconsideration of a logged decision whose basis changed | Keep, amend, or reverse | 1 latent case |
| `notice` | Nothing; the agent decided and is telling the person | Optional objection | The 28 silent decisions |

Kind-specific requirements, enforced by `utp check`:

- `approve` echoes the exact action, target, and scope; each option, including
  a narrower one with its own consequence line, defines its own effective
  action, target, and scope (or the request says why the action can't be
  split); and it carries at least one dated evidence item (a dry run's size
  and count, for example). A level-3 approval lists the level-1 decisions it
  depends on.
- `accept` and completion reports list every goal or risk the person stated
  and map each to covered, partly covered, or not covered, with dated
  evidence.
- `handoff` steps name actor, machine, shell, command, expected result,
  whether the command was tested in that shell, and why the agent can't do it.
- `clarify` states the agent's reading and at least one alternative reading.
- For `handoff`, `accept`, and `assumptions`, answers use the request's
  stable item IDs. The `items` field records one result or choice per ID.
  The `details` field records observations or replacement text by the same
  ID. A handoff completion or blocker needs an observation, and changing an
  assumption needs replacement text.
- `choose` carries a `category` (`design`, `approach`, `priority`, `process`,
  `naming`, `other`) so recommendation-override rates can be tracked by
  category; a recommendation asserting current system state carries dated
  evidence.

## Anatomy

Field-level detail, the state machine, and binding rules are in
[lifecycle](lifecycle.md). The shapes in brief:

- **Review**: id, `intent` (`asked` in the person's words, `doing`,
  `scope_delta` with `narrowed`, `deferred`, `added`, each with a reason, or
  `none`), its requests in order of how much work each blocks, and the
  `notice` items queued since the last review.
- **Request**: `utp` version, id, revision, kind, `question`, `why_now`,
  options with stable ids, labels by outcome, and consequence lines, the
  recommendation (`because`, `preserves`, `bolder_alternative`), an optional
  default with its own consequence line, evidence items (observed or
  inferred, source, date), a glossary, `stakes` (reversibility `easy`,
  `costly`, or `one_way`), `level` with a one-line reason, `tags` and
  `related` ids for log lookup, a `dedupe_key`, a `basis` naming the parts
  that matter to the decision (cited files and, for any option carried out as
  an action, the target's state), the authorization (action, target, scope, expected effect) of each
  option the agent will carry out as an action, whatever the kind,
  `depends_on` naming other cards in the review whose answers change this
  one (shown on the card), and `origin` (agent, platform, project, session).
- **Answer**: the request id and revision, one value from the answer
  vocabulary (option id; several option ids; per-item `keep`, or `change` with
  the person's verbatim replacement text; a rating; or `custom` with verbatim
  text), an outcome of `needs clarification` when custom or change text is
  ambiguous, the person's sureness (`sure`, `leaning`,
  `unsure`), optional one-tap feedback (`clear`, `needed more`, `too much`,
  `wrong options`), and provenance: channel, who recorded it, and how it was
  verified.
- **Dispositions** instead of an answer: `answered elsewhere`, `no longer
  matters`, or `hide until` a stated time (from the open-items page, where
  buttons labeled only "Done" and "Not today" confused the person).
- **Decision record**: the request, the answer, what the agent did with it
  and the evidence, the `revisit_if` trigger, and an append-only history
  (reversed, amended, superseded, with reasons).

## `utp check`

`utp check` runs on every request before it can be queued. It has two
classes of rule, and it verifies presence and form, not adequacy; adequacy
is judged by the person through `needed more` and `wrong options` feedback.

| Rule | Class | Prevents |
|---|---|---|
| Schema valid; option and goal ids stable; answer vocabulary supported by the request's renderers | Structural, never waived | Answers that need interpreting |
| `approve` binds action, target, and scope; offers a narrower option or says why not; has dated evidence | Structural, never waived | Approval mechanics |
| Every option and default has a consequence line | Structural | Consequence not stated |
| A review has an intent block with `asked`, `doing`, and `scope_delta` (or `none`) | Structural | Goal lost; silent scope change |
| `accept` maps every stated goal; `handoff` steps name actor, machine, shell, expected result, and tested status; `clarify` gives an alternative reading | Structural | Status words; unclear handoffs; unstated assumptions |
| Codes, acronyms, and internal identifiers are defined, removed, or carry a visible waiver | Heuristic, waivable | Undefined labels |
| Status words (done, fixed, ready, blocked, no-op) appear only with a goal mapping or evidence | Heuristic, waivable | Status word without meaning |
| Evidence items are marked observed or inferred, with source and date | Heuristic, waivable | Inference stated as fact |
| Question first, one sentence; card within a length budget, detail linked | Heuristic, waivable | Wall of text; decision buried |
| A recommendation names `because`, `preserves`, and `bolder_alternative` | Heuristic, waivable | Biased recommendation |

A waiver needs a reason, is shown on the card the person sees, and is
counted per rule; a rule waived often is treated as a defect in the rule.
Some evidence failures can't be caught by linting a request at all (a choice
the agent never wrote down, a false claim stated with a date). Those are
handled by the asking policy, the adapters, and the person's review, and
[verification](verification.md) tests each through its own method.

## When to ask

| Level | When | What the agent does |
|---|---|---|
| 0 | Routine, reversible, invisible to the person | Decide. Count it by category, without content |
| 1 | Reversible, and the person might care | Decide, log it, and queue a `notice` with a consequence line |
| 2 | A real trade-off or likely misunderstanding, still reversible | Queue a request and keep working on independent tasks |
| 3 | Irreversible, outward-facing, needs authority the agent lacks, a taste judgment it can't make, or a step only the person can do | Queue a request and hold the dependent work |

Rules around the ladder:

- **Existing authority first.** Before raising a level, the agent checks
  whether the person's current instruction or a logged decision already
  authorizes this action class on this target for this objective (for
  example, "fix, test, and publish it" covers the publish). If so, it
  proceeds, logs the action at level 1, and cites the authorizing words or
  decision id. It asks again only when the target, the outcome, the kind of
  change, or the risk materially expands, or when authority is genuinely
  missing. A logged decision counts as authority for a level-3 action only if
  its answer met the approval rules below; one that didn't is missing
  authority, and asking for it isn't asking twice.
- **Lookup before deciding.** Before queueing a request or deciding at level
  1 or above, the agent runs `utp log --tags ...` for the project. A prior
  reversal with a shared tag or `related` id is shown to the agent, which
  either raises the level or records why not. Escalation is not automatic.
- **Every level-1 to 3 record carries its level and a one-line reason**, so
  the ladder can be audited and tested.
- **Notices ride on the decision that depends on them.** A level-3 request
  lists the level-1 decisions it builds on, so the person sees them at the
  moment they matter. Notices never ask for an acknowledgement of their own.
- **Defaults are narrow (D4).** A level-2 `clarify` or non-design `choose`
  may use its stated default when dependent work reaches it first. The choice
  must be local, have a one-step undo, and keep the scope delta at `none`.
  Design and scope questions, approvals, result checks, matters of taste, and
  choices the agent cannot classify wait for the person. A larger technical
  default calls for a panel of agents before use. The panel runs with the
  person's authorization and gives advice. The default still needs its own
  authority. The agent reserves the default with
  `utp claim-default` before acting, which returns the person's answer
  instead if one already arrived. A used default is listed in the next review
  as "applied by default: change?"; a later answer that contradicts it,
  before or after the work was done, is flagged as a late conflict for both
  agent and person and never applied or dropped silently. If the person changes
  a default, the agent records why and asks them to confirm whether similar
  questions should always wait.
- **Close-out is a report, not a gate.** Before reporting work that changed
  files or external state as complete, the agent writes a completion report:
  each stated goal or risk mapped to covered, partly covered, or not covered,
  with evidence the person can check, plus any queued notices. The report
  needs no answer and never blocks completion. An `accept` request that waits
  is used only when the person asked to accept the result or when acceptance
  depends on something only they can judge or observe. Read-only questions
  need neither.

## How the person answers

| Channel | What it's for | Phase |
|---|---|---|
| The conversation | The default for one or two questions. The agent shows Markdown cards with lettered answers and records the person's reply | 1 |
| Terminal review (`utp review`) | SSH-only machines; answering outside any agent; consequential approvals where the transcript can't be checked | 1 |
| Review page, served by the UTP service | One page and one save for batches of three or more cards, with previews where the person needs to inspect an artifact | 1 |
| Blind comparison on the review page | Side-by-side review with candidate identities and recommendations hidden until the person votes | 2 |
| The app's own question dialog | One-click answers for small requests in Claude Code, Codex, and the Antigravity app | 2 |
| Phone inbox | Answering away from the desk, through the existing phone inbox | 4 |

**Answers given in the conversation** are recorded by the agent with
`utp answer --from-chat`, quoting the person verbatim. Where the platform
keeps a readable local transcript, UTP checks that the quote is in a
person-typed turn that came after the card was presented and before any newer
presentation of it, and that no later turn in that window corrects it; it
then records `verified: transcript`. Otherwise it records `verified: none`.
In a review with several cards, the reply needs the card letter, so a "yes"
can't land on the wrong card.

**Approvals are stricter.** These rules follow the effect, not the card type:
they cover a level-3 `approve` answer and any other level-3 answer the agent
will carry out as an outward or hard-to-reverse action, such as a `choose`
answer that publishes a license. Such an answer counts when it comes
through a channel the agent doesn't control (the person's terminal now; the
review page, the app's own dialog, and the phone later), or when it passes
the transcript check and is addressed. An addressed reply names the card
("D1: yes, delete those exports; D2: decline"), or names the action or scope
("yes, approve deleting only the ten listed exports"), or is a bare "yes" or
"go" sent as the person's next turn after a presentation holding that one
card and no other open question. An explicit card id and a stated scope take
precedence over position. A stated scope counts when it matches an option or
falls inside one ("approve deleting only files A and B" on a card offering
ten files), and the agent repeats the recorded scope in its next message. A
scope wider than every option, or of a different kind, becomes `needs
clarification`, and the agent offers it as an option in a new revision. Free
text that doesn't explicitly approve, such as a question or a comment, is a
response and never an approval. Only ambiguous or unaddressed
assent is recorded as `unsure` and asked again: a bare yes while several
cards were open, a yes followed by "wait" or a correction, and a voice
transcript that sounds unsure. An approval relayed by another agent or
session is refused until the person confirms it.

| Platform | Conversation answers checked against a transcript | Consequential approvals in phase 1 |
|---|---|---|
| Claude Code | Expected: sessions are stored as local JSON lines; to be demonstrated in phase 1c | In the conversation, verified |
| Codex | Expected: sessions are stored as local JSON lines; to be demonstrated in phase 1c | In the conversation, verified |
| Antigravity | Not available: its conversation store isn't a documented, readable format | In the person's terminal with `utp review`, an extra step on this platform until a verified channel exists |

Every channel shows the same content. A channel that can't carry a request
(for example, consequence lines that don't fit a dialog's option fields)
refuses it and falls back to Markdown; it never truncates.

## How the agent waits

Agent shells are not interactive, so the agent never prompts in its own
shell.

1. The agent writes the request to a file and runs `utp ask <file>`. UTP runs
   `utp check`, stores the request, attaches it to an open request only if the
   two are equivalent (same kind and same decision content, not just the same
   key), and queues it into the current review. Nothing is sent yet.
2. The agent continues independent work.
3. At a real blocker or at the end of its turn, the agent runs `utp flush`,
   which prepares the review. The agent shows it in its reply, the adapter
   records that it was presented, and one notification for the batch goes to
   any other channel the person uses. When nothing independent is left, the
   agent ends its turn there instead of blocking. The person's next message
   resumes the session, and the adapter has the agent run `utp status` at the
   start of every turn, so answers given anywhere are picked up. An answer
   given outside the conversation can't restart an agent process that has
   exited: in phase 1 the person goes back to the conversation, or resumes the
   session, and the terminal review's closing line says how. Automatic
   resumption, where a platform supports it, is a phase 4 item.
4. The answer lands in the store through any channel.
5. At the dependency, the agent runs `utp wait <id> --timeout <seconds>`,
   which issues an execution grant when the answer authorizes an action. Exit
   codes distinguish answered, still waiting, stale, cancelled, expired, late
   conflict, and revoked. Where the level-2 rules allow a default, the agent
   runs `utp claim-default <id>`, which issues a grant for the default or
   returns the answer that already arrived.
6. Immediately before the side effect, the agent runs `utp begin <grant>`,
   which re-checks that the answer wasn't revised or withdrawn and that the
   preconditions still hold. If it fails, the agent doesn't act.
7. The agent records what it did, including the scope and the effect, with
   `utp applied <grant> --evidence ...`. An effect that may have happened but
   was never recorded becomes `outcome unknown` and appears in the next
   review; it is checked before any retry, and `utp reconcile` records what
   the check found. Work proven not done goes ahead under the current answer
   without asking again, and never under an answer the person withdrew or
   narrowed after the agent began.

## Platform adapters

Each adapter is an instruction file or skill that teaches the asking ladder,
the request kinds, how to write cards, and the `utp` verbs. Phase 1 adapters
use only the command line.

- **Claude Code**: a skill, and an optional Stop hook that checks a
  completion report exists when files changed. The hook never asks for
  acceptance and lets the turn end once the report is there. The native
  question dialog is used from phase 2.
- **Codex**: an `AGENTS.md` section and a skill. Native question tools from
  phase 2, chosen by what the session actually offers: the CLI's
  `request_user_input` and the experimental `request_user_input_async` differ
  in which modes they work in and in pre-selection.
- **Antigravity**: rules and a skill. Its command-line client can only view
  native questions and its transcripts can't be checked, so it relies on the
  conversation for ordinary answers and the terminal review for consequential
  approvals.

**Reaching the service from sandboxes.** The decision log lives in one
service on the home server (decision D2), so every `utp` command needs the
network. An agent sandbox that blocks network access can't reach it, and
Codex's `workspace-write` mode blocks it by default. `utp setup <platform>`
shows the setting that allows it (for Codex, `[sandbox_workspace_write]
network_access = true`, which opens all outbound network for that agent, not
just UTP) and applies it only after the person confirms. Without it, `utp`
fails with exit code 32 and names the setup command, instead of asking for a
sandbox exception on every request. Phase 1c demonstrates the setting on
each platform.

An optional MCP server exposing the same verbs arrives in phase 4. Adapters
never change the format.

## What UTP takes from other tools

From the [prior-art research](../research/prior-art.md):

- **Native question dialogs are lossy.** Claude Code's `AskUserQuestion`
  takes 1 to 4 questions with 2 to 4 options and returns answers keyed by
  question text and label; Codex's `request_user_input` takes 1 to 3
  questions with 2 or 3 options, works in Plan mode, and is refused in
  `codex exec`, while its experimental `request_user_input_async` tells the
  model to put the recommended answer first and pre-selects the first option;
  Antigravity's `ask_question` returns option ids plus skipped and free-text
  answers. None carries a revision, and availability depends on the client,
  version, mode, and experimental settings, so adapters check the tool they
  actually have. UTP's adapters keep labels
  unique so answers map back to option ids, record the revision they showed,
  and refuse a request that exceeds a dialog's limits, falling back to
  Markdown or the terminal review.
- **MCP elicitation fits the answer, not the card.** Its form mode takes a
  flat schema of simple fields, which can carry option ids, per-item answers,
  free text, and sureness, but not consequences, evidence, or revisions. The
  phase 4 MCP server generates that schema and carries the rest as message
  text. Codex cancels elicitations in `codex exec`, so the command line stays
  the floor.
- **Answers are keyed by id, never by position.** A documented LangChain
  example matched a reviewer's decisions to tool calls by position, and a
  delete the reviewer meant to reject ran. UTP keys every answer by request id
  and revision.
- **Allowed responses are explicit per request**, as in LangChain's Agent
  Inbox: an approval offers approve, the narrower option, decline, or a
  free-text response. Free text that doesn't explicitly approve is a response
  and never counts as an approval; an explicit approval in the person's own
  words counts only when its scope fits inside an offered option.
- **End the turn and resume** (AG-UI, MCP's retry pattern, Claude Code's
  `defer`) rather than holding a process open while the person thinks.
- **Recommendations are shown, never pre-selected.** A pre-selected or
  endorsed option acts as a default (a meta-analysis of 58 studies found a
  medium effect, d = 0.68). A dialog that pre-selects an option is never used
  for a card that carries a recommendation: the adapter falls back to
  Markdown or the terminal review, and never reorders options or changes the
  recommendation to suit a tool. Deciding before seeing a recommendation reduces
  over-reliance, but it also lowers agreement when the advice is right, and
  people like it least. This person already overrides often, so phase 1 shows
  recommendations up front with their reasons; asking for the person's own
  pick first on one-way decisions is a phase 3 experiment, measured against
  later reversals.
- **Avoid:** overwriting or re-asking answered questions (open issues in
  spec-kit and Kiro), standing approvals that widen an agent's autonomy, and
  local review pages without authentication.

## Learning loop

- **Evidence as fixtures, honestly scoped.** Each evidence case is classified
  as lint-detectable, policy or adapter, or human-review. Lint-detectable
  cases become before-and-after fixtures that must fail on a named rule and
  pass after the fix; the other classes get their own tests (see
  [verification](verification.md)). Rules are written against half the
  cases and measured on the other half. The went-well cases are must-accept
  fixtures, and the person confirms a sample of classifications first.
- **Signals from real reviews:** time from shown to answered, one-tap
  feedback, recommendation chosen or overridden by category, own answers,
  waivers per rule, and reversals within 30 days.
- **`utp retro`** summarizes those signals and proposes template or policy
  changes as a `choose` request.
- **Templates are versioned**, so a change can be compared with the version it
  replaced.

## UTP reviews itself

The open decisions in [0001-concept-review](../decisions/0001-concept-review.md)
are UTP's first requests, rendered by hand in the v0 format. Review 0002
recorded D1 through conversation and captured D4, D5, and D6b through UTP's
terminal review. The terminal worked well for decisions without visual material.
Later decisions go through UTP. Redacted records go into `docs/decisions/`,
and feedback from those reviews drives the next template revision.

## Build phases

| Phase | Delivers | Done when |
|---|---|---|
| 0. Concept | This document set, research, roundtable review, the person's answers to D1 to D7 | Answers logged in `docs/decisions/` |
| 1a. Lifecycle | The service on the home server (`utp serve`) and the `utp` client, in TypeScript for Node 20 or later (decision D3); store, revisions, state machine, locking, execution grants, `ask`, `flush`, `wait`, `answer`, `claim-default`, `begin`, `applied`, `reconcile`, `revise`, `log`, `reverse`, exit codes; one complete `choose` flow through Markdown and the terminal review | Lifecycle, crash-resume, and concurrency tests pass with clients on Windows, macOS, and Linux against the service |
| 1b. Kinds and lint | `approve`, `handoff`, `clarify`, `accept`, `assumptions`, `notice` digests; `utp check` with both rule classes; fixtures; feedback and timestamps | Fixture recall and specificity targets met on the held-out half, with precision reported as defined in [verification](verification.md) |
| 1c. Adapters | Skills and instruction files for Claude Code, Codex, and Antigravity; conversation answers with transcript checks, demonstrated per platform; presentation receipts; `utp setup` for reaching the service from each platform's default sandbox; the resume path after an answer given outside the conversation; a Claude Code hook that checks a completion report exists | The scripted end-to-end run passes on each platform, and the real-use criteria in [verification](verification.md) are met |
| 1d. Batch review | Review page with previews, all cards in one window, and one save for batches of three or more (D5) | A batch saves answers bound to the displayed revisions, and page access and renderer conformance tests pass |
| 2. Rich review | Blind `judge` with side-by-side comparison and identical-candidate detection. Move existing blind comparison workflows to the shared page (D6b). Add native question dialogs | A real `judge` and a real `handoff` run through it, and renderer conformance passes for every channel |
| 3. Learning | `revisit`, `retro`, template versions, the metrics report | The first retro produces a change the person accepts |
| 4. Conveniences | Phone inbox channel, MCP server | Each ships only when it saves the person time |

## How we will know it works

Measures are defined, with sources and baselines, in
[verification](verification.md). In short: reversals within 30 days, counted
separately for answered decisions, decisions the agent made itself, and
decisions that were never logged, against a retrospective baseline from the
two weeks before UTP where one exists; the share of
cards marked `clear`; reviews per task and decisions asked twice, compared
with the baseline; the share of answers the person writes themselves; and a
sampled audit of applied answers against what the person chose. Active
response time is reported where a channel can measure it, without a target,
because a card answered the next morning says nothing about how hard it was
to answer.

## Risks

- **Question inflation.** Countered by the ladder, batching, one notification
  per review, `notice` digests, and tracking requests per session-hour.
- **Agents routing around UTP.** Writing prose is cheaper than filing a card.
  Countered by `utp new` templates with targeted fix hints, the close-out
  rule, and answering in the conversation so the person never has to leave
  it.
- **Fabricated or careless answers.** UTP can't stop an agent from writing a
  false answer. It makes one auditable: verbatim quotes, transcript checks,
  provenance on every answer, and stricter channels for approvals.
- **Linter false positives.** Heuristic rules are waivable with a visible
  reason, measured against must-accept fixtures and waiver rates.
- **Duplicating existing tools.** UTP generalizes the blind-ballot pages and
  uses the existing phone, notification, and open-items channels.
- **Privacy.** Stores live on the home server, outside code checkouts;
  public exports are redacted and leak-checked.
- **One service for everything.** When the home server or the service is
  down, no agent can ask or record anything (exit code 32), and agents fall
  back to asking in plain conversation. This is the accepted cost of one
  shared log (decision D2). The store is a plain folder on the server, so the
  server's existing backups can cover it.
- **Tokens on the home network.** Clients send their tokens over plain HTTP
  on the home network, like the server's other services; over Tailscale the
  link is encrypted. A token lets any agent on that machine act in every
  project; phase 1 records which machine acted rather than limiting it.
- **Forged answers on the review page.** Being on the home network isn't
  authentication: any process with a client token, or another website open
  in the browser, could try to post an answer. The page accepts an answer
  only with a random per-presentation token that only the person's browser
  receives, never printed to the agent's output, and checks the Host and
  Origin headers. That stops cross-site posts and an agent posting
  an answer by mistake. It can't stop a process running as the same user
  that sets out to read the token, which is the same limit the store has:
  UTP assumes cooperating agents and makes forgery auditable, not
  impossible.
- **Platform drift.** Adapters stay thin; the command line and store are the
  contract.

## Decisions

Asked in [0001-concept-review](../decisions/0001-concept-review.md). The
answers, with how each was recorded, are in
[review 0001](../decisions/0001-concept-review.answers.json) and
[review 0002](../decisions/0002-followup-review.answers.json).

| Decision | Answer (2026-11-22) |
|---|---|
| D1. Which request kinds ship in phase 1 | All seven everyday kinds. Side-by-side blind comparisons ship in phase 2 |
| D2. Where each project's decision log lives | One central log on the home server |
| D3. Implementation language | TypeScript on Node |
| D4. What the agent does when an answer hasn't arrived | Small local choices can use a default with a one-step undo. Larger technical defaults call for a panel, which advises within the person's authority |
| D5. Where the person answers by default | One or two questions in the conversation. Batches of three or more on one review page, which ships in phase 1 |
| D6. Which existing tools UTP absorbs, connects to, or leaves alone | All eight proposals kept. D6b confirms the existing blind comparison workflows move to UTP in phase 2 |
| D7. License for the public repository | MIT |
