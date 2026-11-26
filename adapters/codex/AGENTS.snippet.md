## UTP Decisions (Codex)

When a task involves a non-routine choice, clarification, manual handoff, or
consequential approval, use the `utp` CLI and follow the installed `utp` skill
(`SKILL.md` and `utp-workflow.md` in your `.codex/skills/utp` folder):

- Handle routine fixes directly. For the first review in a checkout, run
  `utp init` and link to the existing project if it lists a match.
- Check `utp pins` and `utp consider` before asking. Reuse a prior decision
  when it still covers the action and scope. Batch the remaining questions.
- UTP reads `CODEX_THREAD_ID`. Leave the project, review ID, and pending card
  revision in the task handoff. On return, run `utp resume <review-id> --json`.
- Pass all request, intent, quote, authority, and evidence payloads as UTF-8
  files (never inline JSON).
- Route 3+ questions and any level-3 consequential approval when
  `chat_provenance` is `false` to the person's protected inbox if supplied,
  the page from `utp flush`, or `utp review <review-id>` in their terminal.
- Close file-changing tasks with a plain-language completion report mapping
  each goal to observed evidence.
