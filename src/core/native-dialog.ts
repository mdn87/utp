// Phase 2 native question dialog projection and answer mapping with strict
// lossless conformance fallbacks (docs/concept/concept.md, docs/concept/verification.md).
//
// Native agent dialogs (Claude Code AskUserQuestion, Codex request_user_input,
// Antigravity ask_question) are lossy projections with strict option/question
// caps and no native revision carrier. A dialog is offered ONLY when every
// required field fits without truncation, labels map unambiguously back to
// stable option IDs, and a pre-selecting dialog is NEVER used for a card with
// a recommendation (including recommended approvals, narrowings, or declines).

import { contextMarkdown, reviewMarkdown, type RequestView, type ReviewView } from "../cli/render.js";
import { EXIT, type OptionSpec, type RequestBody } from "./types.js";

export const DIALOG_PLATFORMS = ["claude", "codex", "antigravity"] as const;
export type DialogPlatform = (typeof DIALOG_PLATFORMS)[number];

export interface DialogSurfaceSpec {
  platform: DialogPlatform;
  tool: string;
  maxQuestions: number;
  minOptions: number;
  maxOptions: number;
  hasDescriptionSlot: boolean;
  maxHeaderLength: number;
  maxLabelLength: number;
  maxDescriptionLength: number;
  maxQuestionLength: number;
  returnsOptionIds: boolean;
  preselectsOption: boolean;
}

export const DIALOG_SURFACES: Readonly<Record<string, DialogSurfaceSpec>> = {
  "claude:AskUserQuestion": {
    platform: "claude",
    tool: "AskUserQuestion",
    maxQuestions: 4,
    minOptions: 2,
    maxOptions: 4,
    hasDescriptionSlot: true,
    maxHeaderLength: 12,
    maxLabelLength: 80,
    maxDescriptionLength: 240,
    maxQuestionLength: 360,
    returnsOptionIds: false,
    preselectsOption: false,
  },
  "codex:request_user_input": {
    platform: "codex",
    tool: "request_user_input",
    maxQuestions: 3,
    minOptions: 2,
    maxOptions: 3,
    hasDescriptionSlot: true,
    maxHeaderLength: 12,
    maxLabelLength: 80,
    maxDescriptionLength: 240,
    maxQuestionLength: 360,
    returnsOptionIds: false,
    preselectsOption: false,
  },
  "codex:request_user_input_async": {
    platform: "codex",
    tool: "request_user_input_async",
    maxQuestions: 3,
    minOptions: 2,
    maxOptions: 3,
    hasDescriptionSlot: true,
    maxHeaderLength: 12,
    maxLabelLength: 80,
    maxDescriptionLength: 240,
    maxQuestionLength: 360,
    returnsOptionIds: false,
    preselectsOption: true,
  },
  "antigravity:ask_question": {
    platform: "antigravity",
    tool: "ask_question",
    maxQuestions: 4,
    minOptions: 2,
    maxOptions: 6,
    hasDescriptionSlot: false,
    maxHeaderLength: 0,
    maxLabelLength: 220,
    maxDescriptionLength: 0,
    maxQuestionLength: 360,
    returnsOptionIds: true,
    preselectsOption: false,
  },
};

const DEFAULT_TOOLS: Readonly<Record<DialogPlatform, string>> = {
  claude: "AskUserQuestion",
  codex: "request_user_input",
  antigravity: "ask_question",
};

export interface DialogCapabilities {
  platform: DialogPlatform;
  tool?: string;
  available?: boolean;
  interactive?: boolean;
  preselectsOption?: boolean;
  verifiedChannel?: boolean;
}

export interface DialogRefusal {
  code:
    | "unavailable"
    | "no_questions"
    | "question_limit"
    | "review_has_default_notices"
    | "preselects_recommendation"
    | "level3_provenance"
    | "unsupported_kind"
    | "option_limit"
    | "duplicate_labels"
    | "drops_content"
    | "would_truncate";
  card?: string;
  message: string;
}

export interface DialogCardBinding {
  ref: string;
  question: string;
  option_ids: string[];
  label_to_id: Record<string, string>;
  has_authorization: boolean;
}

export interface NativeDialogQuestion {
  id: string;
  header?: string;
  question: string;
  options: { id: string; label: string; description?: string; text?: string }[];
}

export interface DialogProjection {
  eligible: boolean;
  platform: DialogPlatform;
  tool: string;
  fallback: "markdown" | "terminal" | "review-page";
  reasons: DialogRefusal[];
  preamble_markdown?: string;
  payload?: { questions: NativeDialogQuestion[] };
  binding?: { review_id: string; cards: DialogCardBinding[] };
  fallback_markdown: string;
}

export interface NativeDialogResponse {
  ref?: string;
  selected_option_id?: string;
  selected_label?: string;
  freeform_text?: string;
  other_text?: string;
  skipped?: boolean;
  cancelled?: boolean;
}

export type MappedDialogAnswer =
  | { ok: true; skipped: true; message: string }
  | { ok: true; answer: { id: string; value?: string; custom?: string } }
  | { ok: true; clarification: { id: string; clarify: true; outcome: "needs_clarification"; note: string } }
  | { ok: false; code: number; error: string; message: string };

const normLabel = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

const cardHasAuthorization = (body: RequestBody): boolean =>
  body.kind === "approve" || (body.options ?? []).some((o) => !!o.authorization);

export function resolveDialogSurface(platform: DialogPlatform, tool?: string): DialogSurfaceSpec {
  const name = tool?.trim() || DEFAULT_TOOLS[platform];
  const direct = DIALOG_SURFACES[`${platform}:${name}`];
  if (direct) return direct;
  const fallback = DIALOG_SURFACES[`${platform}:${DEFAULT_TOOLS[platform]}`]!;
  return { ...fallback, tool: name };
}

function optionDetail(option: OptionSpec): string {
  const parts = [option.consequence.trim()];
  if (option.authorization) {
    const a = option.authorization;
    parts.push(`Authorizes ${a.action} on ${a.target} (scope: ${a.scope}${a.expected_effect ? `; result: ${a.expected_effect}` : ""}).`);
  }
  if (option.agent_next?.trim()) parts.push(`Agent does next: ${option.agent_next.trim()}`);
  return parts.join(" ");
}

function makeHeader(card: RequestView, maxLength: number): string | undefined {
  if (maxLength <= 0) return undefined;
  const base = card.body.kind === "approve" ? "Approval" : card.body.kind === "clarify" ? "Clarify" : "Decision";
  return base.slice(0, maxLength);
}

function buildQuestionPrompt(body: RequestBody): string {
  const summary = body.summary?.trim();
  const whyNow = body.why_now.trim();
  const parts = [body.question.trim(), summary ?? whyNow];
  if (summary && summary !== whyNow) parts.push(whyNow);
  if (body.recommendation) {
    const rec = body.recommendation;
    const opt = body.options?.find((o) => o.id === rec.option);
    const label = opt ? `${opt.label} (${opt.id})` : rec.option;
    const recBits = [`Recommended: ${label}`];
    if (rec.because) recBits.push(`because ${rec.because}`);
    if (rec.preserves) recBits.push(`preserves ${rec.preserves}`);
    if (rec.bolder_alternative) recBits.push(`bolder alternative: ${rec.bolder_alternative}`);
    parts.push(recBits.join("; ") + ".");
  }
  return parts.join(" ");
}

function droppedFields(card: RequestView): string[] {
  const b = card.body;
  const dropped: string[] = [];
  if (b.previews?.length) dropped.push("previews");
  if (b.evidence?.length) dropped.push("evidence");
  if (b.waivers?.length) dropped.push("waivers");
  if (Object.keys(b.glossary ?? {}).length) dropped.push("glossary");
  if (b.default) dropped.push("default");
  if (b.narrowing_reason) dropped.push("narrowing_reason");
  if (b.depends_on?.length) dropped.push("depends_on");
  if (b.skip_if?.length) dropped.push("skip_if");
  if (b.notes) dropped.push("notes");
  if (b.revisit) dropped.push("revisit (the earlier decision and what changed)");
  if (card.revision_diff) dropped.push("revision_diff");
  if (card.flags?.length) dropped.push("flags");
  if (card.clarification) dropped.push("clarification");
  return dropped;
}

/**
 * Evaluate whether a UTP review can be projected losslessly onto a platform's
 * native question dialog. Never drops fields, never truncates consequences,
 * never reorders options, and never allows a pre-selecting dialog on a card
 * with a recommendation.
 */
export function projectReviewToDialog(review: ReviewView, caps: DialogCapabilities): DialogProjection {
  const surface = resolveDialogSurface(caps.platform, caps.tool);
  const preselects = surface.preselectsOption || caps.preselectsOption === true;
  const openCards = review.items.filter((c) => c.current && c.body.kind !== "notice"
    && ["queued", "presented", "default_claimed"].includes(c.status));
  const hasMediaJudge = openCards.some((c) => c.body.kind === "judge" && c.body.previews?.some((p) => "data" in p));
  const hasLevel3 = openCards.some((c) => c.body.level === 3 && (cardHasAuthorization(c.body) || c.body.kind === "judge"));
  const fallback: DialogProjection["fallback"] = (openCards.length >= 3 || hasMediaJudge)
    ? "review-page"
    : hasLevel3 ? "terminal" : "markdown";
  const fallback_markdown = reviewMarkdown(review);
  const reasons: DialogRefusal[] = [];

  if (caps.available === false || caps.interactive === false) {
    reasons.push({ code: "unavailable", message: `${surface.tool} is unavailable or non-interactive in this session.` });
  }
  if (openCards.length === 0) {
    reasons.push({ code: "no_questions", message: "No open decision cards to display in a dialog." });
  }
  if (openCards.length > surface.maxQuestions) {
    reasons.push({
      code: "question_limit",
      message: `${surface.tool} allows at most ${surface.maxQuestions} questions per dialog; this review has ${openCards.length}.`,
    });
  }
  if ((review.default_notices?.length ?? 0) > 0) {
    reasons.push({
      code: "review_has_default_notices",
      message: "Applied defaults need Keep/Switch controls on Markdown, terminal review, or the review page.",
    });
  }
  const hasOpenNotices = review.items.some((c) => c.current && c.body.kind === "notice"
    && ["queued", "presented"].includes(c.status));
  if (hasOpenNotices) {
    reasons.push({
      code: "drops_content",
      message: "This review includes open notices that must be shown in Markdown, terminal review, or the review page.",
    });
  }

  const questions: NativeDialogQuestion[] = [];
  const bindings: DialogCardBinding[] = [];

  for (const card of openCards) {
    const ref = `${card.id}@${card.revision}`;
    const b = card.body;
    const hasAuth = cardHasAuthorization(b);

    if (preselects && b.recommendation) {
      reasons.push({
        code: "preselects_recommendation",
        card: ref,
        message: `${surface.tool} pre-selects an option and must never be used for a card with a recommendation (${b.kind}). Fall back to Markdown or terminal review with options and recommendation unchanged.`,
      });
    }
    if (["handoff", "accept", "assumptions", "judge"].includes(b.kind)) {
      reasons.push({
        code: "unsupported_kind",
        card: ref,
        message: `${b.kind} cards require structured per-item or blind controls that ${surface.tool} cannot carry losslessly.`,
      });
    }
    if (b.level === 3 && hasAuth && caps.verifiedChannel !== true) {
      reasons.push({
        code: "level3_provenance",
        card: ref,
        message: "Level-3 consequential authorizations require a verified channel (review page, terminal review, or verified transcript).",
      });
    }
    const dropped = droppedFields(card);
    if (dropped.length) {
      reasons.push({
        code: "drops_content",
        card: ref,
        message: `${surface.tool} has no slot for ${dropped.join(", ")}; falling back so nothing is dropped.`,
      });
    }

    const options = b.options ?? [];
    if (options.length < surface.minOptions || options.length > surface.maxOptions) {
      reasons.push({
        code: "option_limit",
        card: ref,
        message: `${surface.tool} supports ${surface.minOptions} to ${surface.maxOptions} options; card has ${options.length}.`,
      });
    }

    const labelCounts = new Map<string, number>();
    for (const opt of options) {
      const key = normLabel(opt.label);
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }
    const labelToId: Record<string, string> = Object.create(null) as Record<string, string>;
    let duplicateLabels = false;
    for (const opt of options) {
      const key = normLabel(opt.label);
      if ((labelCounts.get(key) ?? 0) > 1) duplicateLabels = true;
      else labelToId[key] = opt.id;
    }
    if (!surface.returnsOptionIds && duplicateLabels) {
      reasons.push({
        code: "duplicate_labels",
        card: ref,
        message: `${surface.tool} returns option labels rather than IDs, so every option label must be unique.`,
      });
    }

    const promptText = buildQuestionPrompt(b);
    if (promptText.length > surface.maxQuestionLength) {
      reasons.push({
        code: "would_truncate",
        card: ref,
        message: `Question and context (${promptText.length} chars) exceed ${surface.tool}'s ${surface.maxQuestionLength}-char limit; refusing instead of truncating.`,
      });
    }

    const projectedOptions: NativeDialogQuestion["options"] = [];
    for (const opt of options) {
      const detail = optionDetail(opt);
      if (surface.hasDescriptionSlot) {
        if (opt.label.length > surface.maxLabelLength || detail.length > surface.maxDescriptionLength) {
          reasons.push({
            code: "would_truncate",
            card: ref,
            message: `Option ${opt.id} label or consequence exceeds ${surface.tool}'s field limits; refusing instead of truncating.`,
          });
        }
        projectedOptions.push({ id: opt.id, label: opt.label, description: detail });
      } else {
        const combined = `${opt.label} — ${detail}`;
        if (combined.length > surface.maxLabelLength) {
          reasons.push({
            code: "would_truncate",
            card: ref,
            message: `Option ${opt.id} combined label and consequence (${combined.length} chars) exceeds ${surface.tool}'s ${surface.maxLabelLength}-char limit; refusing instead of truncating.`,
          });
        }
        projectedOptions.push({ id: opt.id, label: opt.label, text: combined });
      }
    }

    const header = makeHeader(card, surface.maxHeaderLength);
    questions.push({
      id: ref,
      ...(header ? { header } : {}),
      question: promptText,
      options: projectedOptions,
    });
    bindings.push({
      ref,
      question: b.question,
      option_ids: options.map((o) => o.id),
      label_to_id: labelToId,
      has_authorization: hasAuth,
    });
  }

  if (reasons.length > 0) {
    return {
      eligible: false,
      platform: surface.platform,
      tool: surface.tool,
      fallback,
      reasons,
      fallback_markdown,
    };
  }

  return {
    eligible: true,
    platform: surface.platform,
    tool: surface.tool,
    fallback,
    reasons: [],
    preamble_markdown: contextMarkdown(review.intent),
    payload: { questions },
    binding: { review_id: review.id, cards: bindings },
    fallback_markdown,
  };
}

/**
 * Map a native dialog's raw answer back to a revision-bound UTP answer (or
 * clarification request). Rejects stale/mismatched revisions, maps "Other"
 * freeform text to verbatim `custom` (or `needs_clarification` on authorized
 * cards), and never treats skips/cancellations as approvals.
 */
export function mapDialogResponse(card: RequestView, binding: DialogCardBinding, response: NativeDialogResponse): MappedDialogAnswer {
  const currentRef = `${card.id}@${card.revision}`;
  if (!binding || typeof binding.ref !== "string" || !binding.ref.trim()) {
    return {
      ok: false,
      code: EXIT.OTHER,
      error: "missing_binding",
      message: "A revision-bound dialog binding (ref) is required before mapping a response.",
    };
  }
  if (!card.current || binding.ref !== currentRef || (response.ref && response.ref !== currentRef)) {
    return {
      ok: false,
      code: EXIT.REVOKED,
      error: "stale_revision",
      message: `Dialog response targeted ${response.ref ?? binding.ref}, but current card revision is ${currentRef}. Re-present before recording.`,
    };
  }
  if (!["queued", "presented", "default_claimed"].includes(card.status)) {
    return {
      ok: false,
      code: EXIT.NOT_ALLOWED,
      error: "card_not_open",
      message: `Card ${currentRef} is ${card.status} and cannot accept a new dialog answer.`,
    };
  }
  // Always derive authoritative option IDs, unique label map, and authorization directly from card.body.
  const options = card.body.options ?? [];
  const authOptionIds = options.map((o) => o.id);
  const hasAuthorization = cardHasAuthorization(card.body);
  if (Array.isArray(binding.option_ids)
      && (binding.option_ids.length !== authOptionIds.length
        || binding.option_ids.some((id, idx) => id !== authOptionIds[idx]))) {
    return {
      ok: false,
      code: EXIT.REVOKED,
      error: "binding_mismatch",
      message: `Dialog option binding does not match ${currentRef}. Re-present before recording.`,
    };
  }
  const labelCounts = new Map<string, number>();
  for (const opt of options) {
    const k = normLabel(opt.label);
    labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
  }
  const uniqueLabels = new Map<string, string>();
  for (const opt of options) {
    const k = normLabel(opt.label);
    if (labelCounts.get(k) === 1) uniqueLabels.set(k, opt.id);
  }

  if (response.skipped === true || response.cancelled === true) {
    return { ok: true, skipped: true, message: "Dialog was skipped or cancelled; no answer or approval recorded." };
  }

  const f1 = typeof response.freeform_text === "string" && response.freeform_text.trim().length > 0 ? response.freeform_text : undefined;
  const f2 = typeof response.other_text === "string" && response.other_text.trim().length > 0 ? response.other_text : undefined;
  if (f1 !== undefined && f2 !== undefined && f1.trim() !== f2.trim()) {
    return {
      ok: false,
      code: EXIT.OTHER,
      error: "ambiguous_selection",
      message: "Native dialog response contained two different freeform text fields.",
    };
  }
  const rawFreeform = f1 ?? f2;
  const hasFreeform = rawFreeform !== undefined;
  const rawOptionId = typeof response.selected_option_id === "string" ? response.selected_option_id.trim() : "";
  const rawLabel = typeof response.selected_label === "string" ? response.selected_label.trim() : "";
  const hasSelected = Boolean(rawOptionId || rawLabel);

  if (hasAuthorization && hasFreeform) {
    return {
      ok: true,
      clarification: {
        id: currentRef,
        clarify: true,
        outcome: "needs_clarification",
        note: rawFreeform.trim(),
      },
    };
  }

  if (hasSelected && hasFreeform) {
    return {
      ok: false,
      code: EXIT.OTHER,
      error: "ambiguous_selection",
      message: "Native dialog returned both a listed option and freeform text; clarify before recording.",
    };
  }

  if (hasFreeform) {
    return { ok: true, answer: { id: currentRef, custom: rawFreeform } };
  }

  let resolvedById: string | undefined;
  if (rawOptionId) {
    if (!authOptionIds.includes(rawOptionId)) {
      return {
        ok: false,
        code: EXIT.OTHER,
        error: "unknown_option",
        message: `Option id "${rawOptionId}" is not part of ${currentRef}.`,
      };
    }
    resolvedById = rawOptionId;
  }

  let resolvedByLabel: string | undefined;
  if (rawLabel) {
    const mapped = uniqueLabels.get(normLabel(rawLabel));
    if (!mapped) {
      return {
        ok: false,
        code: EXIT.OTHER,
        error: "unknown_label",
        message: `Option label "${rawLabel}" does not match any unique option on ${currentRef}.`,
      };
    }
    resolvedByLabel = mapped;
  }

  if (resolvedById && resolvedByLabel && resolvedById !== resolvedByLabel) {
    return {
      ok: false,
      code: EXIT.OTHER,
      error: "ambiguous_selection",
      message: `Native dialog option id "${resolvedById}" conflicts with label "${rawLabel}" (${resolvedByLabel}).`,
    };
  }

  const chosen = resolvedById ?? resolvedByLabel;
  if (chosen) {
    return { ok: true, answer: { id: currentRef, value: chosen } };
  }

  return {
    ok: false,
    code: EXIT.OTHER,
    error: "empty_response",
    message: "Native dialog response contained neither an option nor freeform text.",
  };
}
