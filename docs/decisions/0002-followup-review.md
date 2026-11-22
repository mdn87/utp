---
title: UTP review 0002: three answers that need another pass
review: V-20261122-followup
format: UTP v0 (hand-written draft; source is the .json beside this file)
---

# UTP review 0002: three answers that need another pass

## What you asked for, and what this review does

**You asked:** You saved your answers to review 0001 and asked me to carry on.

**Doing:** Recording your answers and starting phase 1a on the settled ones: the home-server log, TypeScript, and the MIT license. Asking three things again (D1 and D5 in plainer words, and D4 with the result of the multi-agent debate you asked for), and confirming one D6 item that used the same undefined term as D1.

**Narrowed:** nothing.

**Deferred:**
- Phase 1 work that depends on D1, D4 or D5. It waits for these answers; the lifecycle core doesn't.

**Added:**
- A definitions list on every card that uses a term of art. D1 used 'blind-ballot pages' without defining it.

## D1. Which kinds of questions should the first version of UTP handle?

kind `choose` · category `approach` · reversibility `easy` · level 3: Scope of the first release is the person's call.

Why now: Phase 1 builds these first; the rest wait for phase 2. Last time this card used 'blind-ballot pages' without saying what they are.

Your answer to D5 affects this card.

Terms on this card:

- **Blind comparison (the old card's 'blind-ballot pages')**: The design-lab pages where you saw two or more results side by side without knowing which agent made which, and voted for one.
- **Manual step**: Something only you can do, such as running a command on a machine the agent can't reach. The card says where, how, and what success looks like.
- **Result check**: A card asking whether finished work is what you wanted, item by item against what you asked for.
- **Assumption list**: A list of things the agent assumed; you keep each one or change it.

| Option | What happens |
|---|---|
| **a.** Every everyday kind (recommended) | Choices, approvals, manual steps, clarifying what you meant, result checks, assumption lists, and FYI notes. Together they cover 50 of the 60 problem cases from your sessions. Phase 1 takes longer than option b. |
| **b.** Choices and approvals only | A usable first version sooner. Manual steps (8 of the cases) and result checks (5) keep happening in plain chat until phase 2. |
| **c.** Every everyday kind, plus blind comparisons now | Blind comparisons move into phase 1. They need a page that shows results side by side, so phase 1 also builds the review page; if you pick D5 option a, that page is being built anyway, so this costs less. |

**Recommendation: option a.** It covers the cases that went wrong in your sessions without waiting on page work. It preserves: A command-line core that works before any page exists. Bolder alternative: Option c, if you want the comparison pages replaced soon.

Evidence (observed, review 0001 answer, 2026-11-22): Your answer to the previous version said you didn't know what blind-ballot pages are.

Answer: one of a, b, c, or your own answer.

## D4. When an agent reaches work that depends on a question you haven't answered, what should it do?

kind `choose` · category `process` · reversibility `easy` · level 3: Sets the asking policy the person lives with.

Why now: You asked agents to try to agree on this first. They did; this card shows what they agreed and where they split.

Terms on this card:

- **Default**: The option the agent would take if you never answered, stated on the card in advance.
- **One-step undo**: A change that one command or one edit reverses, with nothing outside the project touched.
- **Panel**: Several agents from different companies debating a question, as you asked for here. This one took about 5 minutes of agent time.

| Option | What happens |
|---|---|
| **a.** Defaults only for small choices with a one-step undo (recommended) | Agents keep moving on local choices that one step can reverse and that aren't design, scope, approvals, result checks or matters of taste; anything they can't classify waits. Each default shows in your next review as 'applied by default: change?'. When you change one, the agent logs why and proposes making that kind of question always wait, for you to confirm. |
| **b.** Always wait | No wrong turns from defaults, but agents stop sooner and ask you more often, against your rule that they decide routine things themselves. |
| **c.** Defaults for any reversible choice, design included | Fastest, but you changed the agent's recommendation 37 times out of 72, mostly on design questions, so expect rework. |
| **e.** Option a, plus a panel before bigger technical defaults | Your original idea as a standing rule. Each panel costs minutes and tokens, and all three agents argued that agents agreeing with each other can't tell what you'd want on design or taste, and can't give themselves permission. |

**Recommendation: option a.** All three agents converged on it after debating: routine work keeps moving, and design, taste and anything unclear come to you. It preserves: Your rule that agents decide routine things themselves. Bolder alternative: Option c.

Note: Whichever you pick: a panel runs only when you ask for one, and it can only make an agent more careful, never let it act.

Evidence (observed, multi-agent debate, 2026-11-22): Codex, Antigravity and Claude Opus each recommended option a after a rebuttal round; Antigravity withdrew its panel-before-defaults proposal (option e) in rebuttal.

Evidence (observed, multi-agent debate, 2026-11-22): They split on one point: two would make an overridden kind of question always wait automatically, one would have the agent propose it for you to confirm. Option a uses the second, because an automatic switch changes the rules without you.

Evidence (observed, multi-agent debate, 2026-11-22): Codex's opening could read the other two openings first, because its usual route was refused for that step, so its view may lean on theirs.

Evidence (observed, multi-agent debate, 2026-11-22): The debate took about 4.6 minutes of agent time; token use wasn't measured.

Answer: one of a, b, c, e, or your own answer.

## D5. Where do you want to answer the agents' questions?

kind `choose` · category `design` · reversibility `easy` · level 3: Sets the person's daily experience of UTP.

Why now: You said large batches belong in one window, and that the last version's options were hard to follow. These are the same choices in plainer terms.

Terms on this card:

- **Batch**: Several questions sent together at a natural stopping point, like this page.
- **Review page**: A page like this one, with every card in the batch, answered and saved at once. Until UTP's own page exists, batches can keep using pages like this one.

| Option | What happens |
|---|---|
| **a.** Small ones in the chat, big batches on one page (recommended) | One or two questions appear as cards in the conversation and you reply there. Three or more come as one page like this one, and you save once. UTP's own page moves into phase 1, so phase 1 takes longer. |
| **b.** Everything on a page, even a single question | Every answer is captured directly, but you open a page even for one quick question. |
| **c.** Everything in the chat, even big batches | You never leave the conversation, but a big batch becomes one long message to reply to. |

**Recommendation: option a.** It's what you described: large batches in one window, while quick questions stay where you already are. It preserves: The conversation as your main place for quick answers. Bolder alternative: Option b, for the strongest guarantee that every answer came from you.

Note: Pop-up question dialogs inside the Claude, Codex and Antigravity apps come later as an extra, whichever you pick. The 'three or more' cutoff is a guess; say if you want a different one.

Evidence (observed, review 0001 answer, 2026-11-22): Your answer to the previous version: large batches in one window, and the options as written were hard to follow.

Answer: one of a, b, c, or your own answer.

## D6b. Should UTP take over the blind comparison pages from the design lab?

kind `choose` · category `scope` · reversibility `easy` · level 2: Changes which page the experiments use; easy to switch back.

Why now: You kept this item in D6, but D1 showed the term wasn't defined, so this confirms it now that it is.

Your answer to D1 affects this card.

Terms on this card:

- **Blind comparison pages**: The design-lab pages where you saw two or more results side by side without knowing which agent made which, and voted for one.

| Option | What happens |
|---|---|
| **keep.** Yes, fold them into UTP (recommended) | One maintained copy instead of three. The experiments switch to UTP's comparison page in phase 2, or phase 1 if you pick D1 option c. |
| **leave.** No, leave them as they are | The experiments keep their own pages, and UTP's comparison cards stay separate from them. |

**Recommendation: option keep.** Three near-identical copies drift apart; one shared page gets each fix once. It preserves: How the experiments run today, until UTP's page is ready. Bolder alternative: Moving them in phase 1 with D1 option c.

Evidence (observed, review 0001 answer, 2026-11-22): You kept this item in your D6 answer.

Answer: one of keep, leave, or your own answer.
