# UTP: user testing platform

When you build software with coding agents, you are the only test for some
things: whether the agent understood what you meant, whether a design looks
right, whether a result is acceptable, and whether a risky step should go
ahead. Agents usually ask those questions inside long, conceptual chat
replies, and the decision is easy to miss, misread, or answer without
understanding it. Some of those answers get reversed later, at real cost.

UTP turns those moments into structured reviews. The agent writes a typed
decision request (what is being decided, the options and their concrete
consequences, its recommendation, and what it will do with each answer).
UTP renders it as a short review in a terminal, a review page, or a
desktop app, and returns your answer to the agent as structured data. Every
decision is kept in a decision log so that later sessions, and other agents,
don't relitigate or silently undo it.

## Status

Phase 1 is built and tested: the `utp` command, the shared decision service,
the crash-safe event log, the request state machine, execution grants, all
seven everyday request kinds, the quality linter, thin platform adapters, the
close-out completion report, and the zero-JavaScript browser review page and
reviewer inbox. [Review 0002](docs/decisions/0002-followup-review.answers.json)
settled the phase 1 scope and default policy, and
[Review 0003](docs/decisions/0003-workflow-improvements.export.json) approved
six workflow and review-page upgrades: per-session draft queues and
`utp stage`, shared review briefs with one-tap clarity chips, partial batch
saves with strict approval clarification, automatic revision diff banners,
actionable default/notice controls with close-out deduplication, and live
pickup status with a pre-execution edit window and `utp resume`. Phase 2 rich
review adds side-by-side blind `judge` comparisons (with PNG/MP4 metadata
stripping and immutable ballots) and lossless native question dialog mapping
with mandatory fallbacks (`utp dialog`). Phase 3 has started with the
`revisit` card, which asks the person to keep, amend, or reverse a logged
decision whose basis has changed. Start with:

- [Concept](docs/concept/concept.md): what UTP is, the kinds of decisions it
  handles, the request and answer formats, and the build phases.
- [Prior art](docs/research/prior-art.md): open-source projects, protocols,
  and research on agent-to-person decisions.
- [Decision failure patterns](docs/research/decision-failure-patterns.md):
  how real agent-session decisions went wrong and had to be reversed.

## Try it

UTP needs Node 20 or later. `npm ci && npm test` builds it and runs the
tests; run it as `node dist/src/cli/main.js`, or `npm link` to put `utp` on
your PATH.

On the home server:

```sh
utp token create laptop    # prints the laptop's token once
utp serve --host 0.0.0.0   # port 7340; allow it from the home network only
```

On the laptop, inside a checkout:

```sh
utp connect http://homeserver:7340 < token.txt
utp init
utp new choose --file question.json   # fill it in, then:
utp ask question.json                 # or: utp stage batch.json --flush
utp flush --intent context.json       # shows chat cards or prepares a batch review link
utp review                            # the person answers in their own terminal (--recent to inspect/edit)
utp resume                            # single-call dependency-ordered status + basis check
utp wait <request-id>
```

Save the following fields in `context.json` before flushing. Use the person's
request for `asked`, describe the agent's next action in `doing`, and give
each scope change a reason.

```json
{
  "task_title": "Spring catalogue",
  "asked": "Prepare the spring catalogue.",
  "doing": "Choose the order of its entries.",
  "scope_delta": "none"
}
```

Use `task_title` for a short name you would recognize on a phone lock screen.
The notification provider receives this name when you supply it. The full
request and scope stay in the review.

For changed scope, use an object with `narrowed`, `deferred`, and `added`
arrays. Each entry has an `item` and a `reason`. You can also pass a complete
checked batch to `utp flush <review-id> --intent batch.json` after queuing its
cards. UTP checks that the queued cards match the file in order. Markdown,
the terminal, and the browser show this context when you reopen the review.
Reviews saved without authored context say so.

One or two questions appear as chat cards. Three or more questions open on
one private review page with one save. Notices do not count toward the cutoff.
After flushing, `utp page <review-id>` also prepares a link for a smaller
review with previews. The page lets you save the batch together and leave optional
feedback. Use `utp review --feedback` for the same ratings in your terminal.
`utp show <id> --json` includes the presentation and answer times. Interactive
terminal answers include elapsed time per card. A review page records one
elapsed time for the batch from opening the page to saving it.

Each card opens with what the question addresses. In the terminal, type
`?` when the question or choices are unclear. On the review page, use
**Ask for clarification**. You can send a note about what needs explaining.
The question stays open, and the agent sees your request for clarification
when it checks the review.

### Find an earlier review and start a follow-up

In the reviewer inbox, search by task title, question, or tag. Open a result
to read the saved choices and answers. Select the cards to revisit, add any
new ideas (one per line), and choose **Start follow-up**. The new review
records the source review, each selected revision, and its earlier decision.
It starts with every answer open. Ordinary reversible choices keep their
options. For an approval, blind ballot, or other action, the new question
asks whether to revisit it. New ideas offer **Pursue**, **Defer**, or **Drop**.

From the project checkout, `utp history "planning round"` lists matching
reviews and card revisions. Pass the displayed identifiers to the next command.

```sh
utp follow-up <review-id> <card-id>@1 <another-card-id>@2 --file round.json
utp review <new-review-id>
```

The optional UTF-8 file can contain `{"title":"Next round","ideas":["Browse by date"]}`.
Use `--json` with `history` or `follow-up` for structured output.

### Pin a decision for later reviews

Open a saved card in the inbox and choose **Pin decision**. Later reviews in
the same project have a **Pinned decisions** section with the original answer
and a link to its card. You can also pin from a saved receipt or the terminal.

```sh
utp pin <card-id> --note "Applies to all extensions"
utp pins --json
utp inbox
utp unpin <card-id>
```

The note is optional. Both `utp inbox` and `utp review` show pins before the
waiting questions. A pin keeps the answer and revision you selected. If the
answer changes or is withdrawn, reversed, or superseded, its label tells you
what happened. In JSON, check `stale` and `reasons` before relying on a pin.
Choose **Unpin** to remove it from later reviews.

### Recording a chat reply

Show the Markdown from `utp flush` in the conversation. Then run the printed
`utp presented` command. UTP records which revisions appeared. Opening the
browser page or displaying a terminal review records its own presentation.
The presentation gains an acknowledgement when the person answers or asks
for clarification. Creating a page link leaves the cards queued.

UTP uses the native Codex or Antigravity session UUID automatically.
Claude Code's session hook supplies its UUID through `UTP_SESSION`.
Save the person's complete turn in `reply.txt` and record it with the displayed revision.

```sh
utp answer <request-id@revision> --from-chat --presentation <presentation-id> --quote-file reply.txt
```

The service checks the visible review and the later person-typed reply in
the same conversation. The reply can name a card and option, as in
`A: b`. When reviews overlap, use the full request ID and revision.
A single, freshly presented approval can take a bare `yes`. A question
or uncertain reply keeps the decision open. For a limited approval, put
the permitted entries in the option's scope as a comma-separated list of
identifiers. UTP records the subset the person names. Repeat the recorded
scope back to the person. A wider request needs a revised card.

The service operator can register native transcript directories in
`transcript-sources.json` in the service data directory, or point
`UTP_TRANSCRIPT_SOURCES` at that configuration file. Each key is the machine
name on its UTP token. Its `codex` entry points to that machine's native
`sessions` directory and its `claude` entry to its native `projects`
directory. Use absolute directories the service can read. The verifier
reads the native session on demand and stores the matched quote and turn
reference with the decision. Antigravity and machines without a readable
source use the person's terminal or review page for consequential approvals.

### Checking a draft

Run `utp check question.json` to see each failing rule and its suggested
repair. Add `--json` for the rule IDs, messages and whether each issue can
be waived. The same checks run when an agent queues or revises a request.
For a batch file, use `review.requests` for the cards and `review.intent`
for what the person asked, what the agent is doing, and any change of scope.

Structural rules require the fields needed to act on each kind of request.
For example, an approval needs dated evidence and a smaller authorized option
that names the wider option in `narrower_than`. For an indivisible action,
explain why in `narrowing_reason`.

Seven heuristics flag undefined terms, unsupported status claims, incomplete
evidence, unfocused questions, incomplete recommendations, vague scope and
missing material for a judgment. Fix the flagged text or add a reason to
the request, for example `"waivers": [{"rule": "H01-definition", "reason":
"The reader needs the exact code printed on the tray."}]`. The terminal,
Markdown and browser card show that reason whenever the revision is read.

After building, run `node scripts/score-lint.mjs` to reproduce the measured
recall, specificity and precision. [Evaluation and known misses](docs/research/review-quality-evaluation.md)

### Sandbox setup and resuming a review

`utp setup codex`, `utp setup claude`, and `utp setup antigravity` preview
the network access the selected agent needs. Add `--apply` to start a session
with that setting. Pass agent arguments after `--`. Use Claude Code from a
WSL2 terminal when you need its sandbox on Windows.

If the agent's sandbox limits destination ports, connect UTP through your
private HTTPS proxy on port 443. A service URL can include a path prefix.

When an agent reaches a review it must wait for, keep the request ID and
the session identifier used in `UTP_SESSION`. Answer in the terminal or on
the review page, then resume the original session and run
`utp wait <request-id>`. The saved answer applies to the same revision.
An action still goes through `utp begin` and `utp applied`.

[Codex network settings](https://learn.chatgpt.com/docs/agent-approvals-security)
· [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
· [Antigravity CLI sandbox](https://antigravity.google/docs/sandbox?tab=cli)

## Platforms

UTP is built command line first, so any agent that can run a shell command
can use it. Thin, self-contained adapters for **Claude Code**, **OpenAI Codex**,
and **Google Antigravity** ship under `adapters/` and are included in the npm
package. Each platform folder contains its own copy of `utp-workflow.md` so
copying that single folder into your platform's skills directory works
standalone.

In an ordinary coding session the agent handles routine fixes directly. It
opens UTP when work depends on your judgment or approval, checks the project's
prior decisions, and brings the remaining questions together once. The first
time a checkout needs a review, `utp init` either registers it or identifies
an existing project to join with `utp link <project-id>`.

If work stops on a question, the agent leaves the project, review ID, and card
revision in the task handoff. A later session runs `utp resume <review-id> --json`
in that checkout to recover your answer and check whether the relevant files
changed. You can switch agents without answering the same question twice.

Run `utp setup <claude|codex|antigravity>` to preview sandbox network settings
and print the resolved `Adapter files:` directory path. Copy the folder once
for each platform you use:

```sh
# Claude Code (bash / zsh / Git Bash)
cp -R adapters/claude "$HOME/.claude/skills/utp"

# OpenAI Codex (bash / zsh / Git Bash)
cp -R adapters/codex "$HOME/.codex/skills/utp"

# Google Antigravity (bash / zsh / Git Bash)
cp -R adapters/antigravity "$HOME/.gemini/config/skills/utp"
```

```powershell
# PowerShell 7 (Windows)
Copy-Item -Recurse -Force adapters\claude "$HOME\.claude\skills\utp"
Copy-Item -Recurse -Force adapters\codex "$HOME\.codex\skills\utp"
Copy-Item -Recurse -Force adapters\antigravity "$HOME\.gemini\config\skills\utp"
```

Optional instruction snippets are included in `adapters/codex/AGENTS.snippet.md`
and `adapters/antigravity/RULES.snippet.md`. For Claude Code, wire the bundled
`session-env.mjs` helper into a `SessionStart` hook (shown in
`adapters/claude/SKILL.md`) so `UTP_SESSION` automatically carries the native
session UUID. For work that changes files or external state, run
`utp closeout <report.json>` to show what each goal achieved, its evidence,
and any queued notices. The [agent workflow](adapters/utp-workflow.md#5-close-out-completion-report)
includes a report example, and an
[example status report](adapters/utp-workflow.md#6-example-status-report-with-a-proposed-next-batch)
that proposes the next batch of work and ends in one approval question.
Claude Code can remind the agent to write a close-out report
using the [optional Stop hook](adapters/claude/SKILL.md#5-optional-close-out-reminder-hook).
Desktop-app conveniences stay optional on top of the CLI, and the
decision log lives in one small service on a home server so every machine and
every agent shares the same decisions.

## License

MIT. See [LICENSE](LICENSE).
