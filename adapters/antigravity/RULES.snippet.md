## UTP Decisions (Antigravity)

When a task involves a non-routine choice, clarification, manual handoff, or
consequential approval, use the `utp` CLI and follow the installed `utp` skill
(`SKILL.md` and `utp-workflow.md` in your `.gemini/config/skills/utp` or
workspace `.agents/skills/utp` folder):

- Set `UTP_SESSION` from `ANTIGRAVITY_CONVERSATION_ID` before running `utp`
  commands so grants never collide on `"default"`.
- Check `utp status` at turn start to resume answered or interrupted requests.
- Check prior decisions and reversals with `utp consider` or `utp log` before
  asking; reuse existing authority when it covers the exact action and scope.
- Pass all request, intent, quote, authority, and evidence payloads as UTF-8
  files (never inline JSON).
- Always route level-3 consequential approvals directly to the `utp flush`
  review page URL (`utp page <review-id>`) or `utp review <review-id>` in the
  person's terminal — never ask for level-3 approval in chat.
- Close file-changing tasks with a plain-language completion report mapping
  each goal to observed evidence.
