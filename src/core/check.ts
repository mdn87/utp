// Structural checks for a request (the part of `utp check` that phase 1a
// needs). Heuristic rules, such as definitions-or-waiver, arrive in phase 1b.

import { KINDS, type RequestBody } from "./types.js";

export interface CheckFailure {
  rule: string;
  message: string;
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

export function checkRequest(body: unknown): CheckFailure[] {
  const out: CheckFailure[] = [];
  const fail = (rule: string, message: string) => out.push({ rule, message });
  if (typeof body !== "object" || body === null) {
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
  if (needsOptions && options.length < 2) fail("S07-options", "this kind needs at least two options");
  const ids = new Set<string>();
  for (const [i, o] of options.entries()) {
    if (!nonEmpty(o?.id) || !itemId.test(o.id)) fail("S08-option-id", `option ${i + 1} needs an id of letters, digits, - or _`);
    else if (ids.has(o.id)) fail("S08-option-id", `option id ${o.id} is used twice`);
    else ids.add(o.id);
    if (!nonEmpty(o?.label)) fail("S09-option-label", `option ${o?.id ?? i + 1} needs a label`);
    if (!nonEmpty(o?.consequence)) fail("S10-consequence", `option ${o?.id ?? i + 1} needs a consequence line: what happens if it's chosen`);
    const a = o?.authorization;
    if (a !== undefined && !(nonEmpty(a.action) && nonEmpty(a.target) && nonEmpty(a.scope))) {
      fail("S11-authorization", `option ${o?.id ?? i + 1}'s authorization needs action, target and scope`);
    }
  }
  if (b.kind === "approve" && !options.some((o) => o?.authorization)) {
    fail("S12-approve-authorization", "an approve request needs at least one option with an authorization");
  }
  if (b.recommendation !== undefined) {
    if (!ids.has(b.recommendation.option)) fail("S13-recommendation", "recommendation.option must name an option");
    if (!nonEmpty(b.recommendation.because)) fail("S13-recommendation", "recommendation.because is required");
  }
  if (b.default !== undefined) {
    if (!ids.has(b.default.option)) fail("S14-default", "default.option must name an option");
    if (!nonEmpty(b.default.consequence)) fail("S14-default", "the default needs its own consequence line");
    if (b.level === 3) fail("S15-default-level", "a level-3 request can't carry a default: it always waits for the person");
  }
  if (b.basis?.files !== undefined && !(Array.isArray(b.basis.files) && b.basis.files.every(nonEmpty))) {
    fail("S16-basis", "basis.files must be a list of paths");
  }
  if (b.kind === "handoff") {
    const steps = checkedItems(b.steps, "steps", "S17-handoff", ["actor", "machine", "shell", "command", "expected_result", "why_person"], fail);
    for (const step of steps) if (typeof step.tested !== "boolean") fail("S17-handoff", "each step needs a tested true or false value");
  }
  if (b.kind === "accept") {
    const goals = checkedItems(b.goals, "goals", "S18-accept", ["goal"], fail);
    for (const goal of goals) {
      if (!["covered", "partly_covered", "not_covered"].includes(goal.coverage as string)) {
        fail("S18-accept", "each goal needs an explicit coverage result");
      }
      if (!Array.isArray(goal.evidence) || !goal.evidence.length
          || !goal.evidence.every((item) => item && nonEmpty(item.claim) && nonEmpty(item.kind) && nonEmpty(item.source)
            && nonEmpty(item.date) && Number.isFinite(Date.parse(item.date)))) {
        fail("S18-accept", "each goal needs dated evidence with a claim, kind and source");
      }
    }
  }
  if (b.kind === "assumptions") {
    checkedItems(b.assumptions, "assumptions", "S19-assumptions", ["statement", "consequence"], fail);
  }
  if (b.previews !== undefined && (!Array.isArray(b.previews) || b.previews.some((preview) =>
    !preview || !nonEmpty(preview.label)
    || ("text" in preview ? !nonEmpty(preview.text)
      : !["image/png", "image/jpeg", "image/webp"].includes(preview.media_type)
        || typeof preview.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.data))))) {
    fail("S20-preview", "previews need a label and plain text or a base64 PNG, JPEG or WebP image");
  }
  return out;
}
