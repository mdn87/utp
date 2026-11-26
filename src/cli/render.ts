// Markdown for people: request cards, reviews, and short result summaries.

import type { BlindReveal } from "../core/blind.js";
import type { AcceptanceGoal, Actor, AnswerRecord, ClarificationRequest, DefaultNotice, Grant, OpResult, RequestBody, ReviewIntent } from "../core/types.js";
import type { RevisionDiff } from "../core/diff.js";
import { earlierCard, previousDecision, type FollowUpSource } from "../core/review-history.js";
import { itemPrompts } from "../core/items.js";
import { validTaskTitle } from "../core/check.js";
import { waiverNotes, type SharedContext } from "../core/quality.js";

export interface RequestView {
  id: string;
  revision: number;
  current: boolean;
  status: string;
  body: RequestBody;
  answer: AnswerRecord | null;
  clarification?: ClarificationRequest;
  blind_reveal?: BlindReveal;
  flags: string[];
  review_id?: string;
  asked_at?: string;
  owner?: Actor;
  revision_diff?: RevisionDiff;
  applied_evidence?: { action: string; target: string; scope: string; effect: string };
  policy?: unknown;
}

export interface ReviewView {
  id: string;
  follow_up?: FollowUpSource;
  items: RequestView[];
  intent?: ReviewIntent;
  default_notices?: DefaultNotice[];
  resolved_dependencies?: Record<string, string>;
  owner?: Actor;
}

const UNDO: Record<string, string> = { easy: "easy to undo", costly: "costly to undo", one_way: "can't be undone" };
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function sharedFromIntent(intent?: ReviewIntent): SharedContext | undefined {
  if (!intent || (!intent.shared_glossary && !intent.shared_evidence)) return undefined;
  return { glossary: intent.shared_glossary, evidence: intent.shared_evidence };
}

export function reviewContext(intent?: ReviewIntent): [string, string][] {
  if (!intent) return [["Review context", "This review was saved without a stated purpose or scope."]];
  const fields: [string, string][] = [["What you asked for", intent.asked]];
  if (intent.already_done?.trim()) fields.push(["Already done", intent.already_done]);
  fields.push(["What the agent is doing", intent.doing]);
  if (validTaskTitle(intent.task_title)) fields.unshift(["Task", intent.task_title]);
  const scope = intent.scope_delta;
  const changes: [string, string][] = [];
  if (scope !== "none") {
    for (const [kind, label] of [["narrowed", "Narrowed scope"], ["deferred", "Deferred work"], ["added", "Added work"]] as const) {
      for (const change of scope[kind]) changes.push([label, `${change.item} — ${change.reason}`]);
    }
  }
  const out = fields.concat(changes.length ? changes : [["Scope changes", "None."]]);
  if (intent.shared_evidence?.length) {
    out.push(["Shared evidence", intent.shared_evidence.map((e) => `${e.claim} (${e.kind}, ${e.source}, ${e.date})`).join("\n")]);
  }
  if (intent.shared_glossary && Object.keys(intent.shared_glossary).length) {
    out.push(["Shared terms", Object.entries(intent.shared_glossary).map(([t, d]) => `${t}: ${d}`).join("\n")]);
  }
  return out;
}

export function contextMarkdown(intent?: ReviewIntent): string {
  return reviewContext(intent).map(([label, value]) => `**${label}**\n\n${value}`).join("\n\n");
}

export function cardMetadata(v: RequestView): string {
  const b = v.body;
  const label = typeof b.id === "string" && b.id !== v.id ? b.id + " · " : "";
  return `${label}${b.kind} · level ${b.level}: ${b.level_reason} · ${UNDO[b.stakes.reversibility] ?? b.stakes.reversibility}`;
}

export function dependencyLabels(body: RequestBody, items: readonly RequestView[] = [], resolved?: Record<string, string>): string[] {
  return (body.depends_on ?? []).map(ref => {
    const exact = items.find(item => `${item.id}@${item.revision}` === ref || (item.id === ref && item.current));
    const drafts = exact ? [] : items.filter(item => item.body.id === ref);
    const target = exact ?? (drafts.length === 1 ? drafts[0] : undefined);
    if (!target) return resolved?.[ref] ?? ref;
    const revision = `${target.id}@${target.revision}`;
    return `${exact ? revision : `${ref} (${revision})`} · ${target.body.question}`;
  });
}

export const letter = (n: number): string =>
  n < 26 ? String.fromCharCode(65 + n) : letter(Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26));

function goalLines(goals: AcceptanceGoal[]): string[] {
  return goals.flatMap(goal => [
    `**${goal.id}** · ${goal.goal} · ${goal.coverage?.replaceAll("_", " ") ?? ""}`, "",
    ...(goal.evidence ?? []).map(e => `- ${e.claim} (${e.kind}, ${e.source}, ${e.date})`), "",
  ]);
}

export function completionMarkdown(goals: AcceptanceGoal[], notices: RequestView[] | null): string {
  const lines = ["## Completion report", "", ...goalLines(goals), "### Queued notices", ""];
  if (notices === null) lines.push("UTP could not check queued notices. Run `utp status` when the project service is available.");
  else if (!notices.length) lines.push("No notices are queued.");
  else lines.push(...notices.map(n => cardMarkdown(n)));
  return lines.join("\n").trimEnd();
}

export function revisionBannerLines(diff: RevisionDiff): string[] {
  const lines = [`**Updated from rev ${diff.from_revision} -> rev ${diff.to_revision}**`];
  if (diff.trigger.kind === "clarification") {
    lines.push(diff.trigger.note
      ? `- Triggered by your clarification on rev ${diff.from_revision}: "${diff.trigger.note}"`
      : `- Triggered by a clarification request on rev ${diff.from_revision}.`);
  } else if (diff.trigger.kind === "stale") {
    const files = diff.trigger.files?.length ? diff.trigger.files.join(", ") : "tracked basis files";
    lines.push(`- Rev ${diff.from_revision} went stale because ${files} changed.`);
  } else if (diff.trigger.kind === "custom_answer") {
    lines.push(`- Revised after your reply on rev ${diff.from_revision}: "${diff.trigger.custom ?? ""}"`);
  }
  if (diff.prior_answer) {
    lines.push(`- On rev ${diff.from_revision} you chose: ${diff.prior_answer} (not pre-selected — confirm or change below).`);
  }
  for (const change of diff.changes) lines.push(`- ${change}`);
  if (diff.unchanged.length) lines.push(`- Unchanged: ${diff.unchanged.join(", ")}.`);
  return lines;
}

export function cardMarkdown(v: RequestView, mark?: string, review?: ReviewView): string {
  const b = v.body;
  const out: string[] = [`### ${mark ? `${mark}. ` : ""}${b.question}`, ""];
  const prior = earlierCard(review?.follow_up, b);
  if (prior) out.push("**Earlier decision**", ...(prior.question === b.question ? [] : [prior.question]), previousDecision(prior), "");
  if (v.revision_diff) out.push(...revisionBannerLines(v.revision_diff), "");
  if (!v.current) out.push("A later revision replaced this card.", "");
  else if (v.status === "cancelled") out.push("This card was cancelled.", "");
  if (b.kind !== "notice") out.push("**What this question addresses**");
  out.push(b.summary ?? b.why_now, "");
  if (b.summary && b.summary !== b.why_now) out.push("**Why now**", b.why_now, "");
  if (v.clarification) out.push(v.clarification.outcome === "unsure" ? "Confirm the current choice before the agent continues."
    : "The reviewer asked for a clearer question or choices.", "");
  for (const dependency of dependencyLabels(b, review?.items, review?.resolved_dependencies)) out.push(`Depends on ${dependency}`, "");
  const terms = Object.entries(b.glossary ?? {});
  if (terms.length) out.push("Terms on this card:", "", ...terms.map(([t, d]) => `- **${t}**: ${d}`), "");
  for (const preview of Array.isArray(b.previews) ? b.previews : []) {
    const reviewId = review?.id ?? v.review_id;
    out.push(`**${preview.label}**`, "");
    if ("text" in preview) out.push(preview.text.split(/\r?\n/).map(line => "    " + line).join("\n"), "");
    else if (b.kind === "judge") {
      out.push(reviewId ? `Open this blind preview on the review page with \`utp page ${reviewId}\`.`
        : "View this preview on the review page.", "");
    } else out.push(reviewId ? `Open the image on the review page with \`utp page ${reviewId}\`.`
      : `The image data is in \`utp show ${v.id}@${v.revision} --json\`.`, "");
  }
  if (b.options?.length) {
    out.push("| Option | What happens |", "|---|---|");
    for (const o of b.options) {
      const tag = b.recommendation?.option === o.id ? " (recommended)" : "";
      const next = o.agent_next ? ` Agent does next: ${o.agent_next}` : "";
      out.push(`| **${o.id}** ${cell(o.label)}${tag} | ${cell(o.consequence + next)} |`);
    }
    out.push("");
  }
  for (const option of b.options ?? []) {
    const scope = option.authorization;
    if (scope) out.push(`Option **${option.id}** authorizes **${scope.action}** on ${scope.target}. Scope is ${scope.scope}.`
      + (scope.expected_effect ? ` Expected result is ${scope.expected_effect}.` : ""), "");
  }
  for (const step of Array.isArray(b.steps) ? b.steps : []) {
    out.push(`**${step.id}** · ${step.actor} on ${step.machine} using ${step.shell}`, "",
      step.command, "", `Expect ${step.expected_result}. ${step.tested ? "Tested in this shell." : "This step needs a shell check."}`,
      step.why_person, ...(step.agent_next ? [`Agent does next: ${step.agent_next}`] : []), "");
  }
  if (Array.isArray(b.goals)) out.push(...goalLines(b.goals));
  for (const item of Array.isArray(b.assumptions) ? b.assumptions : []) {
    out.push(`**${item.id}** · ${item.statement}. ${item.consequence}`, "");
  }
  const [prompt] = itemPrompts(b);
  if (prompt) {
    out.push(`Answer each item by ID with ${prompt.choices.join(", ")}.`, "");
    if (prompt.detailLabel) out.push(`**${prompt.detailLabel}** — required for ${prompt.detailsFor.join(" or ")}.`, "");
  }
  const rec = b.recommendation;
  if (rec) {
    out.push(`Recommended: **${rec.option}**` + (rec.because ? `, because ${rec.because}` : "")
      + `${rec.preserves ? ` It keeps: ${rec.preserves}` : ""}${rec.bolder_alternative ? ` Bolder: ${rec.bolder_alternative}` : ""}`, "");
  }
  if (b.default) {
    const defLabel = b.options?.find((o) => o.id === b.default?.option)?.label;
    const defName = defLabel ? `${defLabel} (${b.default.option})` : b.default.option;
    out.push(`If you don't answer: **${defName}**. ${b.default.consequence}`, "");
  }
  if (b.notes) out.push(b.notes, "");
  if (b.narrowing_reason) out.push("Why the action cannot be split: " + b.narrowing_reason, "");
  for (const note of waiverNotes(b, sharedFromIntent(review?.intent))) out.push(note, "");
  if (b.evidence?.length) {
    out.push("Evidence:", "", ...b.evidence.map((e) => `- ${e.claim} (${e.kind}, ${e.source}, ${e.date})`), "");
  }
  for (const flag of v.flags) out.push(flag, "");
  out.push(`\`${v.id}@${v.revision}\` · ${cardMetadata(v)}`);
  if (v.answer) out.push("", `Answered: ${answerText(v.answer)}`);
  if (b.kind === "judge" && v.answer) {
    if (v.answer.note) out.push(`Reason given · ${v.answer.note}`);
    if (v.answer.ratings) out.push(`Ratings · Candidate A ${v.answer.ratings.a}/5 and Candidate B ${v.answer.ratings.b}/5`);
    if (v.answer.repeat_test !== undefined) out.push(v.answer.repeat_test ? "The reviewer would run the test again." : "The reviewer declined another test.");
  }
  if (v.blind_reveal) {
    out.push("", `Candidate A was ${v.blind_reveal.identities.a}. Candidate B was ${v.blind_reveal.identities.b}.`);
    if (v.blind_reveal.notes?.a) out.push(`Candidate A · ${v.blind_reveal.notes.a}`);
    if (v.blind_reveal.notes?.b) out.push(`Candidate B · ${v.blind_reveal.notes.b}`);
    if (v.blind_reveal.recommendation) out.push(`The recommendation was Candidate ${v.blind_reveal.recommendation.toUpperCase()}.`);
  }
  return out.join("\n");
}

export function answerValue(a: AnswerRecord, body?: RequestBody): string {
  if (a.authorization) return `${a.authorization.action} ${a.authorization.target} · scope ${a.authorization.scope}`;
  const items = Object.entries(a.items ?? {}).map(([id, value]) =>
    `${id} ${value.replaceAll("_", " ")}${a.details?.[id] ? ` (${a.details[id]})` : ""}`).join(", ");
  if (a.disposition) return a.disposition.replace("_", " ");
  if (typeof a.value === "string") {
    const option = body?.options?.find(o => o.id === a.value);
    return option ? `${option.label} (${option.id})` : a.value;
  }
  return a.custom ? `"${a.custom}"` : items || "item answers";
}

export function answerText(a: AnswerRecord): string {
  return `${answerValue(a)} (through ${a.channel}${a.verified === "none" ? ", unverified" : `, verified by ${a.verified}`})`;
}

export function defaultNoticeMarkdown(notice: DefaultNotice): string {
  const status = notice.conflict ? "Late answer conflicts with the applied default" : "Applied by default: change?";
  const optionName = notice.option_label ? `${notice.option_label} (${notice.option})` : notice.option;
  const undo = notice.undo ? ` Undo: ${notice.undo}` : "";
  return `- **${status}** ${notice.question} Option **${optionName}**.${undo} Request \`${notice.request_id}@${notice.revision}\`.`;
}

export function reviewMarkdown(review: ReviewView, mode: "presentation" | "history" = "presentation"): string {
  const cards = review.items.filter((v) => v.current && v.status !== "cancelled");
  const earlier = mode === "history" ? review.items.filter(v => !v.current || v.status === "cancelled") : [];
  const count = cards.length + earlier.length;
  const out = [`## Review ${review.id}: ${count} card${count === 1 ? "" : "s"}`, ""];
  out.push(contextMarkdown(review.intent), "");
  if (review.default_notices?.length) out.push(...review.default_notices.map(defaultNoticeMarkdown), "");
  if (cards.some(c => c.body.kind !== "notice" && ["queued", "presented", "default_claimed"].includes(c.status))) {
    out.push("Reply with the card letter and your choice, for example \"A: b\". Your own words work too.", "");
  }
  if (cards.some(c => c.body.kind === "judge")) {
    out.push("For a blind comparison, choose a listed option. You can add a short reason.", "");
  }
  cards.forEach((c, i) => out.push(cardMarkdown(c, letter(i), review), ""));
  if (earlier.length) {
    out.push("**Earlier cards in this review**", "");
    for (const card of earlier) out.push(cardMarkdown(card, undefined, review), "");
  }
  return out.join("\n").trimEnd();
}

export function grantText(g: Grant): string {
  return `${g.id} (epoch ${g.epoch}, lease until ${g.lease_until}): ${g.authorization.action} ${g.authorization.target}, scope ${g.authorization.scope}`;
}

/** A short human summary of an operation's result. */
export function resultText(r: OpResult): string {
  const lines: string[] = [];
  if (typeof r.message === "string") lines.push(r.message);
  if (r.clarification) {
    const note = (r.clarification as ClarificationRequest).note;
    if (note) lines.push(`What the reviewer asked the agent to explain · ${note}`);
  }
  const fields: [string, string][] = [
    ["id", "request"], ["revision", "revision"], ["review_id", "review"], ["presentation_id", "presentation"],
    ["status", "status"], ["outcome", "outcome"], ["epoch", "epoch"], ["near_duplicate", "similar open request"],
    ["role", "role"], ["retry_after_s", "retry after (seconds)"],
  ];
  for (const [k, label] of fields) if (r[k] !== undefined && r[k] !== null) lines.push(`${label}: ${String(r[k])}`);
  if (r.answer && typeof r.answer === "object") lines.push(`answer: ${answerText(r.answer as AnswerRecord)}`);
  if (r.grant && typeof r.grant === "object") lines.push(`grant: ${grantText(r.grant as Grant)}`);
  if (typeof r.grant === "string") lines.push(`grant: ${r.grant}`);
  if (Array.isArray(r.changed) && r.changed.length) lines.push(`changed: ${r.changed.join(", ")}`);
  if (Array.isArray(r.mismatch) && r.mismatch.length) lines.push(`differs from authorization: ${r.mismatch.join(", ")}`);
  if (Array.isArray(r.failures)) {
    for (const f of r.failures as { rule: string; message: string; waivable?: boolean }[]) {
      lines.push(`${f.rule}: ${f.message}${f.waivable ? " You can waive this warning with a reason." : ""}`);
    }
  }
  return lines.join("\n");
}
