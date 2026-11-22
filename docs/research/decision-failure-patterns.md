# Decision failure patterns in agent-to-operator decisions

UTP (user testing platform) is a planned system that presents agent-to-operator decisions in a structured, easy-to-review form. This note summarizes how such decisions went wrong, were hard to follow, or went well, as evidence for UTP's design. It generalizes a private case corpus; it contains no quotes, identifiers or project names. Examples are paraphrased and describe projects generically.

## Source and method

- One solo operator's local session history with two commercial coding agents, mostly October and November 2026, with some earlier turns carried in resumed sessions. The operator works across many personal projects and several machines, by keyboard and by voice.
- A streaming extractor kept only turns the operator typed or spoke (about 3,000) and every answer to an agent's structured multiple-choice question (168). It dropped tool output, system and hook text, automated prompts, and compaction summaries. It then flagged corrections, confusion, interruptions, and replies in which the agent admitted an error.
- Flagged turns were read in context. Recorded lessons in the operator's agent memory, two decision registers, a list of questions put to the operator, and three blind-review experiment records filled in the rest.
- The result is 60 classified cases: 35 backtracks, 17 hard to follow or mixed, 1 latent inconsistency, and 7 that went well. Two of the hard-to-follow cases ended well after the presentation changed.

The numbers describe the cases selected, not how often each failure happens overall. Classification was done by one agent reviewer and has not been confirmed by the operator.

## Decision types

| Decision type | Cases |
|---|---:|
| Approach, architecture or experiment design | 8 |
| Approval of a consequential action (system change, deletion, launch, publication) | 8 |
| Manual handoff: what the human must do, where, and how | 8 |
| Intent or scope interpretation | 7 |
| Process or policy rule (review depth, what gets reported, decision records) | 7 |
| Acceptance of a result (done, fixed, verified, no-op) | 5 |
| Prioritization, sequencing, and whether a step is worth doing | 4 |
| A batch of pending decisions presented together | 3 |
| A default embedded in a plan | 3 |
| Diagnosis or factual claim during recovery | 3 |
| Quality or taste judgment of an artifact | 2 |
| Understanding a complex answer well enough to act | 2 |

Who made the original decision: in 28 cases the agent decided without ever putting it to the operator. In 28 the agent proposed something that the operator answered or redirected. In 3 the operator approved the agent's proposal before the problem showed. In 1 the operator decided directly.

| Who decided | Went badly (53) | Went well (7) |
|---|---:|---:|
| Agent, never put to the operator | 28 | 0 |
| Agent proposed; operator answered or redirected | 21 | 7 |
| Agent proposed; operator approved | 3 | 0 |
| Operator directly | 1 | 0 |

All 28 silent decisions are among the cases that went badly, just over half of them; every case that went well was a proposal the operator answered.

## Root causes

| Root cause | Cases |
|---|---:|
| **Consequence not stated**: the effect, side effect, value or cost of a choice was missing when it was made | **11** |
| **Undefined labels**: codes, option letters, acronyms or internal names with no definition | **9** |
| **Assumption never surfaced**: the agent acted on an interpretation it never stated | **9** |
| **Status word without meaning**: claims such as done, fixed, no-op or nothing open, not tied to the operator's goal | **8** |
| **Unclear handoff to the human**: missing machine, shell, location or success check, or agent-capable work handed over | **8** |
| **Unverified claim stated as fact**: an inference, stale evidence, or an unverified UI instruction | **7** |
| Goal lost in process: measurement, review or procedure replaced the outcome | 6 |
| Options framed in the agent's model: mechanism-first, bundled, or a false either/or | 6 |
| Biased default or recommendation | 5 |
| Approval mechanics: inferred, misfired, or demanded needlessly | 4 |
| Wall of text | 4 |
| Question without context: a judgment asked for without the evidence at hand | 4 |
| Decision buried in a long report or an earlier message | 3 |
| Silent scope change | 2 |

Most cases have more than one cause.

## The recommended option is often overridden

One agent marks one option as recommended in its structured questions. Of 77 such questions, the operator chose the recommended option 35 times (45%). They chose a different listed option 18 times, wrote their own answer 19 times, and dismissed 5. Overrides clustered in design and creative questions. There, the recommendation tended to keep the agent's existing architecture or take a shortcut around infrastructure the operator wanted fixed.

The other agent mostly asked single-action permission questions: one action, its effect, and why approval was needed. The operator took the first option in 37 of 49 such questions that offered options (76%). They also used the narrower or declining options without friction.

So a recommendation is not a safe default for design questions. It needs its rationale and the alternative it rules out shown beside it.

## Patterns

### 1. The consequence is missing at the moment of choice (11)

- A plan's default accepted that one component's tests could not run in the verification sandbox. When the operator asked what that cost, the answer was that only about a quarter of its test suite could be verified there, so good changes would be recorded as failures. They rejected the default and sent the problem to outside review. A second default in the same list used an internal term they had to ask about.
- A system change to how links open in the editor was approved as a quick workaround. Most of its side effects, including that every such link on the machine would now go to the other editor, were listed only after it had been applied. The operator ran an undo, and the undo did not take.
- A routine cleanup removed a working copy, and with it untracked local files that had never been inventoried. They were lost.
- The operator picked three numbered work items. The batch left out the part they were picturing, and they only found out late in the session.

What would have caught it: one line per option or default saying what changes for the operator, how often, and how to reverse it, written before the action.

### 2. Labels without definitions (9)

- A long triage list keyed by ledger codes. Some asks required knowledge the operator did not have and did not need, and some treated test cases the agents had invented as requirements.
- Option letters following a dense paragraph about transport mechanics, and a pair of choices inside a long reply. Both drew a request to restate them in plain language.
- A fix for phone notifications introduced a cryptographic acronym at the end of a long, failed night. It read as invented.
- Phone automation steps were spoken in the app's internal vocabulary instead of as taps.

What would have caught it: inline definitions, and options named by outcome rather than by code or mechanism.

### 3. Assumptions the agent never stated (9)

- Twice in one week, in two projects, a plan was committed and implementation was about to start without the review the operator expects for plans of that size.
- An experiment coordinator chose the creative solution before the two teams started. That removed the problem solving the experiment existed to compare.
- A dashboard shipped a progress ring whose meaning the agent had chosen. With one session it lit up arbitrarily.
- An assistant answered a long, exploratory message with a ranked priority list the operator had not asked for.
- A deliberately short-lived credential was reported as a risk in report after report.

What would have caught it: state the working interpretation as a question, with the plausible alternatives, before acting on it.

### 4. Status words that do not mean what the operator needs (8)

- A completion report declared the work finished with nothing outstanding, measured against the plan's steps. The automation covered two of four ways the system could decay, and missed the two larger ones.
- A voice readback problem was announced as fixed before anyone had listened. The operator made the same complaint four times in a few minutes, twice after the announcement.
- A pull-request close-out was called a no-op. That was true of the merge but not of content that still needed review.
- An automated video check passed because frames differed. Both clips were unusable, and the two supposedly independent submissions were byte-identical. Only the blind human ballot caught it.

What would have caught it: completion reports that map each original goal or risk to covered, partly covered or not covered. Each claim carries evidence from the operator's vantage: what they will see or hear.

### 5. Unclear handoffs to the human (8)

- The command the operator was asked to run was in an earlier message, written for a different shell.
- A confirmation button presumed they had already run a deploy that the agent's own safety check had blocked.
- A command arrived with no machine named and no reason given for why they, not the agent, had to run it.
- Instructions pointed at a menu that does not exist.
- Dashboard clicks were handed over that the agent could do itself. They asked it to drive instead.

What would have caught it: a who-acts block that names the actor, machine and shell, gives a copyable command tested for that shell, and says what success looks like. When the agent can do the step itself, the block offers that first.

### 6. Inference stated as fact (7)

- A dispatch route was declared broken from week-old observations. It had worked since, and the operator used it routinely.
- A window was reported as in front because of its coordinates while it sat behind another full-screen app. A tool refusal was blamed on a setting that was not the cause.
- A policy was paraphrased wrongly, which turned a plain yes into a puzzle.
- A decision register recorded two workflow gates as still in a passive mode, citing an older review. The operator had promoted both two weeks earlier, and the live configuration matched that decision. This one is latent: nothing has gone wrong yet.

What would have caught it: claims that carry their source and date, and decision records checked against the decision itself and the live state.

### Composite: a night of approvals without a purpose

The clearest backtrack combined several causes. Over one night the operator approved a series of measurement runs for a phone approval inbox, each with a one-line yes. Earlier choices had made the page impractical. Security settings imposed a short sign-in lifetime and a hardware-key prompt on approvals, and notifications came through a third-party app whose links opened a browser that was not signed in. That friction had been noted in the record, not raised as decisions.

When the operator asked what the work was for, and then how the obvious fix was only now appearing, the agent's own diagnosis was that every session had executed the plan instead of asking whether the page was usable. The operator paused the project, and the work was re-sequenced so usability came first.

## What went well

| Pattern that worked | Example (paraphrased) |
|---|---|
| Interpretation stated as a question with concrete readings | An agent asked whether a request to fix all remaining issues meant only the failed checks or a broader set, and the operator widened the scope before work began. Another offered two readings of an ambiguous verb, and they chose both in one line. A list recorded a numeric reference as an inference until they confirmed it. |
| Consequence inside the question | Archiving into public repositories would also publish never-published commits. The question said so, and the operator chose knowingly. |
| Blast radius before a destructive approval | A dry run reported the size and file count of a bulk delete, and the approval was one word. |
| Provenance check on relayed approvals | A peer agent claimed the operator had authorized a launch, and the agent asked the operator to confirm. The same day they had declined a similar request, so the check mattered. |
| Scoped permission prompts | Each prompt named one action, its effect, and the rule requiring approval, with a narrower option. The operator approved, narrowed (approving only part of a change) or declined (keeping a fix in version control without deploying it) in one click. |
| Ask-first decision blocks (a recovery) | After the operator said they could not find the asks in a long report, the agent rewrote them as one block each: the ask, yes or no, and what happens on each answer. They answered all five in one line. |
| Evidence beside the question (a recovery) | Review questions written as concepts left the operator unsure what they were answering. Rewritten to point at a specific visible output with its evidence beside it, they worked better, though one passage still needed several readings. |

## What UTP's presentation should provide

Ranked by how many of the 53 negative cases each feature would have addressed (cases with a matching root cause):

1. **A consequence line per option and per default (14 cases).** Write it in the operator's terms: what changes for them, how often, and the revert path. It goes beside the choice, not after the action.
2. **Goal-linked status (13 cases).** Done and fixed claims are mapped to the goal or risk the operator stated, with evidence from the operator's vantage.
3. **An interpretation and scope-delta header (11 cases).** Show what was asked, what the agent is about to do, and what it narrowed, deferred or added, with the reason for each.
4. **One card per decision, ask first (10 cases).** The card gives the answer shape and the effect of each answer, with evidence and residuals below it, never buried in a report.
5. **Options framed by outcome, with the recommendation's rationale (10 cases).** Say what the recommended option preserves (often the current design) and what a bolder option would change. Echo the operator's own free-text answers as the frame for follow-up questions.
6. **Inline definitions for codes and internal names (9 cases).**
7. **A who-acts block for manual steps (8 cases).**
8. **Source and date on factual claims, and decision records tied to the decision itself (7 cases).**
9. **Approval binding (4 cases).** Echo the exact action, confirm a relayed approval with the human, and never infer approval from an ambiguous voice transcript.

The first four features together address 40 of the 53 negative cases.

## Limits

- One operator, two agents, and roughly four months. The operator writes tersely, often by voice, and redirects freely. That makes corrections visible, but the patterns may weight differently for other users.
- The candidate search used words that signal correction and confusion. Failures the operator never noticed, or never commented on, are missing. So are cases where a well-presented decision quietly prevented a problem.
- The figures on recommended options come from automatic answer classification and mix question types.
- Personal and third-party content in voice sessions was excluded entirely.
