// Queuing and revising use the same checks as the standalone command.

import { createHash } from "node:crypto";
import { KINDS, type RequestBody, type ReviewIntent } from "./types.js";
import { hasDatedEvidence, QUALITY_RULES, qualityWarnings, type SharedContext } from "./quality.js";

export interface CheckFailure {
  rule: string;
  message: string;
  waivable: boolean;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const itemId = /^[A-Za-z0-9_-]+$/;

function checkedItems(raw: unknown, field: string, rule: string, textFields: string[],
  fail: (rule: string, message: string) => void): Record<string, unknown>[] {
  if (!Array.isArray(raw) || !raw.length) {
    fail(rule, `add at least one item to ${field}`);
    return [];
  }
  const ids = new Set<string>();
  const items = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(rule, `${field} item ${index + 1} must be an object`);
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (!nonEmpty(item.id) || !itemId.test(item.id) || ids.has(item.id)) {
      fail(rule, `${field} item ${index + 1} needs a unique id with letters, digits, - or _`);
    } else ids.add(item.id);
    const missing = textFields.filter((key) => !nonEmpty(item[key]));
    if (missing.length) fail(rule, `${field} item ${index + 1} needs ${missing.join(", ")}`);
    items.push(item);
  }
  return items;
}

export function checkGoals(raw: unknown, rule = "completion-goals"): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const fail = (id: string, message: string) => failures.push({ rule: id, message, waivable: false });
  for (const goal of checkedItems(raw, "goals", rule, ["goal"], fail)) {
    if (!["covered", "partly_covered", "not_covered"].includes(goal.coverage as string)) {
      fail(rule, "each goal needs an explicit coverage result");
    }
    if (!Array.isArray(goal.evidence) || !goal.evidence.length
        || !goal.evidence.every((item) => hasDatedEvidence(item) && nonEmpty(item.kind))) {
      fail(rule, "each goal needs dated evidence with a claim, kind and source");
    }
  }
  return failures;
}

export function checkRequest(body: unknown, shared?: SharedContext): CheckFailure[] {
  const out: CheckFailure[] = [];
  const fail = (rule: string, message: string) => out.push({ rule, message, waivable: false });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail("S00-shape", "the request must be a JSON object");
    return out;
  }
  const b = body as Partial<RequestBody>;
  if (!KINDS.includes(b.kind as never)) fail("S01-kind", `kind must be one of: ${KINDS.join(", ")}`);
  if (!nonEmpty(b.question)) fail("S02-question", "question is required");
  if (b.summary !== undefined && !nonEmpty(b.summary)) {
    fail("S21-summary", "summary must explain in plain language what this question addresses");
  }
  if (!nonEmpty(b.why_now)) fail("S03-why-now", "why_now is required: say why this is being asked now");
  if (![0, 1, 2, 3].includes(b.level as number)) fail("S04-level", "level must be 0, 1, 2 or 3");
  if (!nonEmpty(b.level_reason)) fail("S05-level-reason", "level_reason is required");
  if (!["easy", "costly", "one_way"].includes(b.stakes?.reversibility as string)) {
    fail("S06-stakes", "stakes.reversibility must be easy, costly or one_way");
  }
  const needsOptions = ["choose", "approve", "clarify"].includes(b.kind as string);
  const options = Array.isArray(b.options) ? b.options : [];
  if (b.options !== undefined && !Array.isArray(b.options)) fail("S07-options", "Supply options as a list.");
  if (needsOptions && options.length < 2) fail("S07-options", "this kind needs at least two options");
  const ids = new Set<string>();
  for (const [i, o] of options.entries()) {
    if (!nonEmpty(o?.id) || !itemId.test(o.id)) fail("S08-option-id", `option ${i + 1} needs an id of letters, digits, - or _`);
    else if (ids.has(o.id)) fail("S08-option-id", `option id ${o.id} is used twice`);
    else ids.add(o.id);
    if (!nonEmpty(o?.label)) fail("S09-option-label", `option ${o?.id ?? i + 1} needs a label`);
    if (!nonEmpty(o?.consequence)) fail("S10-consequence", `option ${o?.id ?? i + 1} needs a consequence line: what happens if it's chosen`);
    const a = o?.authorization;
    if (a !== undefined && !(nonEmpty(a?.action) && nonEmpty(a?.target) && nonEmpty(a?.scope))) {
      fail("S11-authorization", `option ${o?.id ?? i + 1}'s authorization needs action, target and scope`);
    }
  }
  if (b.kind === "approve" && !options.some((o) => o?.authorization)) {
    fail("S12-approve-authorization", "an approve request needs at least one option with an authorization");
  }
  if (b.recommendation !== undefined) {
    if (!b.recommendation || !ids.has(b.recommendation.option)) fail("S13-recommendation", "recommendation.option must name an option");
  }
  if (b.default !== undefined) {
    if (!b.default || !ids.has(b.default.option)) fail("S14-default", "default.option must name an option");
    if (!nonEmpty(b.default?.consequence)) fail("S14-default", "the default needs its own consequence line");
    if (b.level === 3) fail("S15-default-level", "a level-3 request can't carry a default: it always waits for the person");
  }
  if (b.basis?.files !== undefined && !(Array.isArray(b.basis.files) && b.basis.files.every(nonEmpty))) {
    fail("S16-basis", "basis.files must be a list of paths");
  }
  if (b.kind === "handoff" || b.steps !== undefined) {
    const steps = checkedItems(b.steps, "steps", "S17-handoff", ["actor", "machine", "shell", "command", "expected_result", "why_person"], fail);
    for (const step of steps) if (typeof step.tested !== "boolean") fail("S17-handoff", "each step needs a tested true or false value");
  }
  if (b.kind === "accept" || b.goals !== undefined) {
    out.push(...checkGoals(b.goals, "S18-accept"));
  }
  if (b.kind === "assumptions" || b.assumptions !== undefined) {
    checkedItems(b.assumptions, "assumptions", "S19-assumptions", ["statement", "consequence"], fail);
  }
  if (b.previews !== undefined && (!Array.isArray(b.previews) || b.previews.some((preview) =>
    !preview || !nonEmpty(preview.label)
    || ("text" in preview ? !nonEmpty(preview.text)
      : !["image/png", "image/jpeg", "image/webp"].includes(preview.media_type)
        || typeof preview.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.data))))) {
    fail("S20-preview", "previews need a label and plain text or a base64 PNG, JPEG or WebP image");
  }
  if (b.kind === "choose" && !["design", "approach", "priority", "process", "naming", "other"].includes(b.category ?? "")) {
    fail("S22-category", "Choose a category: design, approach, priority, process, naming or other.");
  }
  if (b.kind === "clarify" && options.length >= 2 && options.every(o => nonEmpty(o?.label))
      && new Set(options.map(o => o.label.trim().toLowerCase())).size < 2) {
    fail("S27-readings", "State your interpretation and at least one distinct alternative in the option labels.");
  }
  if (b.kind === "approve" && options.some(o => o?.authorization)) {
    const authorized = options.filter(o => o?.authorization);
    const differentScope = (left: typeof authorized[number], right: typeof authorized[number]) =>
      left.authorization!.target !== right.authorization!.target || left.authorization!.scope !== right.authorization!.scope;
    const narrower = authorized.some(o => authorized.some(other => o !== other && differentScope(o, other)
      && (o.narrower_than === other.id || (o.narrower_than === undefined && o.id === "narrow"))));
    if (options.some(o => o?.narrower_than !== undefined && (!o.authorization || !authorized.some(other =>
      other.id === o.narrower_than && other !== o && differentScope(o, other))))) {
      fail("S23-narrower", "narrower_than must name another authorized option with a different scope.");
    } else if (!narrower && !nonEmpty(b.narrowing_reason)) {
      fail("S23-narrower", "Offer a narrower authorized scope, or explain in narrowing_reason why the action cannot be split.");
    }
    if (!Array.isArray(b.evidence) || !b.evidence.some(hasDatedEvidence)) {
      if (!shared?.evidence?.some(hasDatedEvidence)) {
        fail("S24-approval-evidence", "Include dated evidence with a claim and source for the action being approved.");
      }
    }
  }
  if (b.narrowing_reason !== undefined && !nonEmpty(b.narrowing_reason)) {
    fail("S26-fields", "Give a nonempty explanation for an indivisible action.");
  }
  if (b.evidence !== undefined && (!Array.isArray(b.evidence) || b.evidence.some(e => !e || typeof e !== "object" || Array.isArray(e)))) {
    fail("S26-fields", "Supply evidence as a list of evidence objects.");
  }
  if (b.glossary !== undefined && (!b.glossary || typeof b.glossary !== "object" || Array.isArray(b.glossary)
      || Object.entries(b.glossary).some(([term, meaning]) => !nonEmpty(term) || !nonEmpty(meaning)))) {
    fail("S26-fields", "Map each glossary term to a nonempty definition.");
  }
  for (const list of [b.depends_on, b.tags, b.related]) {
    if (list !== undefined && (!Array.isArray(list) || !list.every(nonEmpty))) {
      fail("S26-fields", "Use an array of nonempty identifiers for dependencies, related requests and tags.");
      break;
    }
  }
  const waived = new Set<string>();
  if (b.waivers !== undefined) {
    if (!Array.isArray(b.waivers)) fail("S25-waiver", "Supply waivers as a list of heuristic rule IDs and reasons.");
    else for (const w of b.waivers) {
      if (!w || !QUALITY_RULES.some(rule => rule === w.rule) || !nonEmpty(w.reason) || waived.has(w.rule)) {
        fail("S25-waiver", "Each waiver needs a known heuristic rule ID and a nonempty reason. List a rule only once.");
      } else waived.add(w.rule);
    }
  }
  if (out.length) return out;
  const warnings = qualityWarnings(b as RequestBody, shared);
  for (const rule of waived) {
    if (!warnings.some(w => w.rule === rule)) fail("S25-waiver", "Remove the unused waiver for " + rule + ".");
  }
  for (const warning of warnings) {
    if (!waived.has(warning.rule)) out.push({ ...warning, waivable: true });
  }
  return out;
}

export const intentFailure: CheckFailure = { rule: "S28-intent", waivable: false,
  message: "State what was asked, what you are doing, and the scope changes with reasons (or none). An optional task title must be a single line of 1 to 80 characters." };

export function validTaskTitle(value: unknown): value is string {
  return nonEmpty(value) && value === value.trim() && [...value].length <= 80 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** Match the ordered draft without resending large previews. Object key order is immaterial. */
export function reviewRequestsHash(requests: readonly unknown[]): string {
  const json = JSON.stringify(requests, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  return createHash("sha256").update(json).digest("hex");
}

export function validReviewIntent(value: unknown): value is ReviewIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if (!nonEmpty(intent.asked) || !nonEmpty(intent.doing)) return false;
  if (intent.task_title !== undefined && !validTaskTitle(intent.task_title)) return false;
  if (intent.already_done !== undefined && !nonEmpty(intent.already_done)) return false;
  if (intent.shared_glossary !== undefined) {
    if (!intent.shared_glossary || typeof intent.shared_glossary !== "object" || Array.isArray(intent.shared_glossary)
        || Object.entries(intent.shared_glossary).some(([term, meaning]) => !nonEmpty(term) || !nonEmpty(meaning))) {
      return false;
    }
  }
  if (intent.shared_evidence !== undefined) {
    if (!Array.isArray(intent.shared_evidence)
        || intent.shared_evidence.some((e) => !hasDatedEvidence(e) || !["observed", "inferred"].includes((e as { kind?: string }).kind ?? ""))) {
      return false;
    }
  }
  const scope = intent.scope_delta;
  const changes = ["narrowed", "deferred", "added"] as const;
  return scope === "none" || (!!scope && typeof scope === "object" && !Array.isArray(scope)
    && changes.every(k => {
      const entries = (scope as Record<string, unknown>)[k];
      return Array.isArray(entries) && entries.every(entry => nonEmpty(entry?.item) && nonEmpty(entry?.reason));
    }));
}

const persistedRef = /^R-\d{8}-[0-9a-f]{8}(?:@\d+)?$/;

/** Verify D4 eligibility rules for any card that declares a default. */
export function defaultEligibilityProblem(body: RequestBody): string | undefined {
  const declared = body.default;
  if (!declared) return undefined;
  if (body.level !== 2 || body.stakes.reversibility !== "easy") {
    return "defaults apply only to level-2 easy-to-undo requests";
  }
  if (body.kind !== "choose" && body.kind !== "clarify") {
    return `defaults are not allowed on ${body.kind} requests`;
  }
  if (body.kind === "choose" && !["approach", "priority", "process"].includes(body.category ?? "")) {
    return `design, naming and other choices must wait for the person (category ${String(body.category ?? "unset")})`;
  }
  const eligibility = declared.eligibility;
  if (!eligibility) return undefined;
  if (eligibility.local !== true || eligibility.scope_delta !== "none"
      || !nonEmpty(eligibility.undo) || !nonEmpty(eligibility.authority)) {
    return "default.eligibility needs local: true, scope_delta: \"none\", undo and authority";
  }
  if (eligibility.size !== "small" && (eligibility.size !== "larger-technical"
      || eligibility.panel?.requested_by_person !== true || !nonEmpty(eligibility.panel.finding))) {
    return "larger-technical defaults require panel.requested_by_person: true and panel.finding";
  }
  const option = body.options?.find((o) => o.id === declared.option);
  if (!option?.authorization) {
    return `default option ${declared.option} needs an authorization to be claimed`;
  }
  return undefined;
}

/** The file form of a batch carries its author's intent alongside the request bodies. */
export function checkDocument(input: Record<string, unknown>, opts: { strictDefaults?: boolean } = {}): CheckFailure[] {
  if (!Object.hasOwn(input, "review") || Object.hasOwn(input, "kind")) return checkRequest(input);
  const review = input.review as { intent?: unknown; requests?: unknown[] } | null;
  const problems: CheckFailure[] = validReviewIntent(review?.intent) ? [] : [intentFailure];
  if (!Array.isArray(review?.requests) || !review.requests.length) {
    return [...problems, { rule: "S00-shape", waivable: false, message: "Include at least one request in the review." }];
  }
  const intentObj = validReviewIntent(review?.intent) ? review.intent : undefined;
  const shared: SharedContext | undefined = intentObj && (intentObj.shared_glossary || intentObj.shared_evidence)
    ? { glossary: intentObj.shared_glossary, evidence: intentObj.shared_evidence } : undefined;
  const draftPositions = new Map<string, number>();
  review.requests.forEach((card, index) => {
    for (const issue of checkRequest(card, shared)) problems.push({ ...issue, message: `Request ${index + 1}. ${issue.message}` });
    if (card && typeof card === "object" && !Array.isArray(card)) {
      const body = card as Partial<RequestBody>;
      if (nonEmpty(body.id)) {
        if (draftPositions.has(body.id)) {
          problems.push({ rule: "S30-depends-order", waivable: false,
            message: `Request ${index + 1}. Draft id "${body.id}" is already used by request ${draftPositions.get(body.id)! + 1}.` });
        } else draftPositions.set(body.id, index);
      }
      if (body.default && body.stakes?.reversibility && body.kind && body.level !== undefined) {
        const problem = defaultEligibilityProblem(body as RequestBody);
        if (problem) problems.push({ rule: "S29-default-eligibility", waivable: false, message: `Request ${index + 1}. ${problem}` });
        else if (opts.strictDefaults && !body.default.eligibility) {
          problems.push({ rule: "S29-default-eligibility", waivable: false,
            message: `Request ${index + 1}. Include default.eligibility (local, scope_delta, undo, authority, size) before staging a claimable default.` });
        }
      }
    }
  });
  review.requests.forEach((card, index) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) return;
    const deps = (card as Partial<RequestBody>).depends_on;
    if (!Array.isArray(deps)) return;
    for (const dep of deps) {
      if (!nonEmpty(dep)) continue;
      if (draftPositions.has(dep)) {
        const target = draftPositions.get(dep)!;
        if (target >= index) {
          problems.push({ rule: "S30-depends-order", waivable: false,
            message: `Request ${index + 1}. depends_on "${dep}" must appear earlier in the review (found at request ${target + 1}).` });
        }
      } else if (!persistedRef.test(dep)) {
        problems.push({ rule: "S30-depends-order", waivable: false,
          message: `Request ${index + 1}. depends_on "${dep}" does not match an earlier card in this batch or an existing request ID.` });
      }
    }
  });
  return problems;
}
