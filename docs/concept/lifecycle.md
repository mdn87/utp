---
title: UTP lifecycle
status: v0.9, store moved to the home server per decision D2
updated: 2026-11-22
---

# UTP lifecycle

How requests and answers are stored, identified, moved through states, bound
to what the person saw, and acted on safely when several agents and sessions
share a project. Read [the concept](concept.md) first.

## Store

- **One central store on the home server** (decision D2, answered
  2026-11-22). A small service, `utp serve`, runs on the home server and
  keeps every project's log under its data folder:
  `<data>/stores/<project-id>/`. Every `utp` command on every machine sends
  its operation to the service, which is the only writer. Current state is a
  projection rebuilt from the event log.
- **Clients.** Each machine's `utp` keeps the service address and that
  machine's token in `~/.utp/config.json`, readable only by the user;
  `UTP_SERVER` overrides the address. The person creates tokens on the server
  (`utp token create <machine>`), and the service stores only their hashes.
  In phase 1 every token has the same rights; each answer records the
  machine and channel it came through. Each command also names its session
  through `UTP_SESSION`, which adapters set to the agent's session id. Grants
  belong to a machine and a session, so without it every command on that
  machine counts as one session.
- **No service, no UTP.** When the service can't be reached, every command
  fails with exit code 32 and lists the likely causes: the service is down, a
  sandbox blocks network access, or the address is wrong. Phase 1 has no
  local fallback; that is the accepted cost of one shared log.
- **Sandboxed agents need network access to it.** `utp setup <platform>`
  shows the setting that lets that platform's sandbox reach the service and
  applies it after the person confirms. For Codex's `workspace-write` mode
  that is `[sandbox_workspace_write] network_access = true`, which opens all
  outbound network for that agent, not just UTP, and the setup step says so.
  UTP never asks for a sandbox exception per request.
- **The network path.** The service listens on one port that the home
  server's firewall allows from the home network only; the person adds that
  rule. Traffic is plain HTTP on the home network, like the server's other
  services, so tokens cross the network unencrypted; over Tailscale the link
  is encrypted.
- **Project identity is a registration, not a guess.** `utp init` asks the
  service for a new random project id and records the checkout in this
  machine's registry, `~/.utp/registry.json`, keyed by its Git common
  directory. Worktrees of a registered checkout share that directory and join
  the same project automatically. Another clone, on this machine or another,
  joins with `utp link <project-id>` once the person or agent confirms; until
  then UTP refuses to queue requests for it, and `utp init` there points out
  a registered project with the same remote. A checkout already registered
  to a different project can be relinked only while neither project has open
  requests or active grants; the old project's records stay searchable from
  the new one as a read-only archive, labeled with their origin, and nothing
  in them can be answered, granted, or applied. Forks and unrelated
  repositories stay separate unless linked. History is never used as the
  identity, so shallow clones, repositories with several roots, and new
  repositories need no special handling.
- **One log across machines.** A project worked on from several machines has
  one log, and lookups see every machine's decisions.
- **Search is project-scoped:** `utp log --tags`, `--related`, `--text`, and
  `--kind`.
- **Publishing is an explicit export.** `utp export --redact` writes selected
  records, such as UTP's own design decisions, to a folder for committing, and
  runs the leak check on what it writes.

## Crash-consistent writes

The service handles one write at a time per project, holding the store's
OS file lock, which also stops a second service instance from writing. Each
write does this in order:

1. Writes each payload (a request revision's body) to a temporary
   file, flushes it to disk, and renames it into place under its content
   hash. A crash here leaves an unreferenced file, which is ignored.
2. Appends one event line, ending in a newline, that references the payloads
   by hash and carries the operation id and the operation's result. Answers,
   grants, and evidence are small and travel inside the event line itself. The
   event is the commit point, and the only record of the operation.

A retry with the same operation id finds the committed event and returns the
result stored in it, so no step can commit a mutation without its result. On
start and on every lock acquisition, the service checks the log's last line. A line with no final
newline or that doesn't parse is a torn write: it is moved to a quarantine
file and its operation counts as not done, so a retry performs it once.
Because payloads are written before the event that references them, an event
never points at a missing file.

## Identifiers

- **Request**: `R-<date>-<random>` plus a revision number starting at 1. Any
  change to the question, options, consequences, evidence, default, or
  authorization creates a new revision through `utp revise`, which in one
  step supersedes the old revision and revokes its outstanding grants.
  Answers name the revision they answer.
- **Options, goals, items, and steps**: short ids that are stable within a
  request. A new revision may add ids but never reuses one with a different
  meaning.
- **Reviews** `V-...` list request revisions. **Presentations** `P-...` record
  each time a review reached a channel, with the channel, time, and revisions
  carried.
- **Execution grants** `G-...`: permission to act once on one answer or
  claimed default (see below).
- **Operations**: every mutating command accepts `--op-id`.
- **Lease epochs**: a counter that increases each time ownership of a grant
  changes hands.

## States

| Status | Meaning |
|---|---|
| `draft` | Written, not yet checked |
| `queued` | Passed `utp check`; waiting in an unflushed review |
| `presented` | At least one presentation receipt exists |
| `hidden` | The person chose "hide until"; returns to `presented` at that time |
| `answered` | An answer or a disposition (`answered elsewhere`, `no longer matters`) is recorded |
| `default_claimed` | The agent reserved its stated default under the level-2 rules |
| `granted` | An execution grant is active for the current answer |
| `executing` | `utp begin` passed; the agent is performing the effect |
| `applied` | The agent recorded what it did, with evidence |
| `late_conflict` | An answer contradicting a used default arrived |
| `stale` | A precondition changed before the agent began acting |
| `outcome_unknown` | An effect may or may not have happened and hasn't been reconciled |
| `closed` | A `notice` was presented; notices need no answer |
| `expired`, `cancelled`, `superseded` | No answer in time; withdrawn by the agent; replaced by a newer revision |

Allowed transitions:

| From | To |
|---|---|
| `draft` | `queued`, `cancelled` |
| `queued` | `presented`, `cancelled`, `superseded` |
| `presented` | `answered`, `hidden`, `default_claimed`, `stale`, `expired`, `cancelled`, `superseded`, `closed` (notices only) |
| `hidden` | `presented`, `answered`, `cancelled`, `superseded` |
| `answered` | `granted`; `answered` (the person revises the answer); `presented` (the person withdraws it); `stale`; `cancelled`; `superseded` |
| `default_claimed` | `executing`; `answered` (an answer arrived before `begin`, releasing the claim); `presented` (the unused claim ran out or was released; no answer exists); `stale`; `cancelled`; `superseded` |
| `granted` | `executing`; `answered` (the person revised the answer, or the grant ran out unused); `presented` (the person withdrew the answer); `stale`; `cancelled`; `superseded` |
| `executing` | `applied` (the reported effect matches the authorization); `outcome_unknown` (the lease ran out without `applied`, or the reported effect differs) |
| `applied` | `late_conflict`, only when the effect came from a claimed default |
| `late_conflict` | `applied` (keep the default: the resolution is recorded and no work is done); `granted` (redo the work: a fresh grant under the later answer, scoped to the redo and checked against the state the default left, which then runs through `begin` and `applied`; the original application and the conflict stay in the log); `stale` (an unrelated change to the target before the redo) |
| `stale` | `superseded` (re-asked as a new revision) |
| `outcome_unknown` | `applied` (reconciled as completed, or as different from what was authorized, flagged); `answered` (reconciled as not performed, or partly performed, while a current answer exists, including one given after a default was begun); `presented` (the same two outcomes when no current answer exists: a claimed default nobody answered, or an answer withdrawn after `begin`); `stale` (the partial effect left the target in a state the authorization didn't anticipate) |

`closed`, `expired`, `cancelled`, and `superseded` are terminal; `applied` is
terminal except for the late-conflict path. A late answer that agrees with a
used default is recorded as a confirmation and changes nothing. A correction
after an effect is recorded as a reconciliation entry and may lead to `utp
reverse`; it never rewrites history. No path leads from `expired`,
`cancelled`, `hidden`, `closed`, or a wait timeout to an approval.

## Execution grants

An agent never acts on an answer or a default directly; it acts under a
grant.

- **Issue.** `utp wait` issues a grant when an answer authorizes an action, and
  `utp claim-default` issues one for a reserved default after checking the
  preconditions and that no answer has arrived. A grant records the owner
  session, the lease epoch, the authorization (action, target, scope, and
  expected effect), the preconditions checked at issue, and the provenance
  of the answer behind it.
- **Provenance follows the effect.** The stricter approval rules apply to
  any answer that authorizes a level-3 effect, whatever the request kind: a
  `choose` answer that will be carried out as an outward or hard-to-reverse
  action needs the same provenance as an `approve` answer. `wait` refuses to
  issue a grant for a level-3 effect from an answer with weaker provenance,
  and authority reused from the log is checked the same way.
- **Begin.** Immediately before the side effect, the agent runs `utp begin
  <grant>`. Under the lock, `begin` re-checks that the grant is still active
  (not revoked, expired, or superseded), that its epoch is current, and that
  the preconditions still hold. If any check fails, the agent must not act.
  `begin` marks the grant used.
- **Applied.** After the effect, `utp applied <grant>` records what happened,
  including the effect. UTP compares it with the expected effect. An
  authorized change to the target (the ten approved files are gone) is the
  success case, not a stale basis; the preconditions are not re-checked after
  the action that was supposed to change them. An unexpected result is
  flagged and stays `outcome_unknown` until reconciled.
- **Revoke.** The person can revise or withdraw an answer at any time before
  `begin`. That revokes outstanding grants, and `begin` refuses a revoked
  grant. A new revision of the request (`utp revise`) revokes every grant for
  the old revision in the same step, even when no precondition changed. After
  `begin`, a correction can't stop the effect already under way, but it is
  recorded as the current answer for everything that follows: reconciliation
  never issues a new grant under an answer the person has since withdrawn or
  narrowed.
- **Leases.** A grant's lease runs 24 hours by default. An unused answer
  grant that runs out returns the request to `answered`. An unused default
  claim that runs out is released and the request returns to `presented`
  with no answer recorded; the agent may claim the default again if the
  level-2 rules still allow it, without a new question. A used grant that
  runs out without `applied` moves the request to `outcome_unknown`, and it
  appears in the next review.
- **Reconcile.** `utp reconcile <grant> --outcome <outcome> --evidence
  <file>` records what recovery found:
  - `completed`: the request moves to `applied`.
  - `not-performed`: the request returns to `answered` when a current answer
    exists, including one the person gave after a default was begun, and to
    `presented` when none does. A new grant can be issued under the current
    answer, never the default it replaced, after the
    preconditions are checked again, without asking the person again. If the
    person withdrew the answer after `begin`, the request returns to
    `presented` and nothing more is done; if they narrowed it, the new grant
    covers only the narrowed scope.
  - `partial`: the part that happened is recorded, and the request returns
    with the rest still authorized under the current answer, so the next
    grant covers only what's left. The reconciliation entry records a
    recovery basis: the remaining scope and the expected state of the target
    after the recorded partial effect. Later grants check that recovery basis
    instead of the original fingerprint, so any other change to the target
    still makes the request `stale`. If the partial effect itself left the
    target in a state the authorization didn't anticipate, the request
    becomes `stale` and is asked again.
  - `different`: the request moves to `applied`, with the mismatch flagged
    and shown in the next review.
  - `unknown`: the request stays in `outcome_unknown` and is shown in the
    next review.

  Every reconciliation is a new log entry; nothing earlier is rewritten.
- **Takeover.** `utp takeover` of an unused grant (no `begin` recorded) is
  allowed as soon as its owner session has ended (an ending session gives its
  unused grants back with `utp release`), or after the grant has sat
  idle for 15 minutes. A used grant can be taken over only after its lease ran
  out and its outcome was reconciled, or when the person explicitly
  authorizes it. Takeover increases the epoch under the lock, so the former
  owner's later `begin` and `applied` are refused. A new owner never repeats
  an uncertain effect before reconciling it: it checks the external state, or
  uses an idempotency key the target supports.
- **What this can't prevent.** UTP can't stop a process outside it. An old
  owner that passed `begin` and then paused can still act after a takeover.
  Adapters narrow that window with target-side idempotency keys or
  conditional writes where the target supports them, and takeover waits for
  reconciliation for the same reason.

## Presentation receipts

UTP keeps three facts apart:

- **Prepared**: `utp flush` wrote the review. Nothing has reached the person.
- **Presented**: a channel reports that the review reached a surface the
  person reads. In the conversation, the adapter confirms the review id
  appears in a message the agent sent, checked against the session transcript
  where one exists; the review page records when it rendered the card; the
  terminal review records when it displayed it.
- **Acknowledged**: the person answered at least one card in that
  presentation, or replied after it.

A level-3 request lists the level-1 decisions it depends on, so they are
presented exactly when they matter. No separate acknowledgement of notices
is ever requested.

## Binding

- **Revision.** An answer names the request revision it answers. An answer to
  an old revision never applies to a newer one.
- **Presentation order.** An answer given in the conversation counts only if
  the person's turn comes after a presentation of that revision and before any
  later presentation that superseded it.
- **Authorization.** Each `approve` option, and a custom approval whose scope
  falls inside an offered option, defines its effective action, target,
  scope, and expected effect
  (for example, the exact list of files). The grant carries the selected
  authorization; adapters pass the authorized scope into the command where
  they can. The comparison at `applied` is an audit after the fact; it can't
  undo a side effect.
- **Preconditions.** Each request names the parts of its basis that must
  still hold when the agent acts: the files cited as evidence and, for every
  option the agent will carry out as an action, on `approve` or any other
  kind, the target's state before the action. UTP fingerprints them when the
  request is asked and checks them at grant issue and at `begin`. Once the
  log records an effect on the target (a partial effect found by
  reconciliation, or an applied default followed by a late conflict), later
  grants check a basis derived from the original fingerprint plus that
  recorded effect, the state the target is expected to be in now; any other
  change still counts. A
  change before `begin` makes the request `stale`, and the agent re-asks with
  a new revision, which may offer the earlier answer as its default ("you
  answered B; still B?"). Changes elsewhere in the repository don't count.

## Deduplication

A request carries a `dedupe_key` chosen by the agent. `utp ask` attaches a
new request to an open one only when they are equivalent: same kind, and the
same question, options, consequences, authorization, and preconditions after
normalization. A request with the same key but different content becomes a
separate request, and the agent is told about the near-duplicate. When
requests attach, only the first asker can hold an execution grant; the others
are observers that receive the answer. An observer that needs to act files
its own request.

## Notifications

- The request is stored before anything is sent.
- Requests queue silently into the current review. `utp flush` prepares the
  review for the conversation and sends one notification for the whole batch
  to any other channel the person uses, with the review id as its
  deduplication key, so a retried notification is harmless.
- `notice` items never notify on their own; they ride with the next review or
  the daily report.

## Command-line contract

| Verb | Does |
|---|---|
| `utp init`, `utp link` | Register a project; link another checkout to it |
| `utp serve` | Runs the service on the home server |
| `utp token create <machine>` | Creates a client token (run on the server by the person) |
| `utp connect <url>` | Saves the service address, and this machine's token read from standard input, in `~/.utp/config.json` |
| `utp setup <platform>` | Shows, and after confirmation applies, the sandbox setting that lets that platform's agents reach the service |
| `utp new <kind>` | Writes a request template with fix hints |
| `utp check <file>` | Runs structural checks and heuristics; prints each failure with its rule id and how to fix it |
| `utp ask <file>` | Checks, stores, attaches when equivalent, queues into the current review |
| `utp flush` | Prepares the current review and sends one notification |
| `utp presented <review>` | Records a presentation receipt (adapters call it) |
| `utp show <id>` | Renders a request or review as Markdown or JSON |
| `utp review` | Interactive review in the person's own terminal |
| `utp answer <id>` | Records or revises an answer; `--from-chat` takes a verbatim quote and checks it against the session transcript |
| `utp wait <id> --timeout <s>` | Waits for an answer and issues an execution grant when it authorizes an action |
| `utp claim-default <id>` | Reserves the default and issues a grant, or returns the answer that already won |
| `utp begin <grant>` | Re-checks the grant, epoch, and preconditions immediately before the effect |
| `utp applied <grant> --evidence <file>` | Records what the agent did, including scope and effect |
| `utp reconcile <grant> --outcome <outcome>` | Records what recovery found after an uncertain effect |
| `utp release <grant>` | Gives back an unused grant, for example when a session ends; the request returns to `answered` |
| `utp revise <id> <file>` | Writes a new revision, superseding the old one and revoking its grants |
| `utp cancel`, `utp reverse`, `utp takeover` | Withdraw, record a reversal, take over after reconciliation |
| `utp log`, `utp status` | Search the log; show what is waiting |
| `utp export --redact` | Write a redacted copy for publishing |

- Requests and evidence are passed as UTF-8 JSON files, never as inline
  arguments, because quoting differs between PowerShell, bash, and zsh.
- `--json` prints machine-readable results for agents; the default output is
  Markdown for people.
- Exit codes: 0 success or answered; 10 still waiting; 11 stale (a
  precondition changed); 12 cancelled; 13 expired; 14 late conflict; 15
  default claimed; 16 an answer arrived first; 17 grant revoked (answer
  revised or withdrawn, or request superseded); 18 the answer lacks the
  provenance its action needs (see "Provenance follows the effect"); 19 not
  allowed in the request's current state; 20 check failed; 30 store
  busy (safe to retry); 31 lease epoch outdated; 32 can't reach the UTP
  service (check the service, or run `utp setup` in a sandbox); 40 not found; 1 any other error.
- Supported lanes, tested separately: PowerShell 7 and Git Bash on Windows,
  zsh on macOS, bash over SSH on Linux.

## Privacy

- Stores live on the home server, outside code checkouts, so a commit can't
  include them.
- `utp export --redact` runs a leak check: generic patterns (absolute paths,
  email addresses, IP addresses, token shapes) plus a private deny-list kept in
  the user's UTP configuration, never in a repository. The public repository's
  CI runs the generic patterns over committed fixtures and exports.
- The phone channel keeps its existing rule of purging question and answer
  text within 24 hours; the durable record stays in the UTP store.
