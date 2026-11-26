import { createHash, randomUUID } from "node:crypto";
import { answerValue, cardMetadata, dependencyLabels, reviewContext, sharedFromIntent, type ReviewView } from "../cli/render.js";
import { earlierCard, previousDecision } from "../core/review-history.js";
import { reviewRequestsHash } from "../core/check.js";
import { PIN_CHANGES, pinVersion, type DecisionPin } from "../core/decision-pins.js";
import type { BlindReveal } from "../core/blind.js";
import type { BrowserBatchReceipt, RecordedBrowserAnswer } from "../core/engine.js";
import type { RevisionDiff } from "../core/diff.js";
import { itemPrompts } from "../core/items.js";
import { waiverNotes } from "../core/quality.js";
import { CLARITY_FEEDBACK, SURENESS, type Actor, type AnswerRecord, type RequestBody } from "../core/types.js";
import { reviewStyle, themeColor } from "./review-style.js";

const playComparisons = `document.addEventListener("click", (event) => {
  const pair = event.target instanceof Element && event.target.closest("[data-play-comparison]")?.closest("article");
  if (!pair) return;
  for (const video of pair.querySelectorAll(".compare video")) {
    video.currentTime = 0;
    video.play().catch(() => {});
  }
});`;
export const comparisonScriptHash = createHash("sha256").update(playComparisons).digest("base64");

export const reviewHasVideoComparison = (review: ReviewView): boolean =>
  review.items.some((item) => item.body.kind === "judge"
    && (item.body.previews ?? []).some((p) => "media_type" in p && p.media_type === "video/mp4"));

const KIND_LABELS: Record<string, string> = {
  choose: "Choice", approve: "Approval", handoff: "Manual step", clarify: "Clarification",
  accept: "Result check", assumptions: "Assumptions", notice: "Notice", judge: "Blind comparison",
};
const UNDO_LABELS: Record<string, string> = {
  easy: "Easy to undo", costly: "Costly to undo", one_way: "Can't be undone",
};

export const cardHasAuthorization = (body: RequestBody): boolean =>
  body.kind === "approve" || (body.options ?? []).some((o) => !!o.authorization);

export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function notice(text: string): string {
  return `<p class="preserve">${escapeText(text)}</p>`;
}

function contextHtml(review: ReviewView): string {
  const fields = reviewContext(review.intent).map(([label, value]) =>
    `<dt>${escapeText(label)}</dt><dd class="preserve">${escapeText(value)}</dd>`).join("");
  return `<dl class="review-context" aria-label="Review context">${fields}</dl>`;
}

function revisionBannerHtml(diff: RevisionDiff): string {
  const bullets: string[] = [];
  if (diff.trigger.kind === "clarification") {
    bullets.push(diff.trigger.note
      ? `<li><strong>Triggered by your clarification on rev ${diff.from_revision}:</strong> "${escapeText(diff.trigger.note)}"</li>`
      : `<li>Triggered by a clarification request on rev ${diff.from_revision}.</li>`);
  } else if (diff.trigger.kind === "stale") {
    const files = diff.trigger.files?.length ? diff.trigger.files.join(", ") : "tracked basis files";
    bullets.push(`<li><strong>Rev ${diff.from_revision} went stale:</strong> ${escapeText(files)} changed.</li>`);
  } else if (diff.trigger.kind === "custom_answer") {
    bullets.push(`<li><strong>Revised after your reply on rev ${diff.from_revision}:</strong> "${escapeText(diff.trigger.custom ?? "")}"</li>`);
  }
  if (diff.prior_answer) {
    bullets.push(`<li><strong>Previous pick on rev ${diff.from_revision}:</strong> ${escapeText(diff.prior_answer)} <em>(not pre-selected — confirm or change below)</em></li>`);
  }
  for (const change of diff.changes) bullets.push(`<li>${escapeText(change)}</li>`);
  if (diff.unchanged.length) bullets.push(`<li class="muted">Unchanged: ${escapeText(diff.unchanged.join(", "))}.</li>`);
  return `<aside class="revision-banner" aria-label="Revision changes"><p class="banner-title">Updated from rev ${diff.from_revision} &rarr; rev ${diff.to_revision}</p><ul>${bullets.join("")}</ul></aside>`;
}

function itemDetailHtml(body: RequestBody, itemId: string): string {
  if (body.kind === "handoff") {
    const step = body.steps?.find((s) => s.id === itemId);
    if (!step) return "";
    const parts = [
      `<p class="muted">${escapeText(`${step.actor} on ${step.machine} using ${step.shell} · ${step.tested ? "Tested in this shell." : "This step needs a shell check."}`)}</p>`,
      `<pre>${escapeText(step.command)}</pre>`,
      `<p class="preserve"><strong>Expected result:</strong> ${escapeText(step.expected_result)}.</p>`,
      `<p class="preserve muted">${escapeText(step.why_person)}</p>`,
    ];
    if (step.agent_next) parts.push(`<p class="preserve agent-next"><strong>Agent does next:</strong> ${escapeText(step.agent_next)}</p>`);
    return parts.join("");
  }
  if (body.kind === "accept") {
    const goal = body.goals?.find((g) => g.id === itemId);
    if (!goal) return "";
    const ev = (goal.evidence ?? []).map((e) =>
      `<li>${escapeText(`${e.claim} (${e.kind}, ${e.source}, ${e.date})`)}</li>`).join("");
    return `<p class="muted">Coverage: ${escapeText(goal.coverage?.replaceAll("_", " ") ?? "")}</p>${ev ? `<ul class="item-evidence">${ev}</ul>` : ""}`;
  }
  if (body.kind === "assumptions") {
    const item = body.assumptions?.find((a) => a.id === itemId);
    if (!item) return "";
    return `<p class="preserve muted">${escapeText(item.consequence)}</p>`;
  }
  return "";
}

export interface SavedHtmlOptions {
  receipt?: BrowserBatchReceipt;
  remainingQuestions?: string[];
  pickupHtml?: string;
  editFormHtml?: string;
  reveals?: { question: string; reveal: BlindReveal }[];
}

export interface PinContext {
  project: string;
  pins: DecisionPin[];
  returnTo: string;
}

export type BrowserReview = ReviewView & { pinContext?: PinContext; sourceHistoryPath?: string };

// Buttons inside an answer or follow-up form submit this separate form so answers never travel with a pin.
export function pinForm(returnTo: string): string {
  return `<form hidden id="decision-pins" method="post"><input type="hidden" name="return" value="${escapeText(returnTo)}">
    <input type="hidden" name="submission" value="${randomUUID()}"></form>`;
}

function pinButton(project: string, ref: string, op: "pin" | "unpin", expected: string): string {
  return `<button type="submit" form="decision-pins" formaction="/pins/${escapeText(project)}/${escapeText(ref)}/${op}"
    name="expected" value="${expected}" class="button-secondary">${op === "pin" ? "Pin decision" : "Unpin"}</button>`;
}

export function cardPinControl(context: PinContext | undefined, id: string, revision: number, answer?: AnswerRecord | null): string {
  if (!context) return "";
  const pin = context.pins.find(p => p.id === id);
  const ref = `${id}@${revision}`;
  if (pin?.revision === revision) return pinButton(context.project, ref, "unpin", pinVersion(pin));
  return answer && !(pin && pin.revision > revision) ? pinButton(context.project, ref, "pin", reviewRequestsHash([answer])) : "";
}

export function pinnedDecisionsHtml(context?: PinContext, projectLabel?: string): string {
  if (!context?.pins.length) return "";
  const rows = context.pins.map(pin => {
    const ref = `${pin.id}@${pin.revision}`;
    const href = `/history/${context.project}/${pin.review_id}#${ref}`;
    const badges = pin.reasons.map(reason => `<span class="badge badge-warn">${PIN_CHANGES[reason]}</span>`).join(" ");
    return `<li><a href="${escapeText(href)}">${escapeText(pin.title)}</a> ${badges}
      <p class="preserve">${escapeText(pin.answer)}</p>${pin.note ? `<p class="muted preserve">${escapeText(pin.note)}</p>` : ""}
      ${pinButton(context.project, ref, "unpin", pinVersion(pin))}</li>`;
  });
  const changed = context.pins.filter(pin => pin.stale).length;
  return `<details class="decision-pins"><summary>Pinned decisions (${rows.length})${projectLabel ? ` · ${escapeText(projectLabel)}` : ""}
    ${changed ? `<span class="badge badge-warn">${changed} changed</span>` : ""}</summary><ul>${rows.join("")}</ul></details>`;
}

export function blindRevealHtml(reveal: BlindReveal, question: string): string {
  return `<article class="blind-reveal"><h2>${escapeText(question)}</h2><dl><dt>Candidate A</dt><dd>${escapeText(reveal.identities.a)}</dd>
    ${reveal.notes?.a ? `<dd class="muted">${escapeText(reveal.notes.a)}</dd>` : ""}
    <dt>Candidate B</dt><dd>${escapeText(reveal.identities.b)}</dd>
    ${reveal.notes?.b ? `<dd class="muted">${escapeText(reveal.notes.b)}</dd>` : ""}</dl>`
    + (reveal.recommendation ? notice(`The recommendation was Candidate ${reveal.recommendation.toUpperCase()}.`) : "") + "</article>";
}

export function pickupStatusHtml(review: ReviewView, waiters: readonly Actor[]): string {
  if (waiters.length > 0) {
    const names = waiters.map((w) => `${w.session} on ${w.machine}`).join(", ");
    return `<p class="pickup-status pickup-live" role="status"><strong>Agent is listening now:</strong> ${escapeText(names)} will pick up your reply immediately.</p>`;
  }
  const first = review.items.find((i) => i.body.origin || i.owner);
  const agent = first?.body.origin?.agent || first?.body.origin?.platform || "the agent";
  const session = first?.owner?.session && first.owner.session !== "default" ? first.owner.session.slice(0, 12) : undefined;
  const machine = first?.owner?.machine;
  const where = [agent, session ? `session ${session}` : undefined, machine ? `on ${machine}` : undefined].filter(Boolean).join(" ");
  return `<p class="pickup-status" role="status"><strong>Saved — no agent is actively waiting right now.</strong> Return to ${escapeText(where)} and tell it to resume, or run <code>utp resume ${escapeText(review.id)}</code>.</p>`;
}

export function editReviewHtml(review: BrowserReview, token: string, returnLink: string, message?: string, statusMessage?: string): string {
  const cards = review.items.map((item, index) => {
    const b = item.body;
    const ref = `${item.id}@${item.revision}`;
    const pin = cardPinControl(review.pinContext, item.id, item.revision, item.answer);
    const hasAuth = cardHasAuthorization(b);
    const editable = b.kind !== "judge" && (item.status === "answered" || item.status === "granted");
    const currentAnswer = item.answer ? answerValue(item.answer, b) : undefined;
    const noteText = item.answer?.note ? `<p class="muted">Note: ${escapeText(item.answer.note)}</p>` : "";
    if (!editable) {
      const ev = item.applied_evidence;
      const effectHtml = ev
        ? `<p class="receipt"><strong>Applied effect:</strong> ${escapeText(ev.effect)} <span class="muted">(${escapeText(`${ev.action} on ${ev.target} · scope: ${ev.scope}`)})</span></p>`
        : "";
      const clarHtml = item.clarification
        ? `<p role="status">Held for clarification: "${escapeText(item.clarification.note ?? "")}"</p>`
        : "";
      const revealHtml = b.kind === "judge" && item.blind_reveal
        ? `<p class="muted">Candidate A: ${escapeText(item.blind_reveal.identities.a)} · Candidate B: ${escapeText(item.blind_reveal.identities.b)}</p>`
        : "";
      const lockBadge = b.kind === "judge" && item.answer ? "Immutable blind ballot" : `Locked · ${item.status.replaceAll("_", " ")}`;
      return `<article class="locked-card"><h2>${escapeText(b.question)}</h2>${pin}
        <p class="card-badges"><span class="badge">${escapeText(lockBadge)}</span></p>
        ${currentAnswer ? `<p class="preserve"><strong>Recorded answer:</strong> ${escapeText(currentAnswer)}</p>${noteText}` : ""}
        ${revealHtml}${clarHtml}${effectHtml}
        <p class="card-reference"><code>${escapeText(ref)}</code></p></article>`;
    }
    const controls: string[] = [];
    const prompts = itemPrompts(b);
    if (prompts.length) {
      for (const [n, prompt] of prompts.entries()) {
        const cur = item.answer?.items?.[prompt.id] ?? "";
        const curDetail = item.answer?.details?.[prompt.id] ?? "";
        controls.push(`<fieldset class="item-card"><legend>${escapeText(prompt.id)} · ${escapeText(prompt.label)}</legend><div class="item-choices">`,
          ...prompt.choices.map((choice) =>
            `<label class="option"><input type="radio" name="item-${index}-${n}" value="${escapeText(choice)}"${cur === choice ? " checked" : ""}><span>${escapeText(choice.replaceAll("_", " "))}</span></label>`),
          "</div>",
          ...(prompt.detailLabel ? [`<label>${escapeText(prompt.detailLabel)}<textarea name="detail-${index}-${n}" rows="2">${escapeText(curDetail)}</textarea></label>`] : []),
          "</fieldset>");
      }
    } else if (b.options?.length) {
      const curChoice = item.answer?.value ?? (item.answer?.custom ? "__custom__" : "");
      const optionRows = b.options.map((option) =>
        `<label class="option"><input type="radio" name="choice-${index}" value="${escapeText(option.id)}"${curChoice === option.id ? " checked" : ""}><span><strong>${escapeText(option.label)}</strong> <small class="muted">(${escapeText(option.id)})</small><br>${escapeText(option.consequence)}</span></label>`);
      if (!hasAuth) {
        optionRows.push(`<label class="option"><input type="radio" name="choice-${index}" value="__custom__"${curChoice === "__custom__" ? " checked" : ""}><span><strong>Your own answer</strong><br>Use the text box below instead of a listed option.</span></label>`);
      }
      controls.push('<fieldset><legend>Change option</legend>', ...optionRows, "</fieldset>");
    }
    if (hasAuth) {
      controls.push(`<label>Propose a different scope or ask a question (withholds approval — agent revises before acting)<textarea name="custom-${index}" rows="2"></textarea></label>`);
    } else {
      controls.push(`<label>Your own answer <textarea name="custom-${index}" rows="2">${escapeText(item.answer?.custom ?? "")}</textarea></label>`);
      controls.push(`<label>Optional note for the agent <textarea name="note-${index}" rows="2">${escapeText(item.answer?.note ?? "")}</textarea></label>`);
    }
    return `<article class="edit-card"><h2>${escapeText(b.question)}</h2>${pin}
      <p class="card-badges"><span class="badge badge-rec">Editable before work begins (${escapeText(item.status)})</span></p>
      ${currentAnswer ? `<p class="preserve"><strong>Current answer:</strong> ${escapeText(currentAnswer)}</p>${noteText}` : ""}
      ${controls.join("\n")}
      <div class="form-actions">
        <button type="submit" name="edit-save" value="${escapeText(ref)}">Save change</button>
        <button type="submit" name="edit-withdraw" value="${escapeText(ref)}" class="button-secondary" formnovalidate>Withdraw answer</button>
      </div>
      <p class="card-reference"><code>${escapeText(ref)}</code></p></article>`;
  });
  const banner = statusMessage ? `<p role="status">${escapeText(statusMessage)}</p>` : "";
  const err = message ? `<p role="alert" class="error">${escapeText(message)}</p>` : "";
  return page("Edit answers", `<h1>Review status &amp; edits</h1>
    ${review.pinContext ? pinForm(review.pinContext.returnTo) : ""}${pinnedDecisionsHtml(review.pinContext)}
    <p class="muted">You can change or withdraw an answer while it has not begun executing. Once the agent runs <code>utp begin</code>, that card locks.</p>
    ${contextHtml(review)}${banner}${err}
    <form method="post"><input type="hidden" name="presentation" value="${escapeText(token)}">
    ${cards.join("") || '<p class="muted">No editable or completed cards in this review.</p>'}
    </form>${returnLink}`);
}

export function savedHtml(review: BrowserReview, answers: RecordedBrowserAnswer[], returnLink: string, opts: SavedHtmlOptions = {}): string {
  const rows = answers.map(({ id, revision, answer }) => {
    const card = review.items.find(item => item.id === id && item.revision === revision);
    const noteLine = answer.note ? `<dd class="muted">Note: ${escapeText(answer.note)}</dd>` : "";
    return `<dt>${escapeText(card?.body.question ?? id)}</dt><dd class="preserve">${escapeText(answerValue(answer, card?.body))}</dd>${noteLine}
      <dd class="card-reference">${escapeText(id)}@${revision} ${cardPinControl(review.pinContext, id, revision, answer)}</dd>`;
  }).join("");
  const hiddenRows = (opts.receipt?.hidden ?? []).map(({ id, revision, until }) => {
    const card = review.items.find(item => item.id === id && item.revision === revision);
    return `<dt>${escapeText(card?.body.question ?? id)}</dt><dd class="muted">Hidden until ${escapeText(until)}</dd><dd class="card-reference">${escapeText(id)}@${revision}</dd>`;
  }).join("");
  const clarRows = (opts.receipt?.clarifications ?? []).map(({ id, revision, clarification }) => {
    const card = review.items.find(item => item.id === id && item.revision === revision);
    return `<dt>${escapeText(card?.body.question ?? id)}</dt><dd class="preserve">Approval withheld pending clarification: "${escapeText(clarification.note ?? "")}"</dd><dd class="card-reference">${escapeText(id)}@${revision}</dd>`;
  }).join("");
  const parts: string[] = [];
  if (answers.length) parts.push(`${answers.length} ${answers.length === 1 ? "answer" : "answers"}`);
  if (opts.receipt?.hidden.length) parts.push(`${opts.receipt.hidden.length} hidden`);
  if (opts.receipt?.clarifications.length) parts.push(`${opts.receipt.clarifications.length} held for clarification`);
  const summary = `UTP recorded ${parts.join(", ") || "0 answers"}.`;
  const remaining = opts.remainingQuestions?.length
    ? `<section class="remaining-cards" role="status"><strong>Still open in this review (${opts.remainingQuestions.length}):</strong><ul>${opts.remainingQuestions.map((q) => `<li>${escapeText(q)}</li>`).join("")}</ul></section>`
    : "";
  const revealBlocks = (opts.reveals ?? []).map(({ question, reveal }) => blindRevealHtml(reveal, question)).join("");
  return page("Answers saved", `<h1>Answers saved</h1>${review.pinContext ? pinForm(review.pinContext.returnTo) : ""}<p class="receipt">${summary}</p>
    ${opts.pickupHtml ?? ""}${remaining}${contextHtml(review)}
    ${rows ? `<dl aria-label="Saved answers">${rows}</dl>` : ""}
    ${revealBlocks}
    ${clarRows ? `<dl aria-label="Held for clarification">${clarRows}</dl>` : ""}
    ${hiddenRows ? `<dl aria-label="Hidden cards">${hiddenRows}</dl>` : ""}
    ${opts.editFormHtml ?? ""}${returnLink}`);
}

export interface ReviewHtmlOptions {
  previewLines?: string[];
  statusMessage?: string;
}

export function reviewHtml(review: BrowserReview, token: string, message?: string, form?: URLSearchParams, opts: ReviewHtmlOptions = {}): string {
  const field = (name: string): string => escapeText(form?.get(name) ?? "");
  const checked = (name: string, value: string): string => form?.get(name) === value ? " checked" : "";
  const chipGroup = (name: string, label: string, choices: readonly (readonly [string, string])[]): string => {
    const current = form?.get(name) ?? "";
    const pills = choices.map(([value, text]) =>
      `<label class="chip"><input type="radio" name="${name}" value="${escapeText(value)}"${current === value ? " checked" : ""}><span>${escapeText(text)}</span></label>`).join("");
    return `<fieldset class="chip-group"><legend>${escapeText(label)}</legend><div class="chip-row">${pills}</div></fieldset>`;
  };
  const shared = sharedFromIntent(review.intent);
  const cards = review.items.map((item, index) => {
    const b = item.body;
    const hasAuth = cardHasAuthorization(b);
    const kindLabel = KIND_LABELS[b.kind] ?? b.kind;
    const undoLabel = UNDO_LABELS[b.stakes.reversibility] ?? b.stakes.reversibility;
    const stakesClass = b.stakes.reversibility === "one_way" ? "badge-danger" : b.stakes.reversibility === "costly" ? "badge-warn" : "badge-easy";
    const parts = [
      `<article><h2>${escapeText(b.question)}</h2>`,
      `<p class="card-badges"><span class="badge">${escapeText(kindLabel)}</span><span class="badge ${stakesClass}">${escapeText(undoLabel)}</span><span class="badge">Level ${b.level}</span></p>`,
    ];
    const prior = earlierCard(review.follow_up, b);
    if (prior) parts.push(`<p class="prior-decision"><strong>Earlier decision</strong><br>${prior.question !== b.question ? escapeText(prior.question) + "<br>" : ""}${escapeText(previousDecision(prior))}</p>`);
    if (item.revision_diff) parts.push(revisionBannerHtml(item.revision_diff));
    if (b.kind !== "notice") parts.push("<h3>What this question addresses</h3>");
    parts.push(notice(b.summary ?? b.why_now));
    if (b.summary && b.summary !== b.why_now) parts.push("<h3>Why now</h3>", notice(b.why_now));
    if (item.clarification) parts.push(item.clarification.outcome === "unsure"
      ? '<p role="status">Confirm the current choice before the agent continues.</p>'
      : '<p role="status">Clarification requested. The agent will see it when it checks this question.</p>');
    for (const dependency of dependencyLabels(b, review.items, review.resolved_dependencies)) parts.push(notice(`Depends on ${dependency}`));
    if (Object.keys(b.glossary ?? {}).length) parts.push("<dl>", ...Object.entries(b.glossary ?? {}).map(([term, meaning]) =>
      `<dt>${escapeText(term)}</dt><dd>${escapeText(meaning)}</dd>`), "</dl>");
    const previewBlocks = (Array.isArray(b.previews) ? b.previews : []).map((preview) => {
      const label = escapeText(preview.label);
      const content = "text" in preview
        ? `<pre>${escapeText(preview.text)}</pre>`
        : preview.media_type === "video/mp4"
          ? `<video controls muted playsinline preload="metadata" aria-label="${label}" src="data:video/mp4;base64,${escapeText(preview.data)}"></video>`
          : `<img src="data:${escapeText(preview.media_type)};base64,${escapeText(preview.data)}" alt="${label}">`;
      return `<figure><figcaption>${label}</figcaption>${content}</figure>`;
    });
    if (b.kind === "judge") {
      parts.push(`<div class="compare">${previewBlocks.join("")}</div>`);
      if (b.previews?.length === 2 && b.previews.every((p) => "media_type" in p && p.media_type === "video/mp4")) {
        parts.push('<button type="button" class="button-secondary" data-play-comparison>Play both from the start</button>');
      }
    } else {
      parts.push(...previewBlocks);
    }
    if (b.notes) parts.push(notice(b.notes));
    if (b.narrowing_reason) parts.push(notice("Why the action cannot be split: " + b.narrowing_reason));
    for (const explanation of waiverNotes(b, shared)) parts.push(notice(explanation));
    for (const evidence of b.evidence ?? []) parts.push(notice(`${evidence.claim} (${evidence.kind}, ${evidence.source}, ${evidence.date})`));
    if (b.kind !== "notice") {
      for (const [n, prompt] of itemPrompts(b).entries()) {
        const detail = itemDetailHtml(b, prompt.id);
        parts.push(`<fieldset class="item-card"><legend>${escapeText(prompt.id)} · ${escapeText(prompt.label)}</legend>${detail}<div class="item-choices">`, ...prompt.choices.map((choice) =>
          `<label class="option"><input type="radio" name="item-${index}-${n}" value="${escapeText(choice)}"${checked(`item-${index}-${n}`, choice)}><span>${escapeText(choice.replaceAll("_", " "))}</span></label>`), "</div>");
        if (prompt.detailLabel) parts.push(`<label>${escapeText(prompt.detailLabel)}<textarea name="detail-${index}-${n}" rows="2">${field(`detail-${index}-${n}`)}</textarea></label>`);
        parts.push("</fieldset>");
      }
      if (b.options?.length) {
        const optionRows = b.options.map((option) => {
          const authority = option.authorization;
          const scope = authority ? `<span class="muted">${escapeText(
            `Authorizes: ${authority.action} on ${authority.target} · Scope: ${authority.scope}`
              + (authority.expected_effect ? ` · Expected result: ${authority.expected_effect}` : ""))}</span>` : "";
          const next = option.agent_next ? `<span class="agent-next"><strong>Agent does next:</strong> ${escapeText(option.agent_next)}</span>` : "";
          const recTag = b.recommendation?.option === option.id ? ' <span class="badge badge-rec">Recommended</span>' : "";
          const defTag = b.default?.option === option.id ? ' <span class="badge badge-default">Default if unanswered</span>' : "";
          return `<label class="option"><input type="radio" name="choice-${index}" value="${escapeText(option.id)}"${checked(`choice-${index}`, option.id)}><span><strong>${escapeText(option.label)}</strong> <small class="muted">(${escapeText(option.id)})</small>${recTag}${defTag}<br>${escapeText(option.consequence)}${scope ? "<br>" + scope : ""}${next ? "<br>" + next : ""}</span></label>`;
        });
        if (!hasAuth && b.kind !== "judge") {
          optionRows.push(`<label class="option"><input type="radio" name="choice-${index}" value="__custom__"${checked(`choice-${index}`, "__custom__")}><span><strong>Your own answer</strong><br>Use the text box below instead of a listed option.</span></label>`);
        }
        parts.push('<fieldset><legend>Choose an option</legend>', ...optionRows, "</fieldset>");
      }
    }
    if (b.recommendation) {
      const rec = b.recommendation;
      const label = b.options?.find((option) => option.id === rec.option)?.label ?? rec.option;
      parts.push(notice([`Recommended option is ${label}.`, rec.because,
        rec.preserves && `It preserves ${rec.preserves}`, rec.bolder_alternative && `A bolder alternative is ${rec.bolder_alternative}`]
        .filter(Boolean).join("\n")));
    }
    if (b.default) {
      const defLabel = b.options?.find((option) => option.id === b.default?.option)?.label;
      const defTitle = defLabel ? `${defLabel} (${b.default.option})` : b.default.option;
      parts.push(notice(`Stated default: ${defTitle}. ${b.default.consequence}`));
    }
    for (const flag of item.flags) parts.push(notice(flag));
    parts.push(`<p class="card-reference"><code>${escapeText(item.id)}@${item.revision}</code> · ${escapeText(cardMetadata(item))}</p>`);
    if (b.kind !== "notice") {
      if (b.kind === "judge") {
        const scores = ["1", "2", "3", "4", "5"].map((score) => [score, score] as const);
        parts.push(`<div class="ratings">${chipGroup(`rating-a-${index}`, "Rate Candidate A", scores)}
          ${chipGroup(`rating-b-${index}`, "Rate Candidate B", scores)}
          ${chipGroup(`repeat-${index}`, "Would you run this test again?", [["yes", "Yes"], ["no", "No"]])}</div>`,
          `<label>Reason (optional) <textarea name="reason-${index}" rows="3">${field(`reason-${index}`)}</textarea></label>`);
      } else if (hasAuth) {
        parts.push(`<label>Propose a different scope or ask a question (withholds approval — agent revises before acting)<textarea name="custom-${index}" rows="2">${field(`custom-${index}`)}</textarea></label>`);
      } else {
        parts.push(`<label>Your own answer <textarea name="custom-${index}" rows="2">${field(`custom-${index}`)}</textarea></label>`);
        parts.push(`<label>Optional note for the agent (keeps your chosen option) <textarea name="note-${index}" rows="2">${field(`note-${index}`)}</textarea></label>`);
      }
      if (b.kind !== "judge") {
        const actionChoices: [string, string][] = [
          ["", "Answer now or leave open"],
          ["hide", "Hide until tomorrow"],
          ["answered_elsewhere", "Answered elsewhere"],
          ["no_longer_matters", "No longer matters"],
        ];
        parts.push(`<div class="card-defer">${chipGroup(`action-${index}`, "Batch action (optional)", actionChoices)}</div>`);
      }
      const sureness = chipGroup(`sureness-${index}`, "How sure are you?", SURENESS.map((choice) =>
        [choice, choice.charAt(0).toUpperCase() + choice.slice(1)]));
      const clarity = chipGroup(`feedback-${index}`, "How clear was this card?", Object.entries(CLARITY_FEEDBACK));
      parts.push(`<div class="ratings">${sureness}${clarity}</div>`);
      if (!item.clarification) {
        parts.push('<details><summary>Question or choices unclear?</summary>',
          `<label>What should the agent explain? <textarea name="clarify-note-${index}" rows="2">${field(`clarify-note-${index}`)}</textarea></label>`,
          `<button type="submit" name="clarify" value="${index}" formnovalidate>Ask for clarification</button></details>`);
      }
    } else if (b.level === 1 && item.policy) {
      parts.push('<details class="notice-object"><summary>Disagree? Flag for reversal</summary>',
        `<label>Why should this decision be reversed? <textarea name="reverse-reason-${index}" rows="2">${field(`reverse-reason-${index}`)}</textarea></label>`,
        `<button type="submit" name="reverse-notice" value="${index}" formnovalidate>Flag for reversal</button></details>`);
    }
    parts.push("</article>");
    return parts.join("\n");
  });
  const defaults = (review.default_notices ?? []).map((item) => {
    const label = item.option_label ? `${item.option_label} (${item.option})` : `Option ${item.option}`;
    const heading = item.conflict ? "Late answer conflicts with the applied default" : "Applied by default: change?";
    const undo = item.undo ? `<p class="muted">One-step undo: ${escapeText(item.undo)}</p>` : "";
    const ref = `${item.request_id}@${item.revision}`;
    const alts = (item.options ?? []).filter((o) => o.id !== item.option).map((o) =>
      `<button type="submit" name="default-action" value="switch:${escapeText(ref)}:${escapeText(o.id)}" class="button-secondary" formnovalidate>Switch to ${escapeText(o.label)}</button>`).join("");
    return `<section class="default-notice"><p class="preserve"><strong>${escapeText(heading)}</strong> ${escapeText(item.question)} — ${escapeText(label)}.</p>${undo}<div class="form-actions"><button type="submit" name="default-action" value="keep:${escapeText(ref)}:${escapeText(item.option)}" class="button-secondary" formnovalidate>Keep default</button>${alts}</div></section>`;
  });
  const questionCount = review.items.filter((i) => i.body.kind !== "notice").length;
  const noticeCount = review.items.length - questionCount;
  const countText = noticeCount > 0 && questionCount > 0
    ? `${questionCount} ${questionCount === 1 ? "decision" : "decisions"} · ${noticeCount} ${noticeCount === 1 ? "notice" : "notices"}`
    : `${review.items.length} ${review.items.length === 1 ? "request" : "requests"}`;
  const previewBlock = opts.previewLines?.length
    ? `<section class="combined-summary" role="status"><h3>Combined plan check</h3><ul>${opts.previewLines.map((l) => `<li>${escapeText(l)}</li>`).join("")}</ul></section>`
    : "";
  const statusBanner = opts.statusMessage ? `<p role="status">${escapeText(opts.statusMessage)}</p>` : "";
  const videoScript = reviewHasVideoComparison(review) ? `<script>${playComparisons}</script>` : "";
  return page("Review", `<h1>Review</h1><p class="count">${countText}</p>
    ${review.pinContext ? pinForm(review.pinContext.returnTo) : ""}${pinnedDecisionsHtml(review.pinContext)}
    ${review.sourceHistoryPath ? `<p><a href="${escapeText(review.sourceHistoryPath)}">View source review</a></p>` : ""}
    ${contextHtml(review.follow_up && review.intent ? { ...review, intent: { ...review.intent, already_done: undefined } } : review)}
    ${statusBanner}${message ? `<p role="alert" class="error">${escapeText(message)}</p>` : ""}
    <form method="post"><input type="hidden" name="presentation" value="${escapeText(token)}">
    ${defaults.join("")}${previewBlock}${cards.join("")}
    <div class="form-actions">
      <button type="submit" name="preview" value="1" class="button-secondary">Check combined plan</button>
      <button type="submit">${opts.previewLines?.length ? "Confirm and save" : "Save answers"}</button>
    </div></form>${videoScript}`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="${themeColor}">
    <title>${escapeText(title)} · UTP</title><style>${reviewStyle}</style></head>
    <body><main><div class="brand">UTP</div>${body}</main></body></html>`;
}
