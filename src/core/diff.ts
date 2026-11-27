// Automatic revision-to-revision diff summaries (rev N-1 -> rev N).
// Computes why a revision exists, what changed in options/scopes/evidence,
// and what the reviewer picked previously as read-only context (never pre-selected).

import type { AnswerRecord, Authorization, ClarificationRequest, OptionSpec, RequestBody } from "./types.js";

export interface RevisionTrigger {
  kind: "clarification" | "stale" | "custom_answer" | "revised";
  note?: string;
  outcome?: "unsure" | "needs_clarification";
  files?: string[];
  custom?: string;
}

export interface RevisionDiff {
  from_revision: number;
  to_revision: number;
  trigger: RevisionTrigger;
  prior_answer?: string;
  changes: string[];
  unchanged: string[];
}

export interface RevisionSnapshot {
  revision: number;
  status: string;
  body: RequestBody;
  answer?: AnswerRecord;
  clarification?: ClarificationRequest;
  stale_changed?: string[];
}

const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

function authText(a?: Authorization): string {
  if (!a) return "none";
  return `${a.action} on ${a.target} (scope: ${a.scope}${a.expected_effect ? `; result: ${a.expected_effect}` : ""})`;
}

function sameAuth(a?: Authorization, b?: Authorization): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return norm(a.action) === norm(b.action) && norm(a.target) === norm(b.target)
    && norm(a.scope) === norm(b.scope) && norm(a.expected_effect) === norm(b.expected_effect);
}

function summarizeAnswer(answer: AnswerRecord, body: RequestBody): string {
  if (answer.authorization) {
    return `${answer.authorization.action} ${answer.authorization.target} (scope: ${answer.authorization.scope})`;
  }
  if (answer.disposition) return answer.disposition.replaceAll("_", " ");
  if (typeof answer.value === "string") {
    const opt = body.options?.find((o) => o.id === answer.value);
    return opt ? `${opt.label} (${opt.id})` : answer.value;
  }
  if (answer.custom) return `"${answer.custom}"`;
  const items = Object.entries(answer.items ?? {}).map(([id, val]) => `${id}: ${val.replaceAll("_", " ")}`);
  return items.join(", ") || "recorded answer";
}

function diffOptions(prev: OptionSpec[], next: OptionSpec[], changes: string[]): boolean {
  const prevMap = new Map(prev.map((o) => [o.id, o]));
  const nextMap = new Map(next.map((o) => [o.id, o]));
  let anyOptionChange = false;
  for (const o of next) {
    const old = prevMap.get(o.id);
    if (!old) {
      anyOptionChange = true;
      changes.push(`Added option ${o.label} (${o.id})${o.authorization ? ` — authorizes ${authText(o.authorization)}` : ""}.`);
      continue;
    }
    const labelChanged = norm(old.label) !== norm(o.label);
    const consChanged = norm(old.consequence) !== norm(o.consequence);
    const authChanged = !sameAuth(old.authorization, o.authorization);
    const nextChanged = norm(old.agent_next) !== norm(o.agent_next);
    if (authChanged) {
      anyOptionChange = true;
      changes.push(`Option ${o.id} authorization changed: ${authText(old.authorization)} -> ${authText(o.authorization)}.`);
    }
    if (labelChanged) {
      anyOptionChange = true;
      changes.push(`Option ${o.id} renamed: "${old.label}" -> "${o.label}".`);
    }
    if (consChanged) {
      anyOptionChange = true;
      changes.push(`Option ${o.id} consequence updated: ${o.consequence}`);
    }
    if (nextChanged && o.agent_next) {
      anyOptionChange = true;
      changes.push(`Option ${o.id} agent next step updated: ${o.agent_next}`);
    }
  }
  for (const old of prev) {
    if (!nextMap.has(old.id)) {
      anyOptionChange = true;
      changes.push(`Removed option ${old.label} (${old.id}).`);
    }
  }
  return anyOptionChange;
}

export function computeRevisionDiff(previous: RevisionSnapshot, current: RevisionSnapshot): RevisionDiff {
  let trigger: RevisionTrigger;
  if (previous.clarification) {
    trigger = {
      kind: "clarification",
      ...(previous.clarification.note ? { note: previous.clarification.note } : {}),
      ...(previous.clarification.outcome ? { outcome: previous.clarification.outcome } : {}),
    };
  } else if (previous.status === "stale" || (previous.stale_changed && previous.stale_changed.length > 0)) {
    trigger = { kind: "stale", files: previous.stale_changed ?? [] };
  } else if (previous.answer?.custom) {
    trigger = { kind: "custom_answer", custom: previous.answer.custom };
  } else {
    trigger = { kind: "revised" };
  }

  const changes: string[] = [];
  const unchanged: string[] = [];

  if (norm(previous.body.question) !== norm(current.body.question)) {
    changes.push(`Question updated from "${previous.body.question}".`);
  } else {
    unchanged.push("question");
  }

  if (norm(previous.body.summary) !== norm(current.body.summary) && current.body.summary) {
    changes.push(`Summary updated: ${current.body.summary}`);
  }

  if (current.body.revisit && previous.body.revisit) {
    if (norm(previous.body.revisit.original_basis) !== norm(current.body.revisit.original_basis)) {
      changes.push(`What the earlier decision rested on was updated: ${current.body.revisit.original_basis}`);
    }
    if (norm(previous.body.revisit.change) !== norm(current.body.revisit.change)) {
      changes.push(`What changed was updated: ${current.body.revisit.change}`);
    }
  }

  const prevOpts = previous.body.options ?? [];
  const nextOpts = current.body.options ?? [];
  if (prevOpts.length || nextOpts.length) {
    const changed = diffOptions(prevOpts, nextOpts, changes);
    if (!changed) unchanged.push("options and scopes");
  }

  const prevEv = new Set((previous.body.evidence ?? []).map((e) => norm(e.claim)));
  const addedEv = (current.body.evidence ?? []).filter((e) => !prevEv.has(norm(e.claim)));
  if (addedEv.length) {
    for (const e of addedEv) changes.push(`Evidence added: ${e.claim} (${e.source}, ${e.date}).`);
  } else if ((current.body.evidence ?? []).length === (previous.body.evidence ?? []).length && (current.body.evidence ?? []).length > 0) {
    unchanged.push("evidence");
  }

  if (previous.body.recommendation?.option !== current.body.recommendation?.option) {
    if (current.body.recommendation) {
      changes.push(`Recommendation changed to option ${current.body.recommendation.option}.`);
    } else if (previous.body.recommendation) {
      changes.push("Recommendation removed.");
    }
  } else if (current.body.recommendation) {
    unchanged.push("recommendation");
  }

  if (previous.body.default?.option !== current.body.default?.option
      || norm(previous.body.default?.consequence) !== norm(current.body.default?.consequence)) {
    if (current.body.default) {
      changes.push(`Default updated to option ${current.body.default.option}: ${current.body.default.consequence}`);
    } else if (previous.body.default) {
      changes.push("Default removed.");
    }
  }

  if (!changes.length) {
    changes.push("Refreshed revision details without changing option scopes.");
  }

  return {
    from_revision: previous.revision,
    to_revision: current.revision,
    trigger,
    ...(previous.answer ? { prior_answer: summarizeAnswer(previous.answer, previous.body) } : {}),
    changes,
    unchanged,
  };
}
