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

The concept has been reviewed and its first decisions answered (review 0001,
2026-11-22). Phase 1a, the lifecycle core, is built and tested: the `utp`
command, the service it talks to, the crash-safe event log, the request state
machine, and execution grants. [Review 0002](docs/decisions/0002-followup-review.answers.json)
settled the scope of phase 1 and the policies for defaults and answers.
UTP's terminal review recorded three of its four decisions. Start with:

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
utp ask question.json
utp flush          # prints the review as Markdown for the conversation
utp review         # the person answers in their own terminal
utp wait <request-id>
```

For a batch with previews, use `utp page <review-id>` after flushing and open
the private link. The page lets you save the batch together and leave optional
feedback. Use `utp review --feedback` for the same ratings in your terminal.
`utp show <id> --json` includes the presentation and answer times. Interactive
terminal answers include elapsed time per card. A review page records one
elapsed time for the batch from opening the page to saving it.

Each card opens with what the question addresses. In the terminal, type
`?` when the question or choices are unclear. On the review page, use
**Ask for clarification**. You can send a note about what needs explaining.
The question stays open, and the agent sees your request for clarification
when it checks the review.

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
can use it. Adapters are planned for Claude Code, OpenAI Codex, and Google
Antigravity. Desktop-app features are optional conveniences on top. The
decision log lives in one small service on a home server, so every machine
and every agent sees the same decisions.

## License

MIT. See [LICENSE](LICENSE).
