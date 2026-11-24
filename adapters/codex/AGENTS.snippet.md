## UTP Decisions (Codex)

When a task involves a non-routine choice, clarification, manual handoff, or
consequential approval, use the `utp` CLI and follow the installed `utp` skill
(`SKILL.md` and `utp-workflow.md` in your `.codex/skills/utp` folder):

- Export `UTP_SESSION` from `CODEX_THREAD_ID` before running `utp` commands.
- Check `utp status` at turn start to resume answered or interrupted requests.
- Check prior decisions and reversals with `utp consider` or `utp log` before
  asking; reuse existing authority when it covers the exact action and scope.
- Pass all request, intent, quote, authority, and evidence payloads as UTF-8
  files (never inline JSON).
- Route 3+ questions and any level-3 consequential approval when
  `chat_provenance` is `false` directly to the `utp flush` review page URL or
  `utp review <review-id>` in the person's terminal.
- Close file-changing tasks with a plain-language completion report mapping
  each goal to observed evidence.
