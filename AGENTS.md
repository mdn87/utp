# UTP agent instructions

UTP (user testing platform) helps coding agents hand a person a structured
decision or review request, and hands the person's answer back to the agent
as structured data. These instructions apply to any agent working in this
repository: Claude Code, Codex, Antigravity, or another.

## Current phase

Concept under review. `docs/concept/concept.md` is the working concept and
`docs/research/` holds the prior-art and failure-pattern research behind it.
Do not start implementation work until the concept's open decisions are
answered; record answers in `docs/decisions/`.

## Public repository

This repository is public. Never commit transcripts, chat excerpts, personal
details, hostnames, IP addresses, credentials, or private project internals.
Research evidence drawn from private sessions stays in `private/`, which is
git-ignored. Public documents describe patterns in general terms only.

## Design rules

- The command line is the backbone. Every feature must work from a plain
  terminal through files and the `utp` command. Desktop-app conveniences
  (in-app question dialogs, hosted pages, phone inboxes) are optional
  renderers over the same data, never a requirement.
- Platform adapters (Claude Code, Codex, Antigravity) stay thin: they teach
  an agent when to ask and how to call `utp`; they do not fork the format.
- UTP reviews itself. Design decisions for this project are written as UTP
  decision requests and answered through UTP once it can render them.

## Conventions

- Conventional commit messages.
- Plain language in human-facing text: say what happened, what remains, and
  who acts next. Define a project term the first time a document uses it.
