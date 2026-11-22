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
2026-11-22). Phase 1a, the lifecycle core, is being built in TypeScript. A
few decisions are being asked again in review 0002. Start with:

- [Concept](docs/concept/concept.md): what UTP is, the kinds of decisions it
  handles, the request and answer formats, and the build phases.
- [Prior art](docs/research/prior-art.md): open-source projects, protocols,
  and research on agent-to-person decisions.
- [Decision failure patterns](docs/research/decision-failure-patterns.md):
  how real agent-session decisions went wrong and had to be reversed.

## Platforms

UTP is built command line first, so any agent that can run a shell command
can use it. Adapters are planned for Claude Code, OpenAI Codex, and Google
Antigravity. Desktop-app features are optional conveniences on top. The
decision log lives in one small service on a home server, so every machine
and every agent sees the same decisions.

## License

MIT. See [LICENSE](LICENSE).
