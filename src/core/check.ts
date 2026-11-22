// Structural checks for a request (the part of `utp check` that phase 1a
// needs). Heuristic rules, such as definitions-or-waiver, arrive in phase 1b.

import { KINDS, type RequestBody } from "./types.js";

export interface CheckFailure {
  rule: string;
  message: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

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
    if (!nonEmpty(o?.id) || !/^[A-Za-z0-9_-]+$/.test(o.id)) fail("S08-option-id", `option ${i + 1} needs an id of letters, digits, - or _`);
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
  return out;
}
