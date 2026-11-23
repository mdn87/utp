# UTP agent instructions

UTP (user testing platform) helps coding agents hand a person a structured
decision or review request, and hands the person's answer back to the agent
as structured data. These instructions apply to any agent working in this
repository: Claude Code, Codex, Antigravity, or another.

## Current phase

Phase 1: verify the lifecycle on the shared service and deliver the seven
everyday request kinds, the default policy, and the batch review page.
The code targets TypeScript on Node 20 or later. `docs/concept/` is the
specification and `docs/decisions/` records the person's answers.
[Review 0002](docs/decisions/0002-followup-review.answers.json) sets the
release scope and default policy. Blind comparisons and migration of the
existing comparison workflows are phase 2 work.

## Build and test

Node 20 or later. `npm ci`, then `npm test`, which compiles to `dist/` and runs
every test. In a synced or backed-up folder, keep `node_modules` and build
output elsewhere: set `UTP_TOOLING_DIR` to a folder whose `node_modules` holds
`typescript` and `@types/node`, and `UTP_BUILD_DIR` to the build folder, for
both `node scripts/build.mjs` and `node scripts/test.mjs`.
If the shell uses an HTTP proxy, install the project's dependencies in the
tooling directory and keep `UTP_TOOLING_DIR` set when running the CLI.

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
