---
name: utp
description: Use when an Antigravity task needs the person's choice, approval, judgment, or manual observation, or when a handoff names an earlier UTP review.
---

# UTP for Antigravity

Use the `utp` command line for structured decisions, approvals, and execution
grants. Follow the complete workflow and exit-code rules in
[utp-workflow.md](./utp-workflow.md).

## 1. Session identity (`UTP_SESSION`)

UTP reads `ANTIGRAVITY_CONVERSATION_ID` from each shell command. In a nested
agent with both platforms' IDs in its environment, set `UTP_SESSION`
explicitly to the active Antigravity conversation UUID.

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

## 4. Resume a review and close out the task

- Leave the project, review ID, and pending card revision in the task handoff.
  When returning to that task, run `utp resume <review-id> --json`. Follow
  the saved answer and the ownership checks in [utp-workflow.md](./utp-workflow.md).
- Always pass payloads as UTF-8 files — never inline JSON on the command line.
- When finishing a task that changed files, write a plain-language completion
  report mapping each stated goal to observed evidence.
