# UTP Agent Workflow

UTP (user testing platform) turns agent-to-person decisions into structured
review cards and returns structured answers and execution grants through the
`utp` command line. Follow the judgement rules first, then use the command
reference below.

## 1. When to ask (the asking ladder)

Check whether you actually need to ask before creating a card:

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

Before asking a new question, check prior decisions and reversals with
`utp consider <decision.json>` or `utp log --tags <tags> --text <words>`. If a
prior reversal exists at the same or higher level, either raise the level or
record `reversal_reason` explaining why the reversal does not apply.

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

Set `UTP_SESSION` to a unique, stable per-session identifier before running
`utp` commands. Leaving `UTP_SESSION` unset or `"default"` triggers a `stderr`
warning, risks grant collisions between concurrent sessions, and disables chat
transcript verification.

Run `utp resume [<review-id>] --json` (or `utp status --json`) at the start of
a session or turn to inspect open, answered, or interrupted work in dependency
order, including local basis-file staleness and takeover checks:

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

After changing files or external state, map each goal or risk the person
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

## 6. Command reference

### Lifecycle commands

```sh
# 1. Check prior decisions and prepare a card or batch (all payloads in UTF-8 files)
utp status --json
utp history "search words" --json        # earlier reviews by title, question, or tag
utp follow-up <review-id> <card-id>@<rev> --file round.json --json
utp consider decision.json
utp new <choose|approve|handoff|clarify|accept|assumptions|notice|judge> --file card.json
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
