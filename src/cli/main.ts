#!/usr/bin/env node
// The utp command. Requests, answers and evidence travel as UTF-8 JSON files,
// never as inline arguments, because quoting differs between shells. --json
// prints machine-readable results; the exit code is the operation's code.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkRequest } from "../core/check.js";
import type { DecisionLogEntry } from "../core/engine.js";
import { EXIT, type Grant, type OpResult, type RequestBody } from "../core/types.js";
import { DEFAULT_PORT, startServer } from "../server/http.js";
import { createToken } from "../server/tokens.js";
import { call, CliError, readConfig, utpHome, writeConfig } from "./client.js";
import { checkout, fingerprints, projectFor, readRegistry, register } from "./registry.js";
import { cardMarkdown, grantText, resultText, reviewMarkdown, type RequestView, type ReviewView } from "./render.js";
import { runReview } from "./review.js";

const HELP = `utp: hand a person structured decisions, and get structured answers back.

Usage: utp <verb> [arguments] [--json] [--op-id <id>]

Setup       serve [--data <dir>] [--host <addr>] [--port <n>]
            token create <machine> [--data <dir>]
            connect <server-url>        (reads the token from standard input)
            init [--name <name>] [--new]
            link <project-id>
Requests    new <choose|approve> [--file <path>]
            check <file>
            ask <file>
            flush
            presented <review> [--channel <name>]
            show <id>
            status
            log [--tags a,b] [--related <id>] [--text <words>] [--kind <kind>]
Answers     review
            answer <id> [--option <id>] [--file <answer.json>] [--from-chat --quote-file <file> [--addressed]]
                        [--withdraw] [--hide-until <time>] [--disposition answered_elsewhere|no_longer_matters]
            wait <id> [--timeout <seconds>]
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
20 check failed, 30 store busy, 31 lease epoch outdated, 32 can't reach the service,
40 not found, 1 anything else. The specification is docs/concept/lifecycle.md.
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "op-id": { type: "string" },
  data: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  name: { type: "string" },
  new: { type: "boolean" },
  file: { type: "string" },
  channel: { type: "string" },
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
} as const;

type Flags = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

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

const TEMPLATES: Record<string, RequestBody> = {
  choose: {
    kind: "choose",
    question: "One sentence: what should the person decide?",
    why_now: "Why this is being asked now, and what waits on it.",
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
      { id: "no", label: "Don't", consequence: "What happens instead." },
    ],
    stakes: { reversibility: "one_way" },
    level: 3,
    level_reason: "Why this can't be undone or reaches outside the project.",
    basis: { files: [] },
  },
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const flags = values as Flags;
  const [verb, ...rest] = positionals;
  if (!verb || flags.help) {
    process.stdout.write(HELP);
    return verb || flags.help ? EXIT.OK : EXIT.OTHER;
  }
  const opId = flags["op-id"];
  const out = (r: OpResult, human?: string): number => {
    process.stdout.write(`${flags.json ? JSON.stringify(r, null, 2) : (human ?? resultText(r))}\n`);
    return r.code;
  };
  const dataDir = flags.data ?? process.env.UTP_DATA ?? path.join(utpHome(), "data");

  switch (verb) {
    case "serve": {
      const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
      const svc = await startServer({ dataDir, host: flags.host, port, log: (l) => process.stderr.write(`${l}\n`) });
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
      const failures = checkRequest(readJson(rest[0], "request"));
      const r: OpResult = { code: failures.length ? EXIT.CHECK_FAILED : EXIT.OK, failures };
      return out(r, failures.length ? resultText(r) : "No problems found.");
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
    case "flush": {
      const { project } = projectFor();
      const r = await call("flush", {}, { project, opId });
      if (r.code !== EXIT.OK || !r.review_id || flags.json) return out(r);
      const shown = await call("show", { id: r.review_id }, { project });
      const review = shown.review as ReviewView;
      return out(r, `${reviewMarkdown(review)}\n\nAfter this review appears in your message to the person, run: `
        + `utp presented ${review.id} --channel conversation`);
    }
    case "presented": {
      const { project } = projectFor();
      return out(await call("presented", { review: need(rest[0], "a review id"), channel: flags.channel ?? "conversation" }, { project, opId }));
    }
    case "show": {
      const { project } = projectFor();
      const r = await call("show", { id: need(rest[0], "an id") }, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      if (r.review) return out(r, reviewMarkdown(r.review as ReviewView));
      if (r.grant) return out(r, `${grantText(r.grant as never)}\n\n${cardMarkdown(r.request as RequestView)}`);
      return out(r, cardMarkdown(r.request as RequestView));
    }
    case "status": {
      const { project } = projectFor();
      const r = await call("status", {}, { project });
      if (r.code !== EXIT.OK || flags.json) return out(r);
      const reqs = r.requests as { id: string; revision: number; status: string; question: string }[];
      return out(r, reqs.length ? reqs.map((q) => `${q.id}@${q.revision}  ${q.status.padEnd(15)}  ${q.question}`).join("\n") : "Nothing is open.");
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
    case "review": {
      const { project } = projectFor();
      readConfig();
      return runReview(project, { input: process.stdin, output: process.stdout, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    }
    case "answer": {
      const { project } = projectFor();
      const args: Record<string, unknown> = { id: need(rest[0], "a request id"), channel: "cli" };
      if (flags.file) Object.assign(args, readJson(flags.file, "answer"), { id: args.id, channel: "cli" });
      if (flags.option) args.value = flags.option;
      if (flags["from-chat"]) {
        args.channel = "conversation";
        args.quote = readFileSync(need(flags["quote-file"], "--quote-file with the person's words"), "utf8").trim();
      }
      if (flags.addressed) args.addressed = true;
      if (flags.withdraw) args.withdraw = true;
      if (flags["hide-until"]) args.hide_until = flags["hide-until"];
      if (flags.disposition) args.disposition = flags.disposition;
      return out(await call("answer", args, { project, opId }));
    }
    case "wait": {
      const { project, root } = projectFor();
      const id = need(rest[0], "a request id");
      const timeoutS = flags.timeout ? Number(flags.timeout) : 0;
      if (!Number.isFinite(timeoutS) || timeoutS < 0) throw new CliError(EXIT.OTHER, "--timeout takes a number of seconds");
      const shown = await call("show", { id }, { project });
      if (shown.code !== EXIT.OK) return out(shown);
      const files = (shown.request as { basis_files: string[] }).basis_files;
      const deadline = Date.now() + timeoutS * 1000;
      for (;;) {
        const remaining = Math.max(0, deadline - Date.now());
        const r = await call("wait", { id, timeout_s: Math.ceil(remaining / 1000), basis: fingerprints(root, files) },
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
