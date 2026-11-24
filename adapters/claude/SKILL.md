---
name: utp
description: Use the UTP CLI from Claude Code to ask structured decisions, batch reviews, reuse prior authority, and execute verified grants safely.
---

# UTP for Claude Code

Use the `utp` command line for structured decisions, approvals, and execution
grants. Follow the complete workflow and exit-code rules in
[utp-workflow.md](./utp-workflow.md).

## 1. Session identity (`UTP_SESSION`)

Claude Code does not set a session-ID environment variable by default, so wire
the bundled [session-env.mjs](./session-env.mjs) helper into a `SessionStart`
hook in Claude Code's settings. When a session starts or resumes, Claude Code
passes `session_id` on stdin and `CLAUDE_ENV_FILE` in the environment; the
helper writes `export UTP_SESSION=<session_id>` into `CLAUDE_ENV_FILE` so every
subsequent shell command inherits the native session UUID:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/skills/utp/session-env.mjs\""
          }
        ]
      }
    ]
  }
}
```

If that hook is not installed yet, generate one stable per-session UUID for
grant ownership before calling `utp` (never leave `UTP_SESSION` unset or
`"default"`), and treat `chat_provenance` as unavailable for level-3 approvals
until the native UUID hook is active.

## 2. Sandbox network setup

In Claude Code's default sandbox, `utp` exits with code `32` until the service
host and port are allowed. Preview and launch with the session allowlist:

```sh
utp setup claude
utp setup claude --apply -- <claude arguments>
```

On Windows, run `utp setup claude --apply` inside WSL2 when using Claude Code's
sandbox; native Windows runs do not support Claude Code's sandbox network
allowlist.

## 3. Channel routing and verified chat

Check `chat_provenance` from `utp status --json` or `utp flush --json`:

- **Host with readable local Claude transcripts** (for example Linux running on
  the same host as the UTP service, with `SessionStart` exporting the native
  session UUID so `chat_provenance` is `true`): 1–2 questions (including
  level-3 approvals) may be presented as chat Markdown and answered via
  `utp answer <request-id@revision> --from-chat --presentation <presentation-id> --quote-file <file>`.
- **Remote machines without mounted transcripts** (for example Windows talking
  to a Linux home service, where `chat_provenance` is `false`): `utp flush`
  routes level-3 consequential approvals straight to the review page URL so the
  person is never asked to answer twice. Share the URL or ask the person to run
  `utp review <review-id>` in their own terminal.

## 4. Turn-start resume and close-out

- Start every turn or resumed session with `utp status`. If Claude Code resumed
  the same session (`claude --resume <id>` with the same `UTP_SESSION`),
  continue with `utp wait` -> `utp begin` -> `utp applied`. If this is a new
  session, inspect the workspace and follow the new-session resume path
  (`utp takeover` or `utp reconcile`) in [utp-workflow.md](./utp-workflow.md).
- Always pass payloads as UTF-8 files — never inline JSON on the command line.
- When finishing a task that changed files, write a plain-language completion
  report mapping each stated goal to observed evidence.
