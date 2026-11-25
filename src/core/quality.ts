import type { RequestBody } from "./types.js";
import { redactText } from "./redact.js";

export const QUALITY_RULES = [
  "H01-definition", "H02-status", "H03-evidence", "H04-focus", "H05-recommendation", "H06-scope", "H07-review-target",
] as const;
export type QualityRule = typeof QUALITY_RULES[number];

export interface QualityWarning {
  rule: QualityRule;
  message: string;
}

export interface SharedContext {
  glossary?: Record<string, string>;
  evidence?: { claim: string; kind: string; source: string; date: string }[];
}

/** Old revisions may predate waivers. Keep their stored body intact when rendering. */
export function waiverNotes(body: RequestBody, shared?: SharedContext): string[] {
  if (!Array.isArray(body.waivers) || !body.waivers.length) return [];
  const warnings = qualityWarnings(body, shared);
  return body.waivers.flatMap(w => {
    if (!hasText(w?.rule) || !hasText(w.reason)) return [];
    const issue = warnings.find(issue => issue.rule === w.rule);
    return [`Waived ${w.rule}.${issue ? " " + issue.message : ""} Reason: ${w.reason}`];
  });
}

const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const dated = (date: unknown): boolean => hasText(date) && Number.isFinite(Date.parse(date));

export function hasDatedEvidence(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const row = item as Record<string, unknown>;
  return hasText(row.claim) && hasText(row.source) && dated(row.date);
}

/** Scan the prose a reviewer reads, preserving field boundaries. Commands, IDs, and encoded images are data. */
function reviewText(b: RequestBody): string[] {
  const text = [b.question, b.summary, b.why_now, ...(b.kind === "judge" ? [] : [b.notes]), b.default?.consequence, b.narrowing_reason,
    b.recommendation?.because, b.recommendation?.preserves, b.recommendation?.bolder_alternative];
  for (const o of b.options ?? []) {
    text.push(o.label, o.consequence, o.agent_next, o.authorization?.action, o.authorization?.target, o.authorization?.scope,
      o.authorization?.expected_effect);
  }
  for (const s of b.steps ?? []) text.push(s.why_person, s.expected_result, s.agent_next);
  for (const g of b.goals ?? []) text.push(g.goal, ...g.evidence.map(e => e.claim));
  for (const a of b.assumptions ?? []) text.push(a.statement, a.consequence);
  for (const e of b.evidence ?? []) text.push(e.claim);
  for (const p of b.previews ?? []) text.push(p.label);
  return text.filter(hasText);
}

const opaque = /\b(?:[A-Z]{2,}(?:[-_][A-Z0-9]+)*|[A-Z]{1,8}[-_]\d+(?:[-_][A-Z0-9]+)*|[a-z]{2,}(?:_[a-z0-9]+)+)\b/g;

function undefinedTerms(text: string[], glossary: Record<string, string> = {}): string[] {
  const words = new Set(text.flatMap(line => redactText(line, []).match(opaque) ?? []));
  const defined = Object.keys(glossary).map(term => term.trim().toLowerCase());
  const missing: string[] = [];
  for (const term of words) {
    if (defined.includes(term.toLowerCase())) continue;
    // Recognize “expanded term (ET)”, “ET (expanded term)” and “ET means ...” as inline definitions.
    const longForm = new RegExp("\\b" + term + "\\s*(?:\\([^()\\n]{3,100}\\)|(?:means|stands for)\\s+\\S+)");
    const before = new RegExp("([A-Za-z][A-Za-z -]{2,120})\\s*\\(" + term + "\\)");
    if (text.some(line => {
      if (longForm.test(line)) return true;
      const expansion = before.exec(line)?.[1];
      if (!expansion) return false;
      const initials = expansion.trim().split(/[\s-]+/).map(word => word[0]!.toUpperCase()).join("");
      return initials.endsWith(term);
    })) continue;
    missing.push(term);
  }
  return missing;
}

export function qualityWarnings(body: RequestBody, shared?: SharedContext): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const warn = (rule: QualityRule, message: string) => warnings.push({ rule, message });
  const text = reviewText(body);
  const combinedGlossary = { ...(shared?.glossary ?? {}), ...(body.glossary ?? {}) };
  const missing = undefinedTerms(text, combinedGlossary);
  if (missing.length) warn("H01-definition", "Define or replace these terms on the card: " + missing.join(", ") + ".");
  const evidence = body.evidence ?? [];
  const sharedEvidence = shared?.evidence ?? [];
  const claims = [body.summary, body.why_now, body.notes, body.recommendation?.because,
    ...(body.kind === "notice" ? [body.question] : [])].filter(hasText);
  const supported = evidence.some(hasDatedEvidence) || sharedEvidence.some(hasDatedEvidence)
    || body.goals?.some(g => g.evidence.some(hasDatedEvidence));
  if (!supported && claims.some(s => /\b(?:is|are|was|were|now|already|marked|reported)\s+(?:all\s+)?(?:done|complete[d]?|fixed|ready|blocked|a no-op)\b|^(?:done|fixed|ready|blocked|no-op)[.!:\s]*$/i.test(s))) {
    warn("H02-status", "Map the status claim to a goal and its outcome, or add dated evidence of the result.");
  }
  const stateClaim = body.recommendation?.because && /\b(?:currently|as of today|we (?:observed|measured|tested)|the (?:check|test|probe) (?:shows|found|passed|failed))\b/i.test(body.recommendation.because);
  const allEvidence = [...evidence, ...(body.goals ?? []).flatMap(g => g.evidence)];
  if (allEvidence.some(e => !hasDatedEvidence(e) || !["observed", "inferred"].includes(e.kind)) || (stateClaim && !supported)) {
    warn("H03-evidence", "Give the claim, source and date, and mark the evidence as observed or inferred.");
  }
  const question = body.question.trim();
  const budget = text.join(" ").split(/\s+/).length;
  if (question.length > 180 || /\?\s*\S|[.!]\s+[A-Z]/.test(question) || budget > 220) {
    warn("H04-focus", "Put one short decision first. Move background detail to a reference and keep the card within 220 words.");
  }
  const rec = body.recommendation;
  if (rec && (!hasText(rec.because) || !hasText(rec.preserves) || !hasText(rec.bolder_alternative))) {
    warn("H05-recommendation", "Explain the recommendation, what it preserves, and a bolder alternative.");
  }
  const effects = (body.options ?? []).flatMap(o => [o.consequence, o.agent_next, o.authorization?.scope]).filter(hasText);
  if (body.default) effects.push(body.default.consequence);
  if (effects.some(s => /\b(?:as (?:needed|appropriate)|whatever (?:is|seems) necessary|do the rest|handle it|everything necessary|the usual (?:changes|scope))\b/i.test(s))
    || (/\b(?:review|audit|check)\b/i.test(question) && effects.some(s => /\b(?:until satisfied|as many (?:rounds|passes) as|unlimited (?:rounds|passes))\b/i.test(s)))) {
    warn("H06-scope", "Name the affected work and a concrete limit, cost or observable consequence.");
  }
  if (/\b(?:score|rate|judge|compare)\b.*\b(?:example|sample|preview|clip|recording|image|design|draft)s?\b/i.test(question)
    && !body.previews?.length && !body.blind?.candidates?.length && !supported && !text.some(s => /https?:\/\/\S+|\[[^\]]+\]\([^)]+\)/.test(s))) {
    warn("H07-review-target", "Include the example to judge, a preview, or a reference to the evidence.");
  }
  return warnings;
}
