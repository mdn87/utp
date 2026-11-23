// Markdown for people: request cards, reviews, and short result summaries.

import type { AnswerRecord, ClarificationRequest, DefaultNotice, Grant, OpResult, RequestBody } from "../core/types.js";
import { waiverNotes } from "../core/quality.js";

export interface RequestView {
  id: string;
  revision: number;
  current: boolean;
  status: string;
  body: RequestBody;
  answer: AnswerRecord | null;
  clarification?: ClarificationRequest;
  flags: string[];
}

export interface ReviewView {
  id: string;
  items: RequestView[];
  default_notices?: DefaultNotice[];
}

const UNDO: Record<string, string> = { easy: "easy to undo", costly: "costly to undo", one_way: "can't be undone" };
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export const letter = (n: number): string =>
  n < 26 ? String.fromCharCode(65 + n) : letter(Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26));

export function cardMarkdown(v: RequestView, mark?: string): string {
  const b = v.body;
  const out: string[] = [`### ${mark ? `${mark}. ` : ""}${b.question}`, ""];
  if (b.kind !== "notice") out.push("**What this question addresses**");
  out.push(b.summary ?? b.why_now, "");
  if (b.summary && b.summary !== b.why_now) out.push("**Why now**", b.why_now, "");
  if (v.clarification) out.push("The reviewer asked for a clearer question or choices.", "");
  if (b.depends_on?.length) out.push(`Your answer to ${b.depends_on.join(" and ")} affects this card.`, "");
  const terms = Object.entries(b.glossary ?? {});
  if (terms.length) out.push("Terms on this card:", "", ...terms.map(([t, d]) => `- **${t}**: ${d}`), "");
  if (b.options?.length) {
    out.push("| Option | What happens |", "|---|---|");
    for (const o of b.options) {
      const tag = b.recommendation?.option === o.id ? " (recommended)" : "";
      out.push(`| **${o.id}** ${cell(o.label)}${tag} | ${cell(o.consequence)} |`);
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
      step.why_person, "");
  }
  for (const goal of Array.isArray(b.goals) ? b.goals : []) {
    out.push(`**${goal.id}** · ${goal.goal} · ${goal.coverage?.replaceAll("_", " ") ?? ""}`, "",
      ...(goal.evidence ?? []).map((e) => `- ${e.claim} (${e.kind}, ${e.source}, ${e.date})`), "");
  }
  for (const item of Array.isArray(b.assumptions) ? b.assumptions : []) {
    out.push(`**${item.id}** · ${item.statement}. ${item.consequence}`, "");
  }
  const rec = b.recommendation;
  if (rec) {
    out.push(`Recommended: **${rec.option}**, because ${rec.because}`
      + `${rec.preserves ? ` It keeps: ${rec.preserves}` : ""}${rec.bolder_alternative ? ` Bolder: ${rec.bolder_alternative}` : ""}`, "");
  }
  if (b.default) out.push(`If you don't answer: **${b.default.option}**. ${b.default.consequence}`, "");
  if (b.notes) out.push(b.notes, "");
  if (b.narrowing_reason) out.push("Why the action cannot be split: " + b.narrowing_reason, "");
  for (const note of waiverNotes(b)) out.push(note, "");
  if (b.evidence?.length) {
    out.push("Evidence:", "", ...b.evidence.map((e) => `- ${e.claim} (${e.kind}, ${e.source}, ${e.date})`), "");
  }
  out.push(`\`${v.id}@${v.revision}\` · ${b.kind} · level ${b.level}: ${b.level_reason} · ${UNDO[b.stakes.reversibility] ?? b.stakes.reversibility}`);
  if (v.answer) out.push("", `Answered: ${answerText(v.answer)}`);
  return out.join("\n");
}

export function answerText(a: AnswerRecord): string {
  const items = Object.entries(a.items ?? {}).map(([id, value]) =>
    `${id} ${value.replaceAll("_", " ")}${a.details?.[id] ? ` (${a.details[id]})` : ""}`).join(", ");
  const what = a.disposition ? a.disposition.replace("_", " ") : a.value ?? (a.custom ? `"${a.custom}"` : items || "item answers");
  return `${what} (through ${a.channel}${a.verified === "none" ? ", unverified" : `, verified by ${a.verified}`})`;
}

export function defaultNoticeMarkdown(notice: DefaultNotice): string {
  const status = notice.conflict ? "Late answer conflicts with the applied default" : "Applied by default: change?";
  return `- **${status}** ${notice.question} Option **${notice.option}**. Request \`${notice.request_id}@${notice.revision}\`.`;
}

export function reviewMarkdown(review: ReviewView): string {
  const cards = review.items.filter((v) => v.current && v.status !== "cancelled");
  const out = [`## Review ${review.id}: ${cards.length} card${cards.length === 1 ? "" : "s"}`, ""];
  if (review.default_notices?.length) out.push(...review.default_notices.map(defaultNoticeMarkdown), "");
  if (cards.some((c) => c.body.kind !== "notice")) {
    out.push("Reply with the card letter and your choice, for example \"A: b\". Your own words work too.", "");
  }
  cards.forEach((c, i) => out.push(cardMarkdown(c, letter(i)), ""));
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
