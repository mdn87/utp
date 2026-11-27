# UTP Agent Workflow

UTP (user testing platform) turns agent-to-person decisions into structured
review cards and returns structured answers and execution grants through the
`utp` command line. Follow the judgement rules first, then use the command
reference below.

## 1. When to ask (the asking ladder)

Use UTP when the next step depends on a person's choice, approval, judgment,
or an observation only they can make. For example, fix a failing export test
directly. Open a review if supporting the old export format would delay a
feature and the person needs to choose. A routine turn needs no UTP check.

At the first review in a Git checkout, run `utp init`. If it lists an existing
project for the same remote, use `utp link <project-id>` to join its decision
history. If it lists several, identify the intended project before linking.

- **Level 0 — Routine and reversible**: The intent is clear and the change is
  easy to undo locally. Proceed without asking. Record routine policy choices
  with `utp decide <decision.json>` (`"level": 0`, `"category"`) when tracking
  counts helps.
- **Level 1 — Already authorized or informational**:
  - If an earlier decision or user instruction already authorizes the exact
    action, target, and scope, check it first (`utp consider <decision.json>`,
    `utp decide <decision.json>`, or `utp log`) and reuse it with
    `utp wait <decision-id@revision> --authority-file <decision.json>` instead
    of asking again.
  - If you only need to inform the person of a completed or routine change with
    no reply needed, queue a `notice` card (level 1).
- **Level 2 — Reversible trade-off or clarification**: Different choices change
  the design or scope, or you need a manual step or judgment (`choose`,
  `clarify`, `handoff`, `accept`, `assumptions`). If a local, single-step-undo
  default is eligible under the project policy (D4), you may include a
  `default` block and claim it with `utp claim-default <request-id>` after the
  review is presented.
- **Level 3 — Consequential action**: Hard to undo, costly, or reaches outside
  the project (`approve`, or any `choose` option with an `authorization` at
  level 3). Wait for an explicit, verified answer before acting. Never guess,
  downgrade a level-3 action to level 2, or act on an unverified reply.

Before drafting a card, read the project's reviewer-selected decisions with
`utp pins --json`. If a pin has `stale: true`, check its revision and the
listed reasons. Execution still requires the usual grant.

Before asking a new question, check prior decisions and reversals with
`utp consider <decision.json>` or `utp log --tags <tags> --text <words>`. If a
prior reversal exists at the same or higher level, either raise the level or
record `reversal_reason` explaining why the reversal does not apply.

When what a logged decision rested on has changed, ask with a `revisit` card
(`utp new revisit`). Name the earlier decision by its request id, say what it
rested on and what is different now, and attach dated evidence. The options
are `keep`, `amend`, and `reverse`; write the amended decision as the label
of the `amend` option. Don't undo the earlier decision yourself, and don't
ask it again as a new question. After `amend` or `reverse`, the earlier
answer no longer authorizes anything, so put any authorization the next
action needs on the revisit card's own options.

## 2. Independent work, batching, and upfront channel routing

- Queue questions with `utp ask <card.json>` (or `utp decide <decision.json>`),
  or stage a full multi-card batch file in one step with
  `utp stage <batch.json> [--flush]`. Each `UTP_SESSION` keeps its own open
  draft review queue so parallel worktrees do not mix cards.
- Finish all independent work that does not depend on those answers, and flush
  once at a natural stopping point:
  `utp flush [<review-id>] --intent <intent.json>` (or `utp stage <batch.json> --flush`).
- Always attach authored review context (`asked`, `doing`, `scope_delta`) with
  `--intent <file>`. Include a short, recognizable `task_title` suitable for
  the person's lock screen. For multi-card batches, lift repeated facts once
  into `already_done`, `shared_glossary`, and `shared_evidence`, add per-option
  `agent_next` lines when helpful, and add `skip_if` rules when an earlier
  answer makes a later card moot. Keep private details in the review. Open
  every card in plain language stating what the decision addresses and what
  each choice changes.
- **Partial saves and strict approval text.** The review page lets the person
  answer settled cards while leaving others open or hidden, and shows a
  combined plan preview before saving. Any free text typed on an `approve` or
  authorized card withholds the execution grant and routes the card to
  `needs_clarification` (exit `21`); revise the card with `utp revise` (UTP
  generates an automatic revision diff banner showing what changed and why).
- **Blind comparisons (`judge`)**: Use `utp new judge` when the person should
  compare two artifacts without seeing their identities or recommendation until
  after voting. Put both candidates in `blind.candidates` (text, PNG, or MP4)
  and keep identifying names out of visible fields. Binary-media comparisons
  route directly to the side-by-side review page; once saved, a blind ballot is
  immutable and reveals identities, notes, and recommendation.
- **Native question dialogs (`utp dialog`)**: Before calling a platform's
  native question dialog (`AskUserQuestion`, `request_user_input`, or
  `ask_question`), run
  `utp dialog <review-id> --platform <claude|codex|antigravity> --json`. Only
  use the native dialog when `eligible` is `true`, and map its raw reply back
  with `--map-response <reply.json>` so answers stay bound to stable option IDs
  and exact revisions. Whenever `eligible` is `false` (for example, option or
  question caps, dropped fields, truncation, level-3 provenance, or a
  pre-selecting dialog on a card with a recommendation), fall back to
  `fallback_markdown`, `utp review`, or `utp page` without reordering options
  or altering the recommendation.
- **Never double-prompt on level-3 approvals.** Check `chat_provenance` from
  `utp status --json` or `utp flush --json`:
  - **1–2 non-level-3 questions**, or **1–2 questions including level-3 when
    `chat_provenance` is `true`**: `utp flush` prints Markdown. Show that exact
    Markdown in the conversation, then run
    `utp presented <review-id> --channel conversation`.
  - **3 or more questions**, or **any review with a level-3 consequential
    approval when `chat_provenance` is `false`**. Run `utp flush` to prepare
    the review. If the reviewer supplied a permanent protected inbox address,
    share it with them for access to all outstanding questions. Keep private
    addresses out of shared files. Without a supplied address, or when the
    reviewer requests a direct link, share the URL from `utp flush` or
    `utp page <review-id>`. They can also run `utp review <review-id>` in their
    own terminal.
  - If `utp answer --from-chat` or `utp wait` returns exit `18`, keep the
    request ID, revision and level. Use one of the verified channels above
    and resume with `utp wait <request-id>`.

## 3. File-only UTF-8 payloads

Always pass requests, intents, answers, chat quotes, authority decisions,
reversal reasons, and execution evidence as UTF-8 files (`--file`, `--intent`,
`--quote-file`, `--authority-file`, `--evidence`). Never pass inline JSON on
the command line, because quoting differs across PowerShell 7, Git Bash, zsh,
and bash.

## 4. Session identity (`UTP_SESSION`) and resuming work

UTP reads the native Codex thread or Antigravity conversation UUID. Claude
Code's SessionStart hook supplies its UUID through `UTP_SESSION`. An explicit
`UTP_SESSION` takes precedence. If UTP warns about the shared `default`
identity, set the active session's ID before queuing a card or using a grant.

When work pauses on a review, put its project, review ID, and the pending
card ID and revision in the task's existing handoff. Say which action is
waiting. On return, run `utp resume <review-id> --json` from that checkout.
It shows the saved answer, changed basis files, and the next action for each
card. If the ID is missing, use `utp history "<task or question>" --json` to
find it. An unqualified `utp resume --json` lists work across the project.
Continue only the review that belongs to the task.

1. **Same-session resume** (`UTP_SESSION` matches the session that queued the
   request): run `utp wait <request-id>` to fetch the answer and grant
   (`<grant-id>`), then `utp begin <grant-id>`, perform the exact authorized
   action, and run `utp applied <grant-id> --evidence <evidence.json>`.
2. **New-session resume** (the previous agent process exited and this session
   has a new `UTP_SESSION`):
   - Never spoof an old session's ID if the earlier action might already have
     started. Inspect the workspace and `utp show <request-id>` first.
   - If the request is `answered`, `presented`, or has an abandoned unused
     grant (`granted` or `default_claimed` after release or the idle window),
     claim ownership with `utp takeover <request-id>`, then continue with
     `utp wait <request-id>` -> `utp begin <grant-id>` -> act ->
     `utp applied <grant-id> --evidence <evidence.json>`.
   - If the request is `outcome_unknown` (an earlier session crashed after
     `begin` or reported a scope mismatch), inspect the workspace and record
     what actually happened with
     `utp reconcile <grant-id> --outcome <completed|not-performed|partial|different|unknown> --evidence <evidence.json>`
     before taking over or requesting another grant.

## 5. Close-out completion report

When closing a task that used UTP and changed files or external state, map each goal or risk the person
stated to evidence they can check. Write a UTF-8 JSON file and run
`utp closeout report.json`. Show the rendered report, including its queued
project notices, in your final response.

```json
{
  "goals": [{
    "id": "G1",
    "goal": "Include the date in each exported row",
    "coverage": "covered",
    "evidence": [{
      "claim": "Both exported rows include the expected date.",
      "kind": "observed",
      "source": "Export test and its output file",
      "date": "2026-01-15"
    }]
  }]
}
```

Use a unique ID for every goal. Choose `covered`, `partly_covered`, or
`not_covered`. For incomplete goals, say what remains and how you know.
Mark each evidence item as `observed` or `inferred` and give its date and
source. Exit code `20` identifies fields to fix. Use `--json` for structured
output.

Rendering delivers the queued notices shown in the report once so they do not
duplicate in the morning report; pass `--keep-notices` to keep them queued. If
the service is unavailable, the report still shows the goals and says the
notice queue could not be checked. Routine completion needs no reply. Use
`accept` when the person asked to sign off or only they can judge the result.
Read-only questions can end with a direct answer.

## 6. Example: status report with a proposed next batch

When the person asks where a project stands or what is left, answer with one
report they can verify and approve in a single reading. The report below is
fictional. Copy its order, its level of detail, and the way it divides the
work.

```markdown
**Outcome:** The exporter's v0.1 core, 16 tests, package build, and operator
guide are on `origin/main` (`4f2c9ab`), leaving Linux CI, a scheduled nightly
run, the staging deployment, and the monitoring link to take it from a tested
command-line tool to an unattended service.

### Current status (verified against the code, Git, and CI)

- **Already complete (verified on the Windows workstation):** CSV and JSON
  writers, the date column, the retry queue, the `export` command line, 16
  passing tests, the package build, and the guide (`docs/INDEX.md`).
- **Partly implemented:**
  - The timer unit runs `export verify` as a placeholder. No `export nightly`
    command yet combines the fetch, the export, and the failure alert.
  - `upload.py` builds signed upload requests, but nothing sends them yet.
  - Tests are unverified on Linux and macOS: CI runs 1041 and 1047 are queued
    because no runner is registered.
- **Unfinished outside the exporter:** the parent repository's `.gitmodules`
  has no exporter entry, the staging server has no service or timer
  installed, and the monitoring job does not read export results.

### Proposed next batch: nightly exports on staging with passing Linux CI (milestone 4a)

**Goal:** turn on Linux CI, ship a working `export nightly`, register the
submodule, and run the service and its nightly timer on the staging server
against real data.

| Order | Remaining outcome | Evidence and prerequisite | Completion check |
|---|---|---|---|
| 1 | Implement `export nightly` with tests, combining the fetch, the export, and the failure alert, and point the timer unit at it | `fetch.py` and `alerts.py` provide the pieces separately, and the timer unit runs `export verify` only. Stays inside the exporter. (Coarse effort: medium) | `pytest -v` passes the new nightly tests, including the offline and repeated-alert cases, and the commit is on `origin/main` |
| 2 | Register a Linux CI runner on the staging server and add the exporter to the parent repository's `.gitmodules` | CI runs 1041 and 1047 are queued, and `.gitmodules` has no exporter entry. Changes files in the parent repository. (Coarse effort: small) | CI passes on the new runner for the latest commit on `origin/main`, which verifies the Linux tests, and `git submodule status` is clean in the parent |
| 3 | Deploy `exporter.service` and `exporter-nightly.timer` on the staging server and run them against real data | Unit templates are ready in `deploy/`. Depends on step 1. (Coarse effort: small to medium) | `systemctl is-active exporter.service` reports `active`, `curl localhost:8080/health` returns 200, `systemctl list-timers exporter-nightly.timer` shows the next run, and one `export nightly` run completes on the staging server |
| 4 | Add export row counts to the monitoring job's configuration so its half-hourly checks cover the exports | The monitoring job already runs every 30 minutes on the staging server. Independent of step 2 once step 1 fixes the result file's layout. (Coarse effort: small) | The job's configuration check and tests pass, and its latest report shows export row counts |

Independent work: step 1 can finish inside the exporter even if the
parent-repository and staging steps are put off.

### Explicitly deferred out of this batch

- **Milestones 4b and 5:** sending the signed uploads that `upload.py`
  builds, the dashboard status card, automatic retries across regions, the
  pull-request advisory check, and macOS verification.
- **A separate decision for you, not touched here:** pinning the two
  dependencies that currently float. This batch only reports them as
  unpinned.

Run this batch, including the parent-repository change and the deployment to
the staging server? Reply `go`.
```

What to copy from it:

- **Format.** The outcome comes first, in one sentence: what has landed and
  what remains between that and the goal. Status, the proposed batch, the
  deferred work, and a single question follow in that order.
- **Level of language.** Each claim names something the person can check: a
  commit, a file, a command, a CI run. The status heading says what the
  claims were verified against, and the first bullet says where. A partly
  built piece is described by what it does today and what is missing. A
  claim that could not be verified says so and gives the reason.
- **Breakdown.** Status separates complete work, partly implemented work,
  and work that remains outside the project. Every item that status lists as
  partly implemented or unfinished appears again, either as a step in the
  batch or in the deferred list. The batch has a name and a one-sentence
  goal. Each step has its own evidence, any prerequisite, a coarse effort,
  and a completion check the person could run against that step's outcome.
  The report names the steps that change things outside the project and the
  step that can finish independently. Deferred work and decisions that stay
  with the person are listed apart from the batch, so the approval covers
  the batch and nothing else.

The closing question follows the asking ladder in section 1. This batch
changes another repository and a server, which makes it level 3: ask with an
`approve` card whose `authorization` names the parent repository and the
server, and offer step 1 alone as the narrower option. Carry the report into
the review intent: completed work in `already_done`, the goal in `doing`, and
each deferred item in `scope_delta.deferred` with its reason. When an earlier
instruction already covers the batch, replace the question with a line saying
that work is starting.

Asking where a project stands is a read-only question: the report is the
direct answer, and it needs no close-out record (section 5). Its closing
question concerns only the proposed batch, which has not started. When
nothing actionable remains, say so and end without a batch or a question.

## 7. Command reference

### Lifecycle commands

```sh
# 1. Check prior decisions and prepare a card or batch (all payloads in UTF-8 files)
utp status --json
utp pins --json                           # decisions the reviewer wants visible in this project
utp history "search words" --json        # earlier reviews by title, question, or tag
utp follow-up <review-id> <card-id>@<rev> --file round.json --json
utp consider decision.json
utp new <choose|approve|handoff|clarify|accept|assumptions|notice|judge|revisit> --file card.json
utp check card.json
utp ask card.json --json                 # or: utp decide decision.json --json
utp stage batch.json --flush --json      # validate, check D4/order/notices, queue, and flush

# 2. Finish independent work, then flush once with authored context
utp flush --intent intent.json           # prints Markdown (chat) or review page URL
utp dialog <review-id> --platform <claude|codex|antigravity> --json  # check native dialog fit

# 3a. If routed to chat: show exact Markdown to the person, then record presentation
utp presented <review-id> --channel conversation --json

# 3b. Record a chat reply (write the person's complete turn to quote.txt)
utp answer <request-id@revision> --from-chat --presentation <presentation-id> --quote-file quote.txt

# 3c. Share the supplied protected inbox, or get a direct link for this review.
utp page <review-id>
# Person runs in their own terminal: utp review <review-id> (or utp review --recent)

# 4. Resume or wait for answer/grant, execute the exact authorized scope, record evidence
utp resume [<review-id>] --json          # single-call dependency-ordered status + basis check
utp wait <request-id> --json             # returns grant.id (G-...) when authorized
utp begin <grant-id>
# ... perform the exact authorized action ...
utp applied <grant-id> --evidence evidence.json
```

### Defaults, clarification, cancellation, and recovery

- **Clarification requested (exit `21`)**: read `clarification.note`, explain
  the goal or choices plainly, update the card file, and revise the same
  request: `utp revise <request-id> revised-card.json` (then re-flush and
  re-present).
- **Eligible level-2 default**: `utp claim-default <request-id> --json` (exit
  `15` returns `<grant-id>`) -> `utp begin <grant-id>` -> perform ->
  `utp applied <grant-id> --evidence evidence.json`.
  - If the person answered before `claim-default`, exit `16` tells you to run
    `utp wait <request-id>` and follow their answer.
  - If the person answered after `claim-default` before `begin`, `begin`
    returns exit `17`; run `utp wait <request-id>` to get the grant for the
    person's answer.
  - If a contradicting answer arrives during `executing` or after `applied`,
    `applied` or `wait` returns exit `14` (`late_conflict`); resolve with
    `utp resolve-late <request-id> --resolution keep` or
    `utp resolve-late <request-id> --resolution redo --json` (for `redo`, run
    `begin` -> redo -> `applied` on the new `<grant-id>`).
- **Cancel an unneeded request**: `utp cancel <request-id>`.
- **Release an unused grant**: `utp release <grant-id>`.
- **Reconcile an interrupted or mismatched grant**:
  `utp reconcile <grant-id> --outcome <completed|not-performed|partial|different|unknown> --evidence evidence.json`
  (include `"remaining_scope"` in `evidence.json` for `partial`).
- **Take over from an ended or idle session**: `utp takeover <request-id>`.
- **Record a later decision reversal**: `utp reverse <request-id> --file reason.json`.
  Use it for a reversal the person didn't answer through a card. When the
  person should decide, ask with a `revisit` card.

### Exit-code dispatch table

| Code | Meaning | Required action |
|---|---|---|
| `0` | Done or answered | Continue with the returned answer or grant. |
| `10` | Still waiting | Do independent work or exit cleanly; resume with `utp status` / `utp wait`. |
| `11` | Stale precondition | A basis file changed. Inspect what changed and run `utp revise <request-id> <file>`. |
| `12` | Cancelled | Stop work depending on this request. |
| `13` | Expired | Re-ask with `utp revise <request-id> <file>` if still needed. |
| `14` | Late conflict | A late answer contradicted an applied default. Run `utp resolve-late <request-id> --resolution keep\|redo`. |
| `15` | Default claimed | Default grant issued (`grant.id`). Run `utp begin <grant-id>` then `utp applied`. |
| `16` | Person answered first | Run `utp wait <request-id>` and follow the person's answer instead of the default. |
| `17` | Revoked | The grant or decision was revoked, superseded, or reversed. Do not act; inspect `utp show` or `utp wait`. |
| `18` | Provenance required | Keep the request ID and revision. Use the supplied protected inbox, `utp page <review-id>`, or `utp review <review-id>` for a verified answer. |
| `19` | Not allowed now | Wrong state or order (for example `applied` before `begin`). Check `utp show` and fix the step order. |
| `20` | Check failed | Fix the reported schema/lint issues or add an explicit waiver with a plain reason. |
| `21` | Clarification requested | Read `clarification.note`, explain clearly, and call `utp revise <request-id> <file>`. |
| `30` | Store busy | Retry the same command with the same `--op-id`. |
| `31` | Lease epoch outdated | Another session took over the request. Stop acting on old grants and check `utp status`. |
| `32` | Service unreachable | Check `utp setup <platform>` sandbox access or server health. Never proceed with a level-3 action on exit `32`. |
| `40` | Not found | Verify the ID or link the checkout with `utp init` / `utp link`. |
| `1` | Usage or other error | Fix the command arguments or file format and retry. |
