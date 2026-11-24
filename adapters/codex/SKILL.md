---
name: utp
description: Use the UTP CLI from Codex to ask structured decisions, batch reviews, reuse prior authority, and execute verified grants safely.
---

# UTP for Codex

Use the `utp` command line for structured decisions, approvals, and execution
grants. Follow the complete workflow and exit-code rules in
[utp-workflow.md](./utp-workflow.md).

## 1. Session identity (`UTP_SESSION`)

Codex exports `CODEX_THREAD_ID` as the native session UUID in shell commands.
Bind `UTP_SESSION` to it before calling `utp`:

- **Bash / zsh / Git Bash**:
  ```sh
  export UTP_SESSION="${CODEX_THREAD_ID:?CODEX_THREAD_ID is not set}"
  ```
- **PowerShell 7**:
  ```powershell
  if (-not $env:CODEX_THREAD_ID) { throw "CODEX_THREAD_ID is not set" }
  $env:UTP_SESSION = $env:CODEX_THREAD_ID
  ```

If `CODEX_THREAD_ID` is unavailable (for example in a standalone shell), generate
one unique per-session UUID for grant ownership (never leave `UTP_SESSION` unset
or `"default"`), and treat `chat_provenance` as unavailable for level-3
approvals.

## 2. Sandbox network setup

In Codex's default restricted sandbox, `utp` exits with code `32` because
outbound network requests are blocked. Preview and launch with network access
for the session:

```sh
utp setup codex
utp setup codex --apply -- <codex arguments>
```

This runs Codex with `--sandbox workspace-write -c sandbox_workspace_write.network_access=true`.

## 3. Channel routing and verified chat

Check `chat_provenance` from `utp status --json` or `utp flush --json`:

- **Host with readable local Codex transcripts** (for example Linux running on
  the same host as the UTP service, where `chat_provenance` is `true`): 1–2
  questions (including level-3 approvals) may be presented as chat Markdown and
  answered via `utp answer <request-id@revision> --from-chat --presentation <presentation-id> --quote-file <file>`.
- **Remote machines without mounted transcripts** (for example Windows talking
  to a Linux home service, where `chat_provenance` is `false`): `utp flush`
  prepares level-3 consequential approvals for verified review. Share the
  reviewer's permanent protected inbox if they supplied its address. Otherwise
  use the link from `utp flush` or `utp page <review-id>`. The reviewer can
  also run `utp review <review-id>` in their own terminal.

## 4. Turn-start resume and close-out

- Start every turn or resumed session with `utp status`. If Codex resumed the
  same thread (`CODEX_THREAD_ID` unchanged), continue with `utp wait` ->
  `utp begin` -> `utp applied`. If this is a new session, follow the new-session
  resume path (`utp takeover` / `utp reconcile`) in
  [utp-workflow.md](./utp-workflow.md).
- Always pass payloads as UTF-8 files — never inline JSON on the command line.
- When finishing a task that changed files, write a plain-language completion
  report mapping each stated goal to observed evidence.
