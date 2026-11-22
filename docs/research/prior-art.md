# Prior art for UTP

UTP (user testing platform) lets a coding agent hand a person a structured decision or review request and returns the answer to the agent as data. Request kinds, `utp check` and dispositions are defined in the [concept](../concept/concept.md).

Checked 2026-11-22. Versions, dates and star counts come from the linked pages or the GitHub API on that date. "UNVERIFIED" marks claims we could not confirm.

## Summary

No existing project covers UTP's whole loop: an agent writes a typed decision request, a person answers it from a terminal or a page, and the answer returns to the agent bound to what the person saw and kept in a log. The parts exist. Wire formats for asking are converging: MCP elicitation, ACP's permission and elicitation requests, AG-UI interrupts, and A2A's input-required state. Each target agent has a native question tool, but these tools work only interactively, cap questions and options, and carry no request revision. Review tools such as Plannotator and spec-kit's `/clarify` show current practice (one question at a time, a recommendation beside an option table, a reversibility line). They also show recurring failures: overwritten history, re-asked questions, and answers matched by position that ran the wrong action. Decision-record formats supply supersede-don't-overwrite and revisit triggers. The oversight research agrees on four points. Approvals habituate into rubber stamps. Explanations raise acceptance whether the AI is right or wrong unless they make checking cheaper. A pre-selected or badged option acts as a default. Asking for the person's own answer before showing the recommendation reduces over-reliance, at a cost in agreement and satisfaction.

## Comparison

| Project | Decision types | Request shape | Response shape | Blocking model | Rendering | License | Maturity | Source |
|---|---|---|---|---|---|---|---|---|
| MCP elicitation (+ Tasks) | form, single or multi choice, consent to open a URL | `message` + flat `requestedSchema`, or `url` | `action` accept / decline / cancel; `content` | `input_required` result, client retries; Tasks: durable, polled | host-defined | MIT moving to Apache-2.0 | spec 2026-07-28 | [spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation) |
| ACP | permission choice, elicitation | `session/request_permission{toolCall, options[{optionId, kind}]}` | selected `optionId` or cancelled | blocks the tool call | editors | Apache-2.0 | schema v1.34.1 | [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) |
| AG-UI | approve/deny, form, yes/no | `interrupts[{id, reason, responseSchema, expiresAt}]` | `resume[{interruptId, status, payload}]` | run ends; resumes later | web, React, Slack | MIT | spec 1.0 | [interrupts](https://docs.ag-ui.com/concepts/interrupts) |
| A2A | any message | state `INPUT_REQUIRED` + `status.message` | new message on the same `taskId` | blocking or async | n/a | Apache-2.0 | v1.0.1 | [spec](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) |
| MCP Apps / OpenAI Apps SDK | any HTML UI | `ui://` resource named by a tool | `tools/call`, `ui/message` | turn ends | iframe in the host | MIT moving to Apache-2.0 | Stable; not in Claude Code | [spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) |
| A2UI | catalog widgets | `createSurface`, `updateComponents` | `action{name, surfaceId, context}` | set by the transport | native renderers | Apache-2.0 | v1.0 | [spec](https://a2ui.org/specification/v1.0-a2ui/) |
| Claude Code | allow, deny, edit; questions; plan approval | `AskUserQuestion`: 1–4 questions, 2–4 options | answers keyed by question text and label | blocks; a hook can `defer` | terminal, SDK host | TS SDK commercial terms; Python SDK MIT | v2.1.330 | [user input](https://code.claude.com/docs/en/agent-sdk/user-input) |
| Codex CLI | approvals; questions | `request_user_input`: 1–3 questions, 2–3 options | `ReviewDecision`; answers keyed by question `id` | blocks; refused in `codex exec` | terminal, IDE, app-server clients | Apache-2.0 | v0.171.0 | [spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) |
| Antigravity | artifact review, comments, questions | `ask_question`: options `{id, text}` | `selected_option_ids`, `freeform_response`, `skipped` | review policy setting | app, CLI | SDK Apache-2.0; product UNVERIFIED | v2.34.0 | [SDK types](https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/types.py) |
| Gemini CLI | proceed once or always, modify; questions | `ask_user`: 1–4 questions | answers keyed by position | blocks; off when headless | terminal | Apache-2.0 | v0.70.0 | [ask_user](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/ask-user.md) |
| LangGraph | any payload | `interrupt(value)`, `response_schema` | `Command(resume=…)` by interrupt id | run stops; checkpointed | caller's UI | MIT | 1.2.24 | [docs](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| Agent Inbox / LangChain middleware | accept, edit, respond, ignore | `action_request`, `config{allow_*}`, `description` | `{type, args}`; `decisions[]` | as LangGraph | web inbox | MIT | Inbox archived 2026-09 | [repo](https://github.com/langchain-ai/agent-inbox) |
| HumanLayer SDK | approve, reject with comment, ask | `FunctionCallSpec{fn, kwargs, reject_options}` | `{approved, comment}` | polls every 3 s | Slack, email, terminal | Apache-2.0 | unmaintained since 2025-06 | [models](https://github.com/humanlayer/humanlayer/blob/v0.7.9/humanlayer/core/models.py) |
| Vercel AI SDK | approve or deny with reason | `tool-approval-request{approvalId, toolCall}` | `tool-approval-response{approved, reason}` | nothing pauses | React | Apache-2.0 | ai 7 | [docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) |
| Plannotator | annotate, approve or send feedback, questions | `:::question` with `Recommended:`, `Reversible:` | `{decision, feedback}` JSON | hook, or inbox (reply later) | browser, CLI | MIT or Apache-2.0 | v0.29.2 | [questions](https://github.com/backnotprop/plannotator/blob/main/apps/marketing/src/content/docs/guides/questions.md) |
| spec-kit `/clarify` | single choice, short answer | ≤5 questions, one at a time | option or ≤5 words, logged in the spec | synchronous chat | agent chat | MIT | v1.4.3 | [clarify.md](https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md) |
| Kiro | phase approval, fixes, comments | requirements, findings with suggested fixes | fix, custom answer, dismiss | gated phases | IDE, CLI | UNVERIFIED | IDE 1.5.11 | [analyze](https://kiro.dev/docs/specs/analyze-requirements/) |
| BMAD-METHOD | method menu; approve, edit, skip | numbered menu | pick, apply, reject | synchronous chat | agent chat | MIT | v6.12.4 | [skill](https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.4/src/core-skills/bmad-advanced-elicitation/SKILL.md) |
| GSD power mode | batch of choices | `QUESTIONS.json` | answers written to the file | async, file-based | static HTML page | MIT | v1.22.0 | [workflow](https://github.com/open-gsd/gsd-core/blob/main/gsd-core/workflows/discuss-phase-power.md) |
| Arena (LMArena) | blind pairwise | two anonymous answers | A, B, tie, both bad | live | web | FastChat Apache-2.0 | active | [paper](https://arxiv.org/abs/2403.04132) |
| Argilla / Label Studio | label, rating, ranking, pairwise, text | question list / XML config | human response beside model suggestion | async queue | web | Apache-2.0 | Argilla fixes only; Label Studio 1.23.2 | [Argilla](https://github.com/argilla-io/argilla), [Label Studio](https://github.com/HumanSignal/label-studio) |
| promptfoo viewer | pass/fail, score, comment | evaluation outputs | `{pass, score, reason}` marked human | after the run | web | MIT | 0.126.0 | [docs](https://www.promptfoo.dev/docs/usage/web-ui/) |
| Inspect AI `human_cli` | person does the task; approve, modify, reject | sandbox + `task` CLI | `submit`; `Approval(decision, explanation, modified)` | live | terminal | MIT | 0.3.291 | [docs](https://inspect.aisi.org.uk/human-agent.html) |

## 1. Protocols for asking a person

**MCP elicitation.** Added in spec 2025-06-18 and extended in 2025-11-25 with URL mode, titled enums and defaults ([2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/changelog), [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog)). Form mode sends `message` and a `requestedSchema`, a flat object whose properties are limited to:

- strings, with length limits and a `format` of email, uri, date or date-time;
- numbers and booleans;
- enums: an `enum` list, or `oneOf`/`anyOf` items of `{const, title}`, with `minItems`/`maxItems` for multi-select.

Any property may carry a `default`, which clients SHOULD pre-fill. Nested objects are excluded on purpose ([spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). The reply is `action: accept | decline | cancel`, with `content` only on accept. Decline is an explicit no; cancel is a dismissal. Secrets must go through URL mode, where `accept` means only consent to open the page.

The current spec (2026-07-28) is stateless and introduces Multi Round-Trip Requests (MRTR). A `tools/call` may return `resultType: "input_required"` with an `inputRequests` map and an opaque, integrity-protected `requestState`, and the client retries the call with `inputResponses` ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). The Tasks extension (Beta) adds durable handles: a task in `input_required` status is answered through `tasks/update`, and polling survives client restarts ([tasks](https://modelcontextprotocol.io/extensions/tasks/overview)). MCP has been a Linux Foundation project (Agentic AI Foundation) since 2025-12-09 ([press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)); its license is moving from MIT to Apache-2.0 ([LICENSE](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/LICENSE)).

Client support is uneven:

- **Claude Code** declares form and URL elicitation, shows a terminal dialog, and offers `Elicitation` and `ElicitationResult` hooks. It answers a task's `input_required` only in interactive sessions ([MCP docs](https://code.claude.com/docs/en/mcp), [hooks](https://code.claude.com/docs/en/hooks)).
- **Codex** negotiates protocol 2025-06-18 by default and keeps 2026-07-28 behind an off-by-default flag. It auto-cancels elicitations in `codex exec` ([protocol mode](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/protocol_mode.rs), [exec](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)).
- **Gemini CLI** does not support elicitation; the request to add it was closed as not planned ([#28074](https://github.com/google-gemini/gemini-cli/issues/28074)).

**ACP** (Agent Client Protocol) connects editors to coding agents: Gemini CLI natively, Claude and Codex through adapters ([agents](https://agentclientprotocol.com/get-started/agents)). `session/request_permission` offers options of kind `allow_once`, `allow_always`, `reject_once` or `reject_always`. It returns the selected `optionId` or `cancelled` ([tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)). ACP's `elicitation/create` adopts MCP 2026-07-28's data model with an explicit mode ([elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)).

**AG-UI** ends a run with interrupts that carry `id`, `reason`, `message`, `toolCallId`, `responseSchema` and `expiresAt`. The next run resumes with `{interruptId, status: "resolved" | "cancelled", payload}`. Every open interrupt must be answered or abandoned, and resumes must be replay-safe ([interrupts](https://docs.ag-ui.com/concepts/interrupts), [pattern](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume)).

**A2A** tasks enter `TASK_STATE_INPUT_REQUIRED` and are answered by a new message on the same `taskId`. A refinement becomes a new task that cites `referenceTaskIds` ([spec](https://github.com/a2aproject/A2A/blob/main/docs/specification.md), [life of a task](https://github.com/a2aproject/A2A/blob/main/docs/topics/life-of-a-task.md)). Gemini CLI's A2A extension sends `ConfirmationRequest{options, details}` with a diff and accepts `ToolCallConfirmation{selected_option_id, modified_details}`. That is edit-and-approve over a wire protocol ([RFC](https://github.com/google-gemini/gemini-cli/blob/main/packages/a2a-server/development-extension-rfc.md)).

**UI resources.** MCP Apps renders a tool's `ui://` HTML resource in a sandboxed iframe and has no wait-for-the-person primitive ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). Its client matrix does not list Claude Code ([matrix](https://modelcontextprotocol.io/extensions/client-matrix)). ChatGPT's Apps SDK now builds on MCP Apps ([docs](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)). A2UI 1.0 is a declarative component catalog that returns `action` events ([spec](https://a2ui.org/specification/v1.0-a2ui/)); we found no coding-agent CLI that renders it.

## 2. Coding agents and agent frameworks

**Native question tools.** Their fields are compared in the mapping table under "Implications".

- **Claude Code:** `AskUserQuestion` takes 1–4 questions with 2–4 options each and is unavailable in subagents ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)). The `canUseTool` callback returns allow, optionally with edited input, or deny with a message. A `defaultToNo` flag exists so that "a single stray keystroke must not approve this request" ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)). A `PreToolUse` hook can `defer`, ending the turn so that the answer arrives after `claude -p --resume` ([hooks](https://code.claude.com/docs/en/hooks)). Plan approval bundles the decision with an autonomy change ("Yes, and use auto mode") ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Codex:** `request_user_input` runs in Plan mode by default and asks 1–3 questions with 2–3 options. The recommended option comes first, marked "(Recommended)"; the client adds an "Other" choice and supports an `isSecret` flag ([spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs), [protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/request_user_input.rs)). Approvals return `ReviewDecision` values such as Approved, ApprovedForSession, Denied and Abort ([protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)). `codex exec` refuses both approvals and questions ([non-interactive](https://developers.openai.com/codex/noninteractive)).
- **Antigravity:** `ask_question` returns option ids, free text and a `skipped` flag. It is excluded from the default tools "because autonomous agents cannot prompt the user" ([SDK types](https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/types.py)). In the app, question cards dock above the message box and are cancelled if the person replies instead ([changelog](https://antigravity.google/docs/changelog?tab=hub)). Artifact review follows a "Request review" or "Always proceed" setting ([artifact review](https://antigravity.google/docs/artifact-review)).
- **Gemini CLI:** `ask_user` keys answers by position and is turned off in non-interactive and ACP modes ([ask_user](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/ask-user.md), [config](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)).

**Agent Inbox's response model.** An inbox interrupt carries `HumanInterrupt{action_request{action, args}, config{allow_accept, allow_edit, allow_respond, allow_ignore}, description}`. The reply is `HumanResponse{type: accept | edit | response | ignore, args}`. Accept runs the action as proposed. Edit runs it with edited arguments. Respond sends text back instead of running it, and ignore drops the item ([repo](https://github.com/langchain-ai/agent-inbox)). The `allow_*` flags declare which answers each request accepts, like UTP's per-kind answer vocabulary.

The repo is archived. LangChain v1's human-in-the-loop middleware replaces it with `approve | edit | reject | respond`; `reject` takes an optional message and `respond` a required one ([interrupt types](https://github.com/langchain-ai/langgraph/blob/main/libs/prebuilt/langgraph/prebuilt/interrupt.py), [middleware docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)). A `respond` reaches the model as a successful tool result, so a refusal sent as text can read as an answer.

LangChain's docs also record a batched-mode failure ([concepts](https://docs.langchain.com/oss/python/concepts/human-in-the-loop)):

- Decisions were matched by position. A reviewer who meant to reject a SQL call sent `[reject, approve]`, and "The `DELETE` runs".
- A wrong number of decisions is saved before it is checked, which leaves the thread stuck.
- Edits are not validated before they run.

Decisions keyed by interrupt id are now recommended. LangGraph re-runs an interrupted node from the top on resume and can fork from any checkpoint ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)).

**Other approval APIs.**

- **HumanLayer:** the SDK required a comment on rejection, but its terminal fallback treated Enter as approval ([models](https://github.com/humanlayer/humanlayer/blob/v0.7.9/humanlayer/core/models.py), [approval.py](https://github.com/humanlayer/humanlayer/blob/v0.7.9/humanlayer/core/approval.py)).
- **Vercel AI SDK v7** never pauses. The call returns a `tool-approval-request`, the app calls again with the response, and automatic decisions are logged with `isAutomatic` ([docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
- **mcp-feedback-enhanced**, a popular blocking "ask the person" MCP tool, now points users to native elicitation and MCP Apps. It has fixed an unauthenticated local WebSocket that could run arbitrary programs ([README](https://github.com/Minidoracat/mcp-feedback-enhanced)).
- **gotoHuman** is asynchronous: a review request returns `reviewId` and `reviewLink`, and the result arrives by webhook ([README](https://github.com/gotohuman/gotohuman-mcp-server)).

**Rewind is not reversal.** Claude Code's `/rewind` restores code and conversation from checkpoints but does not track file changes made through Bash ([checkpointing](https://code.claude.com/docs/en/checkpointing)). Codex's `thread/revert` drops turns but "doesn't change local files" ([app-server](https://developers.openai.com/codex/app-server)). Antigravity's changelog records a failed undo that "silently reset the transcript" and an "Always Proceed" setting that "left the agent waiting" ([changelog](https://antigravity.google/docs/changelog?tab=hub)).

## 3. Spec-driven and planning tools

**Plannotator** is the closest prior art ([repo](https://github.com/backnotprop/plannotator)). It hooks Claude Code's plan exit through a `PermissionRequest` hook and Codex through a `Stop` hook. It opens the plan in a browser for deletions, comments and labels, and returns either an approval or annotated feedback ([plan review](https://github.com/backnotprop/plannotator/blob/main/apps/marketing/src/content/docs/commands/plan-review.md)). Its `:::question` blocks carry choices, `Recommended:`, `Stakes:`, `Why:` and `Reversible: no — <why>`. Each question is Open, Answered, Skipped or Settled, with "about 8 at most" per plan, and outdated questions show "Replaced" ([questions](https://github.com/backnotprop/plannotator/blob/main/apps/marketing/src/content/docs/guides/questions.md)). `annotate --gate --json` prints the decision for scripts ([gates](https://github.com/backnotprop/plannotator/blob/main/apps/marketing/src/content/docs/guides/annotate-gates-and-json-responses.md)). Its inbox lets the asking session end and delivers the reply later ([inbox](https://github.com/backnotprop/plannotator/blob/main/apps/marketing/src/content/docs/reference/inbox.md)).

**spec-kit `/speckit.clarify`** queues at most five questions and asks them one at a time ([clarify.md](https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md)). Each question has a "why it matters" line, `**Recommended:** Option X - reason`, and either an option table or a short answer of at most five words. Answers are logged as `- Q: … → A: …` and folded into the spec. Its failures are instructive. Option tables have been shown without a question ([#1147](https://github.com/github/spec-kit/issues/1147)). An open report says rewritten specs lose history and clarify "asks questions I already answered" ([#4156](https://github.com/github/spec-kit/issues/4156)). Kiro has the same re-asking bug ([#10244](https://github.com/kirodotdev/Kiro/issues/10244)). Kiro writes requirements in EARS notation (`WHEN … THE SYSTEM SHALL …`) and approves them phase by phase ([feature specs](https://kiro.dev/docs/specs/feature-specs/)). Its Analyze Requirements step offers selectable fixes, a custom answer, or "dismiss as intentional" ([analyze](https://kiro.dev/docs/specs/analyze-requirements/)).

**Others.**

- **BMAD:** applies nothing from its elicitation menu "unless the user accepts". Its product requirements document (PRD) workflow logs "every decision, change, and override" ([elicitation](https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.4/src/core-skills/bmad-advanced-elicitation/SKILL.md), [PRD](https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.4/src/bmm-skills/plan/bmad-prd/SKILL.md)).
- **obra/superpowers:** v7.0.0 reversed its "prefer multiple choice questions" rule ("Options steer"). It records agent choices "as your call, never as something they agreed to" ([skill](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md), [release](https://github.com/obra/superpowers/releases/tag/v7.0.0)).
- **OpenSpec:** "Silence is not acceptance" ([skill](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-explore/SKILL.md)).
- **GSD:** power mode writes `QUESTIONS.json` plus a self-contained HTML page. It is the nearest file-based, asynchronous analog ([workflow](https://github.com/open-gsd/gsd-core/blob/main/gsd-core/workflows/discuss-phase-power.md)).
- **Backlog.md:** added `superseded_by` after a superseded decision stayed "accepted" ([#1068](https://github.com/MrLesk/Backlog.md/issues/1068)).
- **claude-task-master:** has no clarification step and rewrites later tasks when plans drift ([commands](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/command-reference.md)).

## 4. Decision-record formats and practices

An architecture decision record (ADR) documents one decision and its reasons.

- **MADR 4.0.0**, a Markdown ADR template: front matter `status`, `date`, `decision-makers`, `consulted`, `informed`. Sections: Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome ("Chosen option … because"), Consequences, Confirmation, and Pros and Cons. Status can be `superseded by ADR-…` ([template](https://github.com/adr/madr/blob/develop/template/adr-template.md)).
- **Nygard (2011):** Title, Context, Decision, Status, Consequences. A reversed decision is kept and marked superseded, to avoid "blind acceptance" and "blind reversal" ([post](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)). adr-tools writes both directions of a supersede link ([adr-new](https://github.com/npryce/adr-tools/blob/master/src/adr-new)).
- **Y-statements:** "In the context of …, facing …, we decided for … and neglected …, to achieve …, accepting …, because …" ([Zdun et al. 2013](https://doi.org/10.1109/MS.2013.97); [templates](https://adr.github.io/adr-templates/)).
- **Rejected ideas:** PEP 1 keeps "Rejected Ideas" so the same idea does not keep returning ([PEP 1](https://peps.python.org/pep-0001/)). The Rust RFC template asks "What is the impact of not doing this?" ([RFC template](https://github.com/rust-lang/rfcs/blob/master/0000-template.md)).
- **Decision matrices:** weighted and Pugh matrices let many minor criteria outvote a must-have, and make guesses look precise ([overview](https://en.wikipedia.org/wiki/Decision-matrix_method)).
- **One-way and two-way doors:** Type 1 ("one-way door") decisions deserve slow, careful process. Type 2 ("two-way door") decisions should be made quickly by small groups, and handling them with Type 1 process is a failure mode ([2015 letter](https://s2.q4cdn.com/299287126/files/doc_financials/annual/2015-Letter-to-Shareholders.PDF); "disagree and commit" in the [2016 letter](https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders)).
- **Pre-mortems:** imagine the project "has just failed" and list the reasons ([HBR 2007](https://hbr.org/2007/09/performing-a-project-premortem)). The often-quoted 30% improvement is not in the source abstract, which reports that temporal perspective "showed little influence" ([Mitchell et al. 1989](https://doi.org/10.1002/bdm.3960020103)).
- **Revisit triggers:** ecADR asks "When will we revisit and possibly revise this decision?" ([Zimmermann](https://ozimmer.ch/practices/2020/05/22/ADDefinitionOfDone.html)). Microsoft recommends append-only records with a confidence level ([guidance](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record)). AWS records reasons for rejection "to prevent future discussions on the same topic" ([ADR process](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html)).

## 5. Human evaluation UIs

- **Arena (formerly LMArena):** shows two anonymous answers, offers A better, B better, tie and both bad, reveals the models after the vote, and ranks them with Bradley-Terry ([Chiang et al. 2024](https://arxiv.org/abs/2403.04132)). "The Leaderboard Illusion" documents private testing and selective disclosure that distorted its rankings ([Singh et al. 2025](https://arxiv.org/abs/2504.20879)).
- **Argilla:** keeps a model's `Suggestion{value, score, agent}` separate from the human `Response{value, status}`, but now receives bug fixes only ([question types](https://github.com/argilla-io/argilla/blob/develop/argilla/src/argilla/settings/_question.py)).
- **Label Studio:** its `Pairwise` tag returns left or right, with no tie ([Pairwise.js](https://github.com/HumanSignal/label-studio/blob/develop/web/libs/editor/src/tags/control/Pairwise.js)).
- **promptfoo:** marks a human grade with `assertion: {type: 'human'}` beside automated grades ([types](https://github.com/promptfoo/promptfoo/blob/main/src/types/index.ts)).
- **Inspect AI:** `human_cli` puts a person in the task sandbox with `task start | stop | submit | note | quit` and records the session ([human agent](https://inspect.aisi.org.uk/human-agent.html)). Its approval API returns `Approval(decision, explanation, modified)` ([approval](https://inspect.aisi.org.uk/approval.html)). It is the strongest terminal-native precedent.

## 6. What the oversight research says

**Approvals habituate.** Automation bias affects experts and "cannot be prevented by training or instructions" ([Parasuraman & Manzey 2010](https://doi.org/10.1177/0018720810376055)). Accountability for the outcome reduced it ([Skitka et al. 2000](https://doi.org/10.1006/ijhc.1999.0349)). Warning click-through ranged from 10% to 70% depending on design ([Akhawe & Felt 2013](https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/akhawe)). Attention to repeated warnings decays, and varied formats resisted the decay ([Vance et al. 2018](https://doi.org/10.25300/MISQ/2018/14124)). In vendor data that is not peer reviewed, users approved about 93% of Claude Code permission prompts ([Anthropic](https://www.anthropic.com/engineering/how-we-contain-claude)). "Decision fatigue" is contested. The parole study ([Danziger et al. 2011](https://doi.org/10.1073/pnas.1018033108)) has alternative explanations ([Glöckner 2016](https://doi.org/10.1017/S1930297500004812)), and ego depletion failed a preregistered replication ([Hagger et al. 2016](https://doi.org/10.1177/1745691616652873)). Habituation is the better-supported reason to batch requests.

**Explanations are not a safeguard by themselves.** Explanations raised acceptance whether the AI was right or wrong ([Bansal et al. 2021](https://doi.org/10.1145/3411764.3445717)). More transparency made large model errors harder to catch ([Poursabzi-Sangdeh et al. 2021](https://doi.org/10.1145/3411764.3445315)). Explanations reduced over-reliance when they made checking cheaper than solving the task ([Vasconcelos et al. 2023](https://doi.org/10.1145/3579605)).

**Recommendation first, or after the person's own answer.**

- **Cognitive forcing** reduced over-reliance compared with plain explanations. The forcing designs tested were deciding before seeing the AI, advice on demand, and a short wait. Participants liked the most effective designs least, and the gains concentrated in people high in need for cognition ([Buçinca et al. 2021](https://doi.org/10.1145/3449287)).
- **Answering first:** when 19 veterinary radiologists recorded a provisional answer first, they agreed less with the AI whether it was right or wrong. They also asked for fewer second opinions, at no time cost ([Fogliato et al. 2022](https://doi.org/10.1145/3531146.3533193)). Deciding first guards against a wrong recommendation and costs some agreement with a right one.
- **Defaults:** a pre-selected or endorsed option acts as a default. A meta-analysis of 58 studies found a medium effect (d = 0.68), stronger when the default signals endorsement ([Jachimowicz et al. 2019](https://doi.org/10.1017/bpp.2018.43)). An elicitation `default`, a pre-highlighted option and a "(Recommended)" label all send that signal.
- **Learning and anchoring:** a recommendation with an explanation improved decisions but not learning; the explanation alone improved both ([Gajos & Mamykina 2022](https://doi.org/10.1145/3490099.3511138)). Extra time on uncertain items reduced anchoring ([Rastogi et al. 2022](https://doi.org/10.1145/3512930)).
- **Comprehension checks** have thin evidence in review settings. Explanations framed as questions exposed flawed logic better than causal ones ([Danry et al. 2023](https://doi.org/10.1145/3544548.3580672)). Explicit code-review checklists gave no strong overall gain ([Gonçalves et al. 2022](https://doi.org/10.1007/s10664-022-10123-8)).

**Size and reversibility.** Understanding the change is the main challenge in code review ([Bacchelli & Bird 2013](https://doi.org/10.1109/ICSE.2013.6606617)). People prefer changeable decisions but are less satisfied with them ([Gilbert & Ebert 2002](https://doi.org/10.1037/0022-3514.82.4.503)). Lenient return policies raise purchases more than returns ([Janakiraman et al. 2016](https://doi.org/10.1016/j.jretai.2015.11.002)). So calling a choice reversible invites less scrutiny, and the reversal often never happens. Sunk-cost effects are reliable ([Roth et al. 2015](https://doi.org/10.1007/s40685-014-0014-8)). Setting targets in advance and judging the process rather than the outcome reduce escalation ([Simonson & Staw 1992](https://doi.org/10.1037/0021-9010.77.4.419)).

## Implications for UTP

### Mapping a UTP request onto native surfaces

| UTP element | MCP elicitation (form) | Claude `AskUserQuestion` | Codex `request_user_input` | Antigravity `ask_question` |
|---|---|---|---|---|
| Question | `message`; property `title`, `description` | `question`; `header` ≤12 chars | `question`; `header` ≤12; `id` | `question` |
| Options with stable ids | titled enum `{const, title}`; returns the id | 2–4 labels; returns the label | 2–3 labels; returns the label | `{id, text}`; returns ids |
| Consequence line per option | no slot; fold into `title` or `message` | `description` | `description` | no slot; fold into `text` |
| Multi-select | array of titled enums | `multiSelect` | not documented | `is_multi_select` |
| Person's own answer | extra string property | free text | client-added "Other" | `freeform_response` |
| Recommendation | `message` text, never `default` | label or description text | first option, "(Recommended)" | `text` |
| Sureness, feedback | extra enum properties | extra questions (4 max) | extra questions (3 max) | extra questions |
| Decline, dismissal | `decline`, `cancel` | deny with message (SDK) | cleared on interrupt | `skipped`, `cancelled` |
| Request id and revision | server side (MRTR `requestState`) | not carried | question `id` only | not carried |
| Evidence, artifacts | text; URL mode or MCP Apps | `preview` | none | none |
| Where it works | Claude Code; Codex on 2025-06-18, cancelled in `exec`; not Gemini CLI | interactive sessions, not subagents | Plan mode, not `codex exec` | interactive agents only |

UTP's answer half maps onto an elicitation `requestedSchema`. Option ids, several ids, per-item statuses, a rating, verbatim text and sureness each fit a flat property, with one enum property per goal or item. UTP should generate an elicitation schema for every request. The request half does not fit: why-now, per-option consequences, evidence, stakes, basis and revision have no slot. Those travel in `message`, in server state, or on a linked page. The native tools are lossy projections. Their common subset is one to three questions, with two or three options of label and description, plus free text. Requests beyond that should fall back to the CLI review, and `utp check` should know each target's limits. Claude Code and Codex return labels, not ids, and no target returns a revision. UTP must keep labels unique within a request, map them back to ids, and reject answers to a stale revision.

### Borrow

1. **Interrupt and resume** (AG-UI, MRTR, Claude's `defer`, Plannotator's inbox). The agent ends its turn with request ids, an answer schema and an expiry. Answers resume it by id and must be safe to replay. Every open request is answered, cancelled or abandoned explicitly.
2. **Agent Inbox's allowed-answer flags, with LangChain v1's split:**
   - accept or approve;
   - edit, limited to fields the request declares and validated before saving;
   - reject with a reason;
   - respond, kept verbatim and not executed until its scope is clear;
   - ignore, which maps to UTP's `no longer matters`.
3. **Decide first for costly and one-way decisions.** Ask for the person's own pick and sureness, then reveal the recommendation with checkable evidence and allow an update. Log both answers. For two-way doors, show the recommendation up front but never pre-select it. Expect lower satisfaction and less agreement with good recommendations; UTP's log can measure that trade-off.
4. **Decision records:**
   - from Plannotator: `Reversible:` and `Stakes:`;
   - from MADR: `consulted` versus `informed`, and Confirmation;
   - from Y-statements: "neglected" and "accepting";
   - from PEP 1: Rejected Ideas;
   - from adr-tools and Backlog.md: supersede links in both directions, plus a `revisit_if` trigger.
5. **For `judge`:**
   - from Arena: blind A/B with tie and both-bad, revealed after the vote;
   - from Argilla: the agent's pick stored as a separate, scored suggestion;
   - from promptfoo: a `human` marker on grades;
   - from Inspect AI: an in-environment `submit`/`note` CLI.

### Avoid

1. Answers matched by position: LangChain's batched `[reject, approve]` and Gemini CLI's position-keyed answers.
2. Overwriting answered questions and re-asking them (spec-kit #4156, Kiro #10244).
3. Folding wider scope into a one-off approval ("Yes, and use auto mode", `allow_always`, ApprovedForSession). Make policy changes separate `choose` requests.
4. Enter-means-approve, and dismissals or "Always proceed" settings that read as approval. Claude's `defaultToNo` is the precedent.
5. Unauthenticated local review pages (the mcp-feedback-enhanced fix). Validate `Origin`, require a token, and never execute commands from the page.
6. Long persuasive rationales, and "decision fatigue" as the reason to batch.

### Interoperate

1. Emit MCP elicitation; Claude Code's `Elicitation` hook lets UTP capture or answer it. Track MRTR and Tasks for non-blocking delivery.
2. Ship thin adapters:
   - Claude Code: `AskUserQuestion` through `canUseTool` or `defer`;
   - Codex: `request_user_input` and the app-server's `item/tool/requestUserInput`;
   - Antigravity: `ask_question` through the SDK's question hook;
   - Gemini CLI: `ask_user`;
   - editors: ACP.
3. Import and export Plannotator's `:::question` blocks and JSON gate, GSD's `QUESTIONS.json`, and spec-kit's Clarifications log.
4. Export decision records as MADR, and `judge` batches as Label Studio tasks with the agent's pick as a prediction.

## Not verified

- **Antigravity:** MCP elicitation and MCP Apps support, limits on `ask_question` counts, and product license terms.
- **Claude Code:** MRTR handling on plain `tools/call`, and MCP Apps rendering (a request to add it is open).
- **Codex:** multi-select in `request_user_input`, and which modes offer the experimental `request_user_input_async` tool. That tool exists behind the `experimental_request_user_input_enabled` setting, and its option schema tells the model to put the recommended answer first and says the first option is pre-selected by default ([handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_async.rs), checked 2026-11-22, after the main research).
- **Other surfaces:** AG-UI, A2UI or MCP Apps rendering in Codex CLI, Gemini CLI or Antigravity (no evidence found), and HumanLayer's reported "CodeLayer" rebrand (secondary sources only).
- **Kiro:** license terms.
- **Pre-mortems:** the "30%" figure.
- **Research gaps:** we found no peer-reviewed test of deciding first, teach-back, or "explain, then accept" in agent or code review. Approval fatigue with coding agents appears only in vendor data.
- **Not reviewed:** Tessl, Traycer, Agent OS, and the MRSF review-sidecar draft.
