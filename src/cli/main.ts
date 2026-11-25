#!/usr/bin/env node
// The utp command. Requests, answers and evidence travel as UTF-8 JSON files,
// never as inline arguments, because quoting differs between shells. --json
// prints machine-readable results; the exit code is the operation's code.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkDocument, checkRequest, intentFailure, reviewRequestsHash, validReviewIntent } from "../core/check.js";
import { transcriptRoots } from "../server/transcripts.js";
import { DIALOG_PLATFORMS, mapDialogResponse, projectReviewToDialog, type DialogCardBinding, type DialogPlatform, type NativeDialogResponse } from "../core/native-dialog.js";
import { waiverNotes } from "../core/quality.js";
import type { DeliveryAdapter } from "../core/delivery-adapter.js";
import type { DecisionLogEntry, NoticeDigest, ResumeCardPacket } from "../core/engine.js";
import { leakKinds, redactedDecisions } from "../core/redact.js";
import { writeNoticeDigest } from "../core/report-inbox.js";
import { EXIT, type Grant, type OpResult, type RequestBody } from "../core/types.js";
import { DEFAULT_PORT, startServer } from "../server/http.js";
import { createToken } from "../server/tokens.js";
import { call, CliError, readConfig, utpHome, writeConfig } from "./client.js";
import { closeout } from "./closeout.js";
import { closeoutHook } from "./closeout-hook.js";
import { checkout, fingerprints, projectFor, readRegistry, register } from "./registry.js";
import { cardMarkdown, grantText, resultText, reviewMarkdown, type RequestView, type ReviewView } from "./render.js";
import { runRecentReview, runReview } from "./review.js";
import { launchSetup, setupPlan } from "./setup.js";

const HELP = `utp: hand a person structured decisions, and get structured answers back.

Usage: utp <verb> [arguments] [--json] [--op-id <id>]

Setup       serve [--data <dir>] [--host <addr>] [--port <n>] [--review-origin <url>]
            token create <machine> [--data <dir>]
            connect <server-url>        (reads the token from standard input)
            setup <codex|claude|antigravity> [--apply] [-- <agent arguments>]
            init [--name <name>] [--new]
            link <project-id>
Requests    new <choose|approve|handoff|clarify|accept|assumptions|notice|judge> [--file <path>]
            check <file>
            closeout <report.json> [--keep-notices]
            closeout-hook               (Claude Code hook JSON on standard input)
            consider <decision.json>
            decide <decision.json>
            ask <file>
            stage <batch.json> [--flush]
            flush [<review-id>] [--intent <intent-or-review.json>]
            page <review-id>
            dialog <review-id|request-id> --platform <claude|codex|antigravity> [--tool <name>] [--preselects] [--non-interactive] [--map-response <file>]
            presented <review> [--channel <name>]
            show <id>
            status
            log [--tags a,b] [--related <id>] [--text <words>] [--kind <kind>]
            export <id>... --redact --file <output>
            leak-check <file>... [--generic]
            report-import --inbox <directory>
Answers     review [<review-id>] [--feedback] [--recent]
            answer <id@revision> [--option <id>] [--file <answer.json>] [--from-chat --quote-file <file> [--presentation <id>]]
                        [--clarify] [--withdraw] [--hide-until <time>] [--disposition answered_elsewhere|no_longer_matters]
            wait <id> [--timeout <seconds>] [--authority-file <decision.json>]
            resume [<review-id>]
Execution   claim-default <id>
            resolve-late <id> --resolution keep|redo
            begin <grant>
            applied <grant> --evidence <file>
            reconcile <grant> --outcome <outcome> --evidence <file>
            release <grant>
            takeover <id>
Changes     revise <id> <file>
            cancel <id>
            reverse <id> --file <reason.json>

Exit codes: 0 done or answered, 10 still waiting, 11 stale, 12 cancelled, 13 expired,
14 late conflict, 15 default claimed, 16 person answered first, 17 revoked,
18 the answer lacks the provenance its action needs, 19 not allowed now,
20 check failed, 21 clarification requested, 30 store busy, 31 lease epoch outdated, 32 can't reach the service,
40 not found, 1 anything else. The specification is docs/concept/lifecycle.md.
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "op-id": { type: "string" },
  data: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "review-origin": { type: "string" },
  name: { type: "string" },
  new: { type: "boolean" },
  file: { type: "string" },
  intent: { type: "string" },
  channel: { type: "string" },
  presentation: { type: "string" },
  option: { type: "string" },
  "from-chat": { type: "boolean" },
  "quote-file": { type: "string" },
  addressed: { type: "boolean" },
  withdraw: { type: "boolean" },
  "hide-until": { type: "string" },
  disposition: { type: "string" },
  timeout: { type: "string" },
  evidence: { type: "string" },
  outcome: { type: "string" },
  resolution: { type: "string" },
  tags: { type: "string" },
  related: { type: "string" },
  text: { type: "string" },
  kind: { type: "string" },
  redact: { type: "boolean" },
  generic: { type: "boolean" },
  feedback: { type: "boolean" },
  clarify: { type: "boolean" },
  "authority-file": { type: "string" },
  inbox: { type: "string" },
  apply: { type: "boolean" },
  launcher: { type: "string" },
  flush: { type: "boolean" },
  "keep-notices": { type: "boolean" },
  recent: { type: "boolean" },
  platform: { type: "string" },
  tool: { type: "string" },
  preselects: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  "verified-channel": { type: "boolean" },
  "map-response": { type: "string" },
} as const;

type Flags = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

function privateDenyList(): string[] {
  const file = path.join(utpHome(), "deny-list.json");
  if (!existsSync(file)) return [];
  try {
    const entries: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string" && entry.trim())) return entries;
  } catch {
    // Report the format error without putting the private contents in output.
  }
  throw new CliError(EXIT.OTHER, "deny-list.json must contain a JSON array of nonempty strings");
}

async function deliveryAdapter(): Promise<DeliveryAdapter> {
  const file = process.env.UTP_DELIVERY_ADAPTER;
  if (!file) return {};
  const adapter = await import(pathToFileURL(path.resolve(file)).href) as DeliveryAdapter;
  if ((adapter.sendReview !== undefined && typeof adapter.sendReview !== "function")
    || (adapter.formatInboxItem !== undefined && typeof adapter.formatInboxItem !== "function")
    || (!adapter.sendReview && !adapter.formatInboxItem)) {
    throw new CliError(EXIT.OTHER, "the delivery adapter must export sendReview or formatInboxItem");
  }
  return adapter;
}

function readJson(file: string | undefined, what: string): Record<string, unknown> {
  if (!file) throw new CliError(EXIT.OTHER, `${what} file is required`);
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    throw new CliError(EXIT.OTHER, `can't read ${what} file ${file}`);
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new CliError(EXIT.OTHER, `${what} file ${file} isn't a JSON object`);
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(EXIT.OTHER, `${what} is required; run utp --help`);
  return value;
}

const exampleEvidence = { claim: "Describe what you observed.", kind: "observed", source: "Where to verify it",
  date: new Date().toISOString().slice(0, 10) };

const TEMPLATES: Record<string, RequestBody> = {
  choose: {
    kind: "choose",
    category: "approach",
    question: "One sentence: what should the person decide?",
    why_now: "Explain what this decision addresses, what it will change, and why you need an answer now.",
    options: [
      { id: "a", label: "Short name", consequence: "What happens if this is chosen." },
      { id: "b", label: "Short name", consequence: "What happens if this is chosen." },
    ],
    recommendation: { option: "a", because: "Why.", preserves: "What it keeps.", bolder_alternative: "The braver choice." },
    glossary: { "Any project term": "Its plain meaning, the first time a card uses it." },
    stakes: { reversibility: "easy" },
    level: 2,
    level_reason: "A real trade-off that is still reversible.",
    tags: [],
    basis: { files: [] },
  },
  approve: {
    kind: "approve",
    question: "One sentence: what is the agent asking permission to do?",
    why_now: "Why this is being asked now.",
    options: [
      { id: "yes", label: "Do it", consequence: "The exact effect.",
        authorization: { action: "the action", target: "what it acts on", scope: "exactly how much", expected_effect: "the state after" } },
      { id: "narrow", narrower_than: "yes", label: "Approve the smaller scope", consequence: "What the smaller action changes.",
        authorization: { action: "the action", target: "what it acts on", scope: "the smaller scope", expected_effect: "the state after" } },
      { id: "no", label: "Don't", consequence: "What happens instead." },
    ],
    evidence: [exampleEvidence],
    stakes: { reversibility: "one_way" },
    level: 3,
    level_reason: "Why this can't be undone or reaches outside the project.",
    basis: { files: [] },
  },
  handoff: {
    kind: "handoff", question: "Can you complete this manual step?", why_now: "Explain what waits on it.",
    steps: [{ id: "step-1", actor: "the person", machine: "where to run it", shell: "the shell to use",
      command: "the command or manual action", expected_result: "what success looks like", tested: false,
      why_person: "Explain what access or observation requires the person." }],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "The agent needs the person's access or observation.",
  },
  clarify: {
    kind: "clarify", question: "Which reading of your request should I use?", why_now: "Explain what the interpretation changes.",
    options: [
      { id: "a", label: "The agent's reading", consequence: "What the agent will do under this reading." },
      { id: "b", label: "An alternative reading", consequence: "What the agent will do under this reading." },
    ],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "Different readings would change the work.",
  },
  accept: {
    kind: "accept", question: "Does the result cover your goals?", why_now: "Identify the result that needs the person's judgment.",
    goals: [{ id: "goal-1", goal: "A goal or risk from the request", coverage: "partly_covered", evidence: [exampleEvidence] }],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "The person is judging whether this result is acceptable.",
  },
  assumptions: {
    kind: "assumptions", question: "Which assumptions should the plan use?", why_now: "Say what is about to be planned or built.",
    assumptions: [{ id: "assumption-1", statement: "The assumption in plain language", consequence: "What it changes in the plan." }],
    stakes: { reversibility: "easy" }, level: 2, level_reason: "An incorrect assumption would change the plan.",
  },
  notice: {
    kind: "notice", question: "An informational update", why_now: "Say what happened and why it matters.",
    stakes: { reversibility: "easy" }, level: 1, level_reason: "The person needs to know what changed.",
  },
  judge: {
    kind: "judge", question: "Which sample works better for the stated goal?",
    summary: "Describe the result you are comparing and what the reviewer should look for.",
    why_now: "Pick the result that best meets the goal, then explain your preference.",
    stakes: { reversibility: "easy" }, level: 3, level_reason: "The choice needs the person's judgment.",
    blind: {
      candidates: [
        { identity: "First source", artifact: { text: "Preview of the first candidate." } },
        { identity: "Second source", artifact: { text: "Preview of the second candidate." } },
      ],
    },
  },
};

const SESSION_VERBS = new Set([
  "status", "consider", "decide", "ask", "stage", "flush", "presented", "answer", "wait", "resume",
  "claim-default", "resolve-late", "begin", "applied", "reconcile", "release",
  "takeover", "revise", "cancel", "reverse",
]);

function warnMissingSession(verb: string): void {
  if (!SESSION_VERBS.has(verb)) return;
  const session = process.env.UTP_SESSION?.trim();
  if (session && session !== "default") return;
  process.stderr.write(
    "utp: warning: UTP_SESSION is unset or \"default\"; concurrent sessions can collide on grants and chat transcript verification is disabled. Set UTP_SESSION to a unique session ID.\n",
  );
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const flags = values as Flags;
  const [verb, ...rest] = positionals;
  if (!verb || flags.help) {
    process.stdout.write(HELP);
    return verb || flags.help ? EXIT.OK : EXIT.OTHER;
  }
  warnMissingSession(verb);
  const opId = flags["op-id"];
  const out = (r: OpResult, human?: string): number => {
    process.stdout.write(`${flags.json ? JSON.stringify(r, null, 2) : (human ?? resultText(r))}\n`);
    return r.code;
  };
  const dataDir = flags.data ?? process.env.UTP_DATA ?? path.join(utpHome(), "data");

  switch (verb) {
    case "closeout-hook": {
      try {
        const response = closeoutHook(JSON.parse(readFileSync(0, "utf8")));
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      } catch {
        process.stderr.write("UTP could not check this turn's completion report.\n");
      }
      return EXIT.OK;
    }
    case "closeout": {
      const report = await closeout(readJson(rest[0], "completion report"), { keepNotices: flags["keep-notices"] === true });
      return out(report, report.markdown as string | undefined);
    }
    case "setup": {
      const plan = setupPlan(need(rest[0], "a platform"));
      if (flags.apply) return launchSetup(plan, rest.slice(1), flags.launcher);
      return out({ code: EXIT.OK, ...plan }, `${plan.access}\nAdapter files: ${plan.adapter}\nAdd --apply to start the session with this setting.`);
    }
    case "serve": {
      const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
      const adapter = await deliveryAdapter();
      const sources = process.env.UTP_TRANSCRIPT_SOURCES ?? path.join(dataDir, "transcript-sources.json");
      const svc = await startServer({ dataDir, host: flags.host, port, reviewOrigin: flags["review-origin"],
        transcriptRoots: process.env.UTP_TRANSCRIPT_SOURCES || existsSync(sources) ? transcriptRoots(readJson(sources, "transcript roots")) : undefined,
        reviewInboxSocket: process.env.UTP_REVIEW_INBOX_SOCKET,
        notifications: adapter.sendReview ? { send: adapter.sendReview } : undefined,
        inboxDir: process.env.UTP_REPORT_INBOX, formatInboxItem: adapter.formatInboxItem,
        reportExport: process.env.UTP_REPORT_EXPORT === "1",
        log: (l) => process.stderr.write(`${l}\n`) });
      process.stderr.write(`UTP service listening on ${svc.url}, data in ${dataDir}\n`);
      await new Promise<void>((resolve) => {
        const stop = () => void svc.close().then(resolve);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return EXIT.OK;
    }
    case "token": {
      if (rest[0] !== "create") throw new CliError(EXIT.OTHER, "usage: utp token create <machine>");
      const machine = need(rest[1], "a machine name");
      const token = createToken(dataDir, machine);
      if (flags.json) return out({ code: EXIT.OK, machine, token });
      process.stdout.write(`${token}\n`);
      process.stderr.write(`Token for ${machine}, shown only once. On ${machine}, run: utp connect <server-url>, with this token on standard input.\n`);
      return EXIT.OK;
    }
    case "connect": {
      const server = need(rest[0], "the server address");
      try {
        new URL(server);
      } catch {
        throw new CliError(EXIT.OTHER, `${server} isn't a URL, for example http://homeserver:${DEFAULT_PORT}`);
      }
      const token = readFileSync(0, "utf8").trim();
      if (!token) throw new CliError(EXIT.OTHER, "no token on standard input");
      const r = await call("ping", {}, { config: { server, token } });
      if (r.code !== EXIT.OK) return out(r);
      const file = writeConfig({ server, token });
      return out(r, `Connected to ${server} as ${String(r.machine)}. Settings saved in ${file}.`);
    }
    case "init": {
      const co = checkout();
      if (!co) throw new CliError(EXIT.OTHER, "utp init runs inside a Git checkout");
      const known = readRegistry().checkouts[co.commonDir];
      if (known) return out({ code: EXIT.OK, project: known }, `This checkout is already registered as ${known}.`);
      if (!flags.new && co.remote) {
        const found = await call("project.find", { remote: co.remote });
        const projects = (found.projects as { id: string }[] | undefined) ?? [];
        if (projects.length) {
          return out({ code: EXIT.NOT_ALLOWED, projects }, `A project with this checkout's remote is already registered: `
            + `${projects.map((p) => p.id).join(", ")}. Join it with utp link <project-id>, or create a separate project with utp init --new.`);
        }
      }
      const r = await call("project.create", { remote: co.remote, name: flags.name ?? path.basename(co.root) });
      if (r.code !== EXIT.OK) return out(r);
      const id = (r.project as { id: string }).id;
      register(co.commonDir, id);
      return out({ code: EXIT.OK, project: id }, `Registered this checkout as project ${id}.`);
    }
    case "link": {
      const project = need(rest[0], "a project id");
      const co = checkout();
      if (!co) throw new CliError(EXIT.OTHER, "utp link runs inside a Git checkout");
      const current = readRegistry().checkouts[co.commonDir];
      const linked = current && current !== project
        ? await call("project.relink", { from: current, to: project }, { opId })
        : await call("project.info", { project });
      if (linked.code !== EXIT.OK) return out(linked);
      if (current === project) return out({ code: EXIT.OK, project }, `This checkout is already linked to ${project}.`);
      register(co.commonDir, project);
      return out({ code: EXIT.OK, project }, `Linked this checkout to project ${project}.`);
    }
    case "new": {
      const kind = need(rest[0], "a request kind");
      const template = TEMPLATES[kind];
      if (!template) throw new CliError(EXIT.OTHER, `templates exist for: ${Object.keys(TEMPLATES).join(", ")}`);
      const text = JSON.stringify(template, null, 2) + "\n";
      if (flags.file) writeFileSync(flags.file, text);
      else process.stdout.write(text);
      return EXIT.OK;
    }
    case "check": {
      const body = readJson(rest[0], "request");
      const failures = checkDocument(body);
      if (failures.length) return out({ code: EXIT.CHECK_FAILED, failures });
      const batch = !Object.hasOwn(body, "kind") ? body.review as { requests: RequestBody[] } | undefined : undefined;
      const cards = batch?.requests ?? [body as unknown as RequestBody];
      const waivers = cards.flatMap((card, i) => (card.waivers ?? []).map(w => batch ? { request: i + 1, ...w } : w));
      const notes = cards.flatMap((card, i) => waiverNotes(card).map(note => batch ? `Request ${i + 1}. ${note}` : note));
      return out({ code: EXIT.OK, failures, ...(waivers.length ? { waivers } : {}) },
        notes.length ? notes.join("\n") : "No problems found.");
    }
    case "consider":
    case "decide": {
      const draft = readJson(rest[0], "decision");
      const { project, root } = projectFor();
      const body = draft.body as RequestBody | undefined;
      const files = body?.basis?.files;
      const basis = verb === "decide" && draft.level !== 0 && Array.isArray(files) && files.every((name) => typeof name === "string")
        ? fingerprints(root, files) : {};
      const r = await call(verb, { ...draft, basis }, { project, opId });
      if (flags.json) return out(r);
      if (r.level === 0) return out(r, `Routine ${String(r.category)} decisions recorded: ${String(r.count)}.`);
      const reversals = (r.reversals as DecisionLogEntry[] | undefined) ?? [];
      const lines = [r.code === EXIT.OK ? `Asking level ${String(r.level)}.` : resultText(r)];
      for (const prior of reversals) {
        for (const reversal of prior.reversals) lines.push(`Earlier reversal of ${prior.id}: ${reversal.reason}`);
      }
      if (r.code === EXIT.OK && r.id) lines.push(`Queued ${String(r.id)} in review ${String(r.review_id)}.`);
      if (r.code === EXIT.OK && r.use_request) lines.push(`Existing approval is recorded on ${String(r.use_request)}. Use utp wait with --authority-file for this decision.`);
      return out(r, lines.join("\n"));
    }
    case "ask":
    case "revise": {
      const file = verb === "ask" ? rest[0] : rest[1];
      const body = readJson(file, "request") as unknown as RequestBody;
      const failures = checkRequest(body);
      if (failures.length) return out({ code: EXIT.CHECK_FAILED, failures });
      const { project, root } = projectFor();
      const basis = fingerprints(root, body.basis?.files ?? []);
      const args = verb === "ask" ? { body, basis } : { id: need(rest[0], "a request id"), body, basis };
      const r = await call(verb, args, { project, opId });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      return out(r, `${verb === "ask" ? "Queued" : "Revised to"} ${String(r.id)}@${String(r.revision)} in review ${String(r.review_id)}.`
        + (r.role === "observer" ? " An equivalent request was already open, so this session observes it and receives its answer." : "")
        + (r.near_duplicate ? ` A similar request is open: ${String(r.near_duplicate)}.` : "")
        + " Run utp flush at a natural stopping point.");
    }
    case "stage": {
      const document = readJson(rest[0], "review batch");
      if (!Object.hasOwn(document, "review") || Object.hasOwn(document, "kind")) {
        throw new CliError(EXIT.CHECK_FAILED, "stage needs a batch file with review.intent and review.requests");
      }
      const failures = checkDocument(document, { strictDefaults: true });
      if (failures.length) return out({ code: EXIT.CHECK_FAILED, failures });
      const batch = document.review as { intent: unknown; requests: RequestBody[] };
      const { project, root } = projectFor();
      const allTags = [...new Set(batch.requests.flatMap(r => r.tags ?? []))];
      const allRelated = [...new Set(batch.requests.flatMap(r => r.related ?? []))];
      const maxLevel = Math.max(...batch.requests.map(r => r.level)) as 0 | 1 | 2 | 3;
      const considered = maxLevel > 0 && (allTags.length || allRelated.length)
        ? await call("consider", { level: maxLevel, tags: allTags, related: allRelated }, { project })
        : { code: EXIT.OK, reversals: [] };
      if (considered.code !== EXIT.OK) return out(considered);
      const reversals = (considered.reversals as DecisionLogEntry[] | undefined) ?? [];
      const warnings: string[] = [];
      const statusRes = await call("status", {}, { project });
      if (statusRes.code === EXIT.OK) {
        const queuedNotices = (statusRes.requests as { id: string; revision: number; kind: string; status: string }[])
          .filter(r => r.kind === "notice" && r.status === "queued");
        if (queuedNotices.length) {
          const level3Cards = batch.requests.filter(r => r.level === 3 && (r.kind === "approve" || r.options?.some(o => o.authorization)));
          if (level3Cards.length) {
            const shownNotices = await Promise.all(queuedNotices.map(n => call("show", { id: `${n.id}@${n.revision}` }, { project })));
            for (const shown of shownNotices) {
              if (shown.code !== EXIT.OK) continue;
              const notice = shown.request as { id: string; body: RequestBody; basis_files?: string[] };
              const noticeTags = new Set(notice.body.tags ?? []);
              const noticeFiles = new Set(notice.basis_files ?? []);
              for (const card of level3Cards) {
                const linked = (card.depends_on ?? []).some(dep => dep === notice.id || dep.startsWith(`${notice.id}@`))
                  || (card.related ?? []).includes(notice.id);
                if (linked) continue;
                const sharedTag = (card.tags ?? []).find(t => noticeTags.has(t));
                const sharedFile = (card.basis?.files ?? []).find(f => noticeFiles.has(f));
                if (sharedTag || sharedFile) {
                  warnings.push(`Level-3 card "${card.question}" shares ${sharedFile ? `basis file ${sharedFile}` : `tag ${sharedTag}`} with unlinked queued notice ${notice.id}.`);
                }
              }
            }
          }
        }
      }
      const batchIntent = batch.intent as { shared_glossary?: Record<string, string>; shared_evidence?: unknown[] } | undefined;
      const shared = batchIntent && (batchIntent.shared_glossary || batchIntent.shared_evidence)
        ? { ...(batchIntent.shared_glossary ? { glossary: batchIntent.shared_glossary } : {}),
            ...(batchIntent.shared_evidence ? { evidence: batchIntent.shared_evidence } : {}) }
        : undefined;
      const queued: { id: string; revision: number; review_id: string }[] = [];
      for (const [index, body] of batch.requests.entries()) {
        const basis = fingerprints(root, body.basis?.files ?? []);
        const cardOp = opId ? `${opId}:card-${index + 1}` : undefined;
        const r = await call("ask", { body, basis, ...(shared ? { shared } : {}) }, { project, opId: cardOp });
        if (r.code !== EXIT.OK) return out(r);
        queued.push({ id: String(r.id), revision: Number(r.revision), review_id: String(r.review_id) });
      }
      const reviewId = queued[0]?.review_id ?? null;
      if (!flags.flush) {
        const lines = [
          `Staged ${queued.length} card${queued.length === 1 ? "" : "s"} in review ${String(reviewId)}.`,
          ...reversals.flatMap(p => p.reversals.map(rv => `Prior reversal of ${p.id}: ${rv.reason}`)),
          ...warnings.map(w => `Warning: ${w}`),
          `Run utp flush ${String(reviewId)} --intent ${rest[0]} when ready.`,
        ];
        return out({ code: EXIT.OK, review_id: reviewId, items: queued.map(q => `${q.id}@${q.revision}`),
          flushed: false, reversals, warnings }, lines.join("\n"));
      }
      const flushArgs = { review: reviewId, intent: batch.intent, requests_hash: reviewRequestsHash(batch.requests) };
      const flushed = await call("flush", flushArgs, { project, opId: opId ? `${opId}:flush` : undefined });
      if (flushed.code !== EXIT.OK || !flushed.review_id) return out(flushed);
      const needsVerifiedPage = flushed.route === "conversation" && flushed.needs_verified_channel === true && flushed.chat_provenance === false;
      if (flushed.route === "review-page" || needsVerifiedPage) {
        const page = await call("review-page.prepare", { review: flushed.review_id }, { project });
        if (page.code !== EXIT.OK) return out({ ...page, review_id: flushed.review_id, reversals, warnings,
          message: `The review was prepared. Run utp page ${flushed.review_id} or utp review ${flushed.review_id} to answer it. ${page.message ?? ""}` });
        const prompt = needsVerifiedPage
          ? `This review includes a level-3 approval and verified chat is unavailable for this session. Open this review page or run utp review ${flushed.review_id} in your terminal.\n${String(page.url)}`
          : `Open this review page to answer the batch in one save.\n${String(page.url)}`;
        return out({ ...flushed, route: "review-page", url: page.url, flushed: true, reversals, warnings }, prompt);
      }
      if (flags.json) return out({ ...flushed, flushed: true, reversals, warnings });
      if (flushed.digest === true) return out({ ...flushed, flushed: true, reversals, warnings }, "These notices are queued for the morning report.");
      const shown = await call("show", { id: flushed.review_id }, { project });
      const review = shown.review as ReviewView;
      return out({ ...flushed, flushed: true, reversals, warnings },
        `${reviewMarkdown(review)}\n\nAfter this review appears in your message to the person, run: utp presented ${review.id} --channel conversation`);
    }
    case "flush": {
      const { project } = projectFor();
      const args: Record<string, unknown> = {};
      if (rest[0]) args.review = rest[0];
      if (flags.intent !== undefined) {
        const document = readJson(flags.intent, "review intent");
        if (Object.hasOwn(document, "review") && !Object.hasOwn(document, "kind")) {
          const failures = checkDocument(document);
          if (failures.length) return out({ code: EXIT.CHECK_FAILED, failures });
          const batch = document.review as { intent: unknown; requests: unknown[] };
          args.intent = batch.intent;
          args.requests_hash = reviewRequestsHash(batch.requests);
        } else {
          args.intent = document;
        }
        if (!validReviewIntent(args.intent)) return out({ code: EXIT.CHECK_FAILED, failures: [intentFailure] });
      }
      const r = await call("flush", args, { project, opId });
      if (r.code !== EXIT.OK || !r.review_id) return out(r);
      const needsVerifiedPage = r.route === "conversation" && r.needs_verified_channel === true && r.chat_provenance === false;
      if (r.route === "review-page" || needsVerifiedPage) {
        const page = await call("review-page.prepare", { review: r.review_id }, { project });
        if (page.code !== EXIT.OK) return out({ ...page, review_id: r.review_id,
          message: `The review was prepared. Run utp page ${r.review_id} or utp review ${r.review_id} to answer it. ${page.message ?? ""}` });
        const prompt = needsVerifiedPage
          ? `This review includes a level-3 approval and verified chat is unavailable for this session. Open this review page or run utp review ${r.review_id} in your terminal.\n${String(page.url)}`
          : `Open this review page to answer the batch in one save.\n${String(page.url)}`;
        return out({ ...r, route: "review-page", url: page.url }, prompt);
      }
      if (flags.json) return out(r);
      if (r.digest === true) return out(r, "These notices are queued for the morning report.");
      const shown = await call("show", { id: r.review_id }, { project });
      const review = shown.review as ReviewView;
      return out(r, `${reviewMarkdown(review)}\n\nAfter this review appears in your message to the person, run: `
        + `utp presented ${review.id} --channel conversation`);
    }
    case "presented": {
      const { project } = projectFor();
      return out(await call("presented", { review: need(rest[0], "a review id"), channel: flags.channel ?? "conversation" }, { project, opId }));
    }
    case "page": {
      const { project } = projectFor();
      const r = await call("review-page.prepare", { review: need(rest[0], "a review id") }, { project });
      return out(r, r.code === EXIT.OK ? `Open the review page in your browser.\n${String(r.url)}` : undefined);
    }
    case "dialog": {
      const { project } = projectFor();
      const targetId = need(rest[0], "a review id or request id");
      const rawPlatform = need(flags.platform, "--platform (claude, codex, or antigravity)");
      if (!DIALOG_PLATFORMS.includes(rawPlatform as DialogPlatform)) {
        throw new CliError(EXIT.OTHER, `platform must be one of: ${DIALOG_PLATFORMS.join(", ")}`);
      }
      const platform = rawPlatform as DialogPlatform;
      const shown = await call("show", { id: targetId }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const review: ReviewView = shown.review
        ? (shown.review as ReviewView)
        : { id: (shown.request as RequestView).review_id ?? targetId, items: [shown.request as RequestView] };
      const projection = projectReviewToDialog(review, {
        platform,
        tool: flags.tool,
        interactive: flags["non-interactive"] ? false : true,
        preselectsOption: flags.preselects === true,
        verifiedChannel: flags["verified-channel"] === true,
      });
      if (flags["map-response"]) {
        const raw = readJson(flags["map-response"], "dialog response") as NativeDialogResponse & { binding?: DialogCardBinding };
        const explicitRef = (typeof raw.ref === "string" && raw.ref.trim() ? raw.ref.trim() : undefined)
          ?? (typeof raw.binding?.ref === "string" && raw.binding.ref.trim() ? raw.binding.ref.trim() : undefined);
        if (!explicitRef) {
          throw new CliError(EXIT.OTHER, "dialog response must include ref (id@revision) or binding.ref");
        }
        const targetReqId = explicitRef.split("@")[0];
        const card = review.items.find((c) => `${c.id}@${c.revision}` === explicitRef)
          ?? review.items.find((c) => c.id === targetReqId && c.current);
        if (!card) throw new CliError(EXIT.NOT_FOUND, `no matching card for ${explicitRef}`);
        const binding: DialogCardBinding = raw.binding && typeof raw.binding === "object"
          ? raw.binding
          : {
            ref: explicitRef,
            question: card.body.question,
            option_ids: (card.body.options ?? []).map((o) => o.id),
            label_to_id: Object.create(null) as Record<string, string>,
            has_authorization: card.body.kind === "approve" || (card.body.options ?? []).some((o) => !!o.authorization),
          };
        const mapped = mapDialogResponse(card, binding, raw);
        if (!mapped.ok) return out({ code: mapped.code, error: mapped.error, message: mapped.message });
        if (!projection.eligible) {
          return out({ code: EXIT.NOT_ALLOWED, error: "dialog_ineligible", reasons: projection.reasons,
            message: `Dialog is ineligible for ${projection.platform} ${projection.tool} (${projection.reasons.map((r) => r.code).join(", ")}); use ${projection.fallback}.` });
        }
        return out({ code: EXIT.OK, ...mapped }, "skipped" in mapped ? mapped.message
          : "clarification" in mapped ? `Clarification requested for ${mapped.clarification.id}: ${mapped.clarification.note}`
          : `Mapped answer for ${mapped.answer.id}: ${mapped.answer.value ?? mapped.answer.custom}`);
      }
      const human = projection.eligible
        ? `Eligible for ${projection.platform} ${projection.tool} (${projection.payload!.questions.length} question${projection.payload!.questions.length === 1 ? "" : "s"}).\nUse --json for the native payload and revision binding.`
        : `Native dialog refused for ${projection.platform} ${projection.tool} (${projection.reasons.map((r) => r.code).join(", ")}). Fall back to ${projection.fallback}:\n\n${projection.fallback_markdown}`;
      return out({ code: EXIT.OK, ...projection }, human);
    }
    case "show": {
      const { project } = projectFor();
      const r = await call("show", { id: need(rest[0], "an id") }, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      if (r.review) return out(r, reviewMarkdown(r.review as ReviewView, "history"));
      if (r.grant) return out(r, `${grantText(r.grant as never)}\n\n${cardMarkdown(r.request as RequestView)}`);
      return out(r, cardMarkdown(r.request as RequestView));
    }
    case "status": {
      const { project } = projectFor();
      const r = await call("status", {}, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      const reqs = r.requests as { id: string; revision: number; status: string; question: string; clarification?: unknown }[];
      return out(r, reqs.length ? reqs.map((q) => `${q.id}@${q.revision}  ${q.status.padEnd(15)}  ${q.question}`
        + (q.clarification ? " (clarification requested)" : "")).join("\n") : "Nothing is open.");
    }
    case "log": {
      const { project } = projectFor();
      const r = await call("log", {
        tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        related: flags.related, text: flags.text, kind: flags.kind,
      }, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      const entries = r.entries as DecisionLogEntry[];
      return out(r, entries.length ? entries.map((e) => `${e.id}  ${e.status}  ${e.answer ?? "-"}  ${e.question}`
        + (e.reversals.length ? `  (reversed ${e.reversals.length}x)` : "")
        + (e.archived ? `  (archived from ${e.origin_project})` : "")).join("\n") : "No matching decisions.");
    }
    case "export": {
      if (!flags.redact) throw new CliError(EXIT.OTHER, "export requires --redact");
      if (!rest.length) throw new CliError(EXIT.OTHER, "select at least one request id to export");
      const file = need(flags.file, "--file with an output path");
      const denyList = privateDenyList();
      const { project } = projectFor();
      const logged = await call("log", {}, { project });
      if (logged.code !== EXIT.OK) return out(logged);
      const entries = logged.entries as DecisionLogEntry[];
      const selected = [...new Set(rest)].map((id) => {
        const matches = entries.filter((entry) => entry.id === id);
        const first = matches[0];
        if (!first) throw new CliError(EXIT.NOT_FOUND, `no decision ${id} in this project`);
        if (matches.length > 1) throw new CliError(EXIT.OTHER, `decision id ${id} occurs in more than one archive`);
        return first;
      });
      const text = redactedDecisions(selected, denyList);
      const leaks = leakKinds(text, denyList);
      if (leaks.length) return out({ code: EXIT.CHECK_FAILED, leaks }, `Export stopped. Possible leaks: ${leaks.join(", ")}.`);
      try {
        writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      } catch {
        throw new CliError(EXIT.OTHER, "couldn't write the export; choose an unused file in an existing folder");
      }
      return out({ code: EXIT.OK, decisions: selected.length }, `Wrote and checked ${selected.length} redacted decision records.`);
    }
    case "leak-check": {
      if (!rest.length) throw new CliError(EXIT.OTHER, "leak-check needs at least one file");
      const denyList = flags.generic ? [] : privateDenyList();
      const findings = rest.flatMap((file) => {
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          throw new CliError(EXIT.OTHER, `can't read file ${file}`);
        }
        const leaks = leakKinds(text, denyList);
        return leaks.length ? [{ file, leaks }] : [];
      });
      return out({ code: findings.length ? EXIT.CHECK_FAILED : EXIT.OK, findings },
        findings.length ? findings.map(({ file, leaks }) => `${file}: ${leaks.join(", ")}`).join("\n") : "No leaks found.");
    }
    case "review": {
      const { project } = projectFor();
      readConfig();
      const io = { input: process.stdin, output: process.stdout, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
      if (flags.recent) return runRecentReview(project, io);
      return runReview(project, io, flags.feedback, rest[0]);
    }
    case "resume": {
      const { project, root } = projectFor();
      const review = rest[0];
      const probe = await call("resume", { ...(review ? { review } : {}), files_only: true }, { project });
      if (probe.code !== EXIT.OK) return out(probe);
      const files = (probe.basis_files as string[] | undefined) ?? [];
      const basis = fingerprints(root, files);
      const r = await call("resume", { ...(review ? { review } : {}), basis }, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      const cards = (r.cards as ResumeCardPacket[] | undefined) ?? [];
      if (!cards.length) return out(r, review ? `No active cards in review ${review}.` : "Nothing open to resume.");
      const lines = cards.map((c) => {
        const extras: string[] = [];
        if (c.answer?.value) extras.push(`answer=${c.answer.value}`);
        else if (c.answer?.custom) extras.push(`custom="${c.answer.custom}"`);
        else if (c.answer?.disposition) extras.push(`disposition=${c.answer.disposition}`);
        if (c.clarification) extras.push(`clarify="${c.clarification.note ?? ""}"`);
        if (c.stale_files.length) extras.push(`stale=[${c.stale_files.join(", ")}]`);
        if (c.needs_takeover) extras.push(`takeover from ${c.owner.session}@${c.owner.machine}`);
        return `${c.id}@${c.revision}  ${c.status.padEnd(14)}  next=${c.next_action}${extras.length ? `  (${extras.join("; ")})` : ""}  — ${c.question}`;
      });
      return out(r, lines.join("\n"));
    }
    case "report-import": {
      const inbox = need(flags.inbox, "--inbox with the morning report inbox directory");
      const adapter = await deliveryAdapter();
      const report = await call("report.pending", {});
      if (report.code !== EXIT.OK) return out(report);
      const pending = report.pending as (NoticeDigest & { project: string })[];
      for (const digest of pending) {
        writeNoticeDigest(inbox, digest.project, digest, adapter.formatInboxItem);
        const receipt = await call("report.received", { review: digest.review }, { project: digest.project });
        if (receipt.code !== EXIT.OK) return out(receipt);
      }
      return out({ code: EXIT.OK, imported: pending.length }, `Morning report items imported: ${pending.length}.`);
    }
    case "answer": {
      const { project } = projectFor();
      const args: Record<string, unknown> = { id: need(rest[0], "a request id"), channel: "cli" };
      if (flags.file) Object.assign(args, readJson(flags.file, "answer"), { id: args.id, channel: "cli" });
      if (flags.option) args.value = flags.option;
      if (flags["from-chat"]) {
        args.channel = "conversation";
        args.quote = readFileSync(need(flags["quote-file"], "--quote-file with the person's words"), "utf8");
      }
      if (flags.presentation) args.presentation = flags.presentation;
      if (flags.addressed) args.addressed = true;
      if (flags.withdraw) args.withdraw = true;
      if (flags.clarify) args.clarify = true;
      if (flags["hide-until"]) args.hide_until = flags["hide-until"];
      if (flags.disposition) args.disposition = flags.disposition;
      return out(await call("answer", args, { project, opId }));
    }
    case "wait": {
      const { project, root } = projectFor();
      const id = need(rest[0], "a request id");
      const draft = flags["authority-file"] && readJson(flags["authority-file"], "decision");
      const authority = draft ? draft.authority as { decision_id?: unknown; authorization?: unknown } | undefined : undefined;
      if (draft && (!authority?.authorization || typeof authority.decision_id !== "string" || ![1, 2, 3].includes(draft.level as number))) {
        throw new CliError(EXIT.OTHER, "the authority file needs the proposed level, the cited decision id and the exact authorization");
      }
      if (typeof authority?.decision_id === "string" && (authority.decision_id.includes("@") ? authority.decision_id !== id
        : !id.startsWith(authority.decision_id + "@"))) {
        throw new CliError(EXIT.OTHER, "use the cited decision and revision returned by utp decide");
      }
      const timeoutS = flags.timeout ? Number(flags.timeout) : 0;
      if (!Number.isFinite(timeoutS) || timeoutS < 0) throw new CliError(EXIT.OTHER, "--timeout takes a number of seconds");
      const shown = await call("show", { id }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const files = (shown.request as { basis_files: string[] }).basis_files;
      const deadline = Date.now() + timeoutS * 1000;
      for (;;) {
        const remaining = Math.max(0, deadline - Date.now());
        const r = await call("wait", { id, timeout_s: Math.ceil(remaining / 1000), basis: fingerprints(root, files),
          ...(authority && draft ? { authority: authority.authorization, authority_level: draft.level } : {}) },
          { project, opId, timeoutMs: remaining + 60_000 });
        if (r.code !== EXIT.WAITING || Date.now() >= deadline) return out(r, r.code === EXIT.WAITING ? `Still waiting (${String(r.status)}).` : undefined);
      }
    }
    case "claim-default":
    case "resolve-late": {
      const { project, root } = projectFor();
      const id = need(rest[0], "a request id");
      const shown = await call("show", { id }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const files = (shown.request as { basis_files: string[] }).basis_files;
      const args = { id, basis: fingerprints(root, files), resolution: flags.resolution };
      return out(await call(verb, args, { project, opId }));
    }
    case "begin": {
      const { project, root } = projectFor();
      const grant = need(rest[0], "a grant id");
      const shown = await call("show", { id: grant }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const files = (shown.request as { basis_files: string[] }).basis_files;
      const r = await call("begin", { grant, basis: fingerprints(root, files) }, { project, opId });
      return out(r, r.code === EXIT.OK ? `Go ahead: ${grantText((shown.grant as never))}. Run utp applied ${grant} --evidence <file> afterwards.` : undefined);
    }
    case "applied": {
      const { project, root } = projectFor();
      const grant = need(rest[0], "a grant id");
      const evidence = readJson(flags.evidence, "evidence");
      const shown = await call("show", { id: grant }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const files = (shown.request as { basis_files: string[] }).basis_files;
      return out(await call("applied", { grant, evidence,
        ...((shown.grant as Grant | undefined)?.from_default ? { applied_basis: fingerprints(root, files) } : {}),
      }, { project, opId }));
    }
    case "reconcile": {
      const { project, root } = projectFor();
      const grant = need(rest[0], "a grant id");
      const evidence = readJson(flags.evidence, "evidence");
      const args: Record<string, unknown> = { grant, outcome: need(flags.outcome, "--outcome"), evidence };
      if (flags.outcome === "partial" || flags.outcome === "completed") {
        const shown = await call("show", { id: grant }, { project });
        if (shown.code !== EXIT.OK) return out(shown);
        const files = (shown.request as { basis_files: string[] }).basis_files;
        if (flags.outcome === "partial") {
          args.recovery_basis = fingerprints(root, files);
          args.remaining_scope = evidence.remaining_scope;
          args.unanticipated = evidence.unanticipated === true;
        } else if ((shown.grant as Grant | undefined)?.from_default) {
          args.applied_basis = fingerprints(root, files);
        }
      }
      return out(await call("reconcile", args, { project, opId }));
    }
    case "release":
    case "takeover":
    case "cancel": {
      const { project } = projectFor();
      const ref = need(rest[0], verb === "release" ? "a grant id" : "a request id");
      return out(await call(verb, verb === "release" ? { grant: ref } : { id: ref }, { project, opId }));
    }
    case "reverse": {
      const { project } = projectFor();
      const reason = readJson(flags.file, "reason");
      return out(await call("reverse", { id: need(rest[0], "a request id"), reason: reason.reason, tags: reason.tags }, { project, opId }));
    }
    default:
      throw new CliError(EXIT.OTHER, `unknown verb ${verb}; run utp --help`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof CliError) {
      process.stderr.write(`utp: ${e.message}\n`);
      process.exitCode = e.code;
      return;
    }
    process.stderr.write(`utp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = EXIT.OTHER;
  },
);
