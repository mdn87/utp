---
name: utp
description: Use the UTP CLI from Antigravity to ask structured decisions, batch reviews, reuse prior authority, and route consequential approvals to verified channels.
---

# UTP for Antigravity

Use the `utp` command line for structured decisions, approvals, and execution
grants. Follow the complete workflow and exit-code rules in
[utp-workflow.md](./utp-workflow.md).

## 1. Session identity (`UTP_SESSION`)

Antigravity exports `ANTIGRAVITY_CONVERSATION_ID` as a per-conversation UUID in
shell commands. Bind `UTP_SESSION` to it for stable grant ownership so
concurrent sessions never collide on `"default"`:

- **PowerShell 7**:
  ```powershell
  if (-not $env:ANTIGRAVITY_CONVERSATION_ID) { throw "ANTIGRAVITY_CONVERSATION_ID is not set" }
  $env:UTP_SESSION = $env:ANTIGRAVITY_CONVERSATION_ID
  ```
- **Bash / zsh / Git Bash**:
  ```sh
  export UTP_SESSION="${ANTIGRAVITY_CONVERSATION_ID:?ANTIGRAVITY_CONVERSATION_ID is not set}"
  ```

If `ANTIGRAVITY_CONVERSATION_ID` is unavailable (for example in a standalone
shell), generate one stable per-session UUID file for the run and export
`UTP_SESSION` from it. Never leave `UTP_SESSION` unset or `"default"`.

## 2. Mandatory upfront routing for level-3 approvals

Antigravity does not provide a server-verifiable native chat transcript format
in Phase 1 (`chat_provenance` is always `false`):

- **Never** ask a level-3 consequential approval in chat Markdown and never use
  `utp answer --from-chat` for a level-3 approval.
- `utp flush` prepares a level-3 approval for verified review. Share the
  reviewer's permanent protected inbox if they supplied its address. Otherwise
  use the link from `utp flush` or `utp page <review-id>`. The reviewer can
  also run `utp review <review-id>` in their own terminal.
- If `utp answer --from-chat` or `utp wait` ever returns exit `18`, keep the
  same request ID and revision, use a verified channel above and resume with
  `utp wait <request-id>`.
- Non-level-3 reviews with 1–2 cards (such as reversible `choose` or `clarify`
  cards) can still use chat Markdown or the terminal/page review.

## 3. Sandbox network setup

In Antigravity's default sandbox, `utp` exits with code `32` until the service
host and connection file are allowed. Preview and launch with:

```sh
utp setup antigravity
utp setup antigravity --apply -- <antigravity arguments>
```

## 4. Turn-start resume and close-out

- Start every turn or resumed conversation with `utp status`. If continuing the
  same conversation (`ANTIGRAVITY_CONVERSATION_ID` unchanged), resume with
  `utp wait` -> `utp begin` -> `utp applied`. If starting a new conversation,
  inspect the workspace and use `utp takeover` or `utp reconcile` per
  [utp-workflow.md](./utp-workflow.md).
- Always pass payloads as UTF-8 files — never inline JSON on the command line.
- When finishing a task that changed files, write a plain-language completion
  report mapping each stated goal to observed evidence.
