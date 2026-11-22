---
title: UTP concept review
review: V-20261122-concept
format: UTP v0 (hand-written draft; source is the .json beside this file)
---

# UTP concept review

## What you asked for, and what this review does

**You asked:** Set up a new project, UTP: a refined method for agents to hand you decisions in structured formats suited to the type of decision, so you review them easily instead of decoding conceptual replies. Research open-source prior art, shape it from real sessions with a focus on decisions that had to be backtracked, roundtable the concept until it holds up, and present the concept for review. Make it work with Codex and Antigravity, command line first, desktop features optional.

**Doing:** Presenting the concept and its seven open decisions. Nothing is built yet.

**Narrowed:** nothing.

**Deferred:**
- Implementation. It starts after you answer these decisions.
- Native question dialogs, the local review page, the phone inbox and an MCP server. The roundtable sequenced them after the command-line core is proven.

**Added:**
- A private evidence corpus of 60 decision cases from your recent sessions. It grounds the design; it stays out of the public repository.

## D1. Which kinds of request should the first working version handle?

kind `choose` · category `approach` · reversibility `easy` · level 3: Scope of the first release is the person's call.

Why now: Phase 1's size and order depend on it.

| Option | What happens |
|---|---|
| **a.** The six the evidence points to (recommended) | By decision type, the six kinds cover 50 of the 60 evidence cases, and review batching and the evidence rules cover 6 more: choices, approvals, manual steps, clarifications, completion checks and plan assumptions, plus FYI notices. Phase 1 takes longer, but the six share one lifecycle, so each adds a schema, a template and lint rules rather than new machinery. |
| **b.** Choices and approvals only | A usable first version sooner. Manual handoffs (8 cases) and acceptance of results (5 cases) keep going through chat. Completion reports still map each goal, written as plain Markdown, and the phase 1 criteria for the deferred kinds move to phase 2. |
| **c.** The six plus blind judging | Brings the blind-ballot pages into UTP right away, but phase 1 then needs the local review page, which delays the command-line core. |

**Recommendation: option a.** They are the most frequent decision types in the evidence, and they share one lifecycle. The evidence counts cases; it doesn't measure rework cost. It preserves: The blind-ballot pages keep working as they are until phase 2. Bolder alternative: Option c, if you want blind judging in the first release.

Evidence (observed, docs/research/decision-failure-patterns.md, 2026-11-22): Decision types across the 60 cases: approach 8, approval 8, manual handoff 8, intent 7, process 7, acceptance 5, prioritization 4, batches 3, plan defaults 3, diagnosis 3, judging 2, understanding 2.

Answer: one of a, b, c, or your own answer.

## D2. Where should each project's decision log live?

kind `choose` · category `design` · reversibility `costly` · level 3: Architecture choice that later data depends on.

Why now: The first stored request needs a home, and the reviewers found that the obvious place, a folder inside the repository, splits the log across worktrees.

| Option | What happens |
|---|---|
| **a.** In your home folder, one log per project per machine (recommended) | Every branch and worktree of a checkout shares its log automatically. Another clone of the same project on that machine shares it once you link it with one confirmation; until then it keeps its own log, and a clone that already has records keeps them as a searchable, read-only archive after linking. No commit can include the log. Agents in a restricted sandbox (Codex's default mode, for example) need a one-time setting to write to this folder; `utp setup` shows it and applies it after you confirm. Each machine keeps its own log, so a project worked on from two machines has two independent logs. Moving to a shared store later needs a migration tool, planned for phase 3. |
| **b.** Inside each repository, ignored by Git | The log sits next to the code, but each worktree gets its own copy, so agents in different worktrees don't see each other's decisions. Works in agents' default sandboxes with no setup. |
| **c.** Inside each repository, committed | Shared between machines through Git, but decisions become part of the history (a public repository would publish them) and parallel agents collide in merge conflicts. Works in agents' default sandboxes with no setup. |
| **d.** One central log on the home server | One log across every machine, but nothing works until the server is reachable and a service is running. Agents whose sandbox blocks network access can't reach it. |

**Recommendation: option a.** Agents routinely work in separate worktrees here, and two reviewers flagged writes to synced copies as unsafe. It preserves: Plain files and a command-line tool, with no service to run. Bolder alternative: Option d, as a later phase once the format settles.

Note: With any option, UTP's own design decisions are exported, redacted, into this repository's docs/decisions folder.

Answer: one of a, b, c, d, or your own answer.

## D3. What should UTP be written in?

kind `choose` · category `approach` · reversibility `costly` · level 3: Hard to change once code exists.

Why now: The phase 1 code starts in this language.

| Option | What happens |
|---|---|
| **a.** Python, standard library only (recommended) | Runs anywhere Python 3.11 or later exists, with nothing else to install, and reuses the ballot-server code. The terminal review uses plain numbered prompts rather than a full-screen interface. |
| **b.** Python with a few libraries | A nicer full-screen terminal review and stricter schema validation, but each machine needs a pip install first. |
| **c.** TypeScript on Node | Closer to MCP and web tooling, but a second runtime on every machine, and the existing Python review code can't be reused. |

**Recommendation: option a.** Nothing to install, and it builds directly on code that already works. It preserves: One language across the existing review tools. Bolder alternative: Option c, if the review page grows into a full web app.

Evidence (observed, in-house tool survey, 2026-11-22): The three blind-ballot servers and the roundtable engine are Python standard-library code.

Answer: one of a, b, c, or your own answer.

## D4. When an agent reaches work that depends on a question you haven't answered, what should it do?

kind `choose` · category `process` · reversibility `easy` · level 3: Sets the asking policy the person lives with.

Why now: This sets how often you get asked and how much an agent can get done while it waits.

| Option | What happens |
|---|---|
| **a.** Use its default only for small, easy-to-undo, non-design questions (recommended) | Agents keep moving on minor reversible choices, and each default they used shows up in your next review as 'applied by default: change?'. Design, scope, approval and acceptance questions always wait for you. |
| **b.** Always wait | No wrong turns from defaults, but agents sit idle more and ask you sooner and more often. |
| **c.** Use the default for any reversible clarify or choose question | Fastest: defaults also cover design and scope questions, as long as they are easy to undo. Approvals, acceptances, judgments and anything the agent lacks authority for still always wait. The research found your overrides clustered in design questions, so expect rework whenever a default was the wrong call. |

**Recommendation: option a.** Of the 72 questions with a recommendation that you answered, you chose something else 37 times, and the research noted those overrides clustered in design questions. That small reversible choices rarely matter is a judgment, not a measured result. It preserves: Your rule that agents decide routine things themselves. Bolder alternative: Option c.

Evidence (observed, docs/research/decision-failure-patterns.md, 2026-11-22): Recommended option chosen 35 of 77 times; another listed option 18; your own answer 19; dismissed 5. The research noted overrides clustered in design questions but gives no per-category counts.

Answer: one of a, b, c, or your own answer.

## D5. Where do you want to answer UTP requests by default?

kind `choose` · category `design` · reversibility `easy` · level 3: Sets the person's daily experience of UTP.

Why now: Phase 1 builds the default channel first; the others arrive in the phases shown.

| Option | What happens |
|---|---|
| **a.** In the conversation (recommended) | No new window for most questions. The agent shows lettered cards and logs your reply with a quote it checks against the session transcript. A consequential approval must name the action, unless it's a quick 'yes' right after a single card. On Antigravity, whose transcripts can't be checked, consequential approvals go to a terminal review instead. Reviews with previews open a local page once phase 2 lands. |
| **b.** Always on a separate review page | Every answer is captured directly with no agent in between, but you switch windows for every question, and the review page moves into phase 1, which makes phase 1 longer. |
| **c.** In the app's own question dialog | Familiar one-click answers, but the consequence lines must fit the dialog, what Codex offers depends on the client and mode, and one of its question tools pre-selects the first option, which the adapter has to work around, and Antigravity's command line can't answer it. It arrives in phase 2; until then you answer in the conversation as in option a. Moving the dialogs into phase 1 would add their per-platform mapping and conformance tests to phase 1. |

**Recommendation: option a.** You answered 168 structured questions inside sessions; a separate window for every answer is the kind of friction that gets routed around. It preserves: The conversation as your main surface. Bolder alternative: Option b, for the strongest guarantee that every answer came from you.

Evidence (observed, docs/research/decision-failure-patterns.md, 2026-11-22): 168 answers to agents' structured questions in recent sessions.

Answer: one of a, b, c, or your own answer.

## D6. UTP plans to absorb, connect to, or leave alone these existing tools. Keep or change each plan?

kind `assumptions` · reversibility `easy` · level 2: Reversible plan; each item can change later.

Why now: It decides what phase 1 to 4 build and what they reuse.

| Item | Plan | What it means |
|---|---|---|
| Blind-ballot review pages from the design lab | Absorb into UTP's blind judging: phase 2, or phase 1 if you pick D1 option c | One maintained copy instead of three; the experiments move to UTP's page. |
| Phone inbox | Connect as an answer channel in phase 4 | You can answer cards from the phone; its 24-hour text purge stays and UTP keeps the record. |
| Open-items list | Connect: UTP's waiting requests appear there | One list of what's waiting on you instead of two. |
| Push notifications and the morning report | Connect: one notification per review; notices go to the morning report | No per-question pings. |
| Concept and divergence register | Leave alone; copy its trigger, reversal and history fields | Registers keep working unchanged. |
| Interview-me question skill | Fold its rules into how UTP writes clarify cards | The skill's rules carry on in UTP's templates. |
| Brass-tacks summaries | Reuse as the summary layer at the top of each review | The three-layer shape you already know opens every review. |
| Change-quiz and blind-spot skills | Leave alone | They stay agent-side tools. |

**Recommendation: keep every item.** Each plan reuses something that works and avoids a second copy. It preserves: Every existing tool keeps working until UTP replaces or connects to it. Bolder alternative: Absorb the open-items list into UTP entirely.

Answer: for each item, keep or change (a change needs your replacement text, kept word for word).

## D7. What license should the public UTP repository carry?

kind `choose` · category `other` · reversibility `costly` · level 3: Outward-facing, and grants for released copies can't be withdrawn.

Why now: The repository is public and has no license file yet.

| Option | What happens |
|---|---|
| **a.** MIT (recommended) | Anyone can reuse it with attribution, the same as your other public repositories. You can change the license for later versions, but copies already released under MIT keep MIT's terms. |
| **b.** Apache 2.0 | Adds an explicit patent grant and a longer text. Its grants for released versions are perpetual and irrevocable, so a later change applies to new versions only. |
| **c.** No license for now | All rights reserved: others can read it but can't legally reuse it. Easy to change later, since nothing has been granted yet. |

**Recommendation: option a.** Six of your public repositories already use MIT. It preserves: Consistency across your public repositories. Bolder alternative: None; this is a consistency choice.

Evidence (observed, GitHub API, 2026-11-22): LICENSE files in torc-concept-review, wsl-plus-public, brass-tacks, masq-voice, tali and weir all begin 'MIT License', and GitHub detects each one as MIT.

Answer: one of a, b, c, or your own answer.
