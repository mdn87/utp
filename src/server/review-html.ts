import { answerValue, cardMetadata, dependencyLabels, reviewContext, sharedFromIntent, type ReviewView } from "../cli/render.js";
import type { RecordedBrowserAnswer } from "../core/engine.js";
import { itemPrompts } from "../core/items.js";
import { waiverNotes } from "../core/quality.js";
import { CLARITY_FEEDBACK, SURENESS, type RequestBody } from "../core/types.js";
import { reviewStyle, themeColor } from "./review-style.js";

const KIND_LABELS: Record<string, string> = {
  choose: "Choice", approve: "Approval", handoff: "Manual step", clarify: "Clarification",
  accept: "Result check", assumptions: "Assumptions", notice: "Notice",
};
const UNDO_LABELS: Record<string, string> = {
  easy: "Easy to undo", costly: "Costly to undo", one_way: "Can't be undone",
};

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

export function savedHtml(review: ReviewView, answers: RecordedBrowserAnswer[], returnLink: string): string {
  const rows = answers.map(({ id, revision, answer }) => {
    const card = review.items.find(item => item.id === id && item.revision === revision);
    return `<dt>${escapeText(card?.body.question ?? id)}</dt><dd class="preserve">${escapeText(answerValue(answer, card?.body))}</dd>
      <dd class="card-reference">${escapeText(id)}@${revision}</dd>`;
  }).join("");
  const summary = `UTP recorded ${answers.length} ${answers.length === 1 ? "answer" : "answers"}.`;
  return page("Answers saved", `<h1>Answers saved</h1><p class="receipt">${summary}</p>
    ${contextHtml(review)}${rows ? `<dl aria-label="Saved answers">${rows}</dl>` : ""}${returnLink}`);
}

export function reviewHtml(review: ReviewView, token: string, message?: string, form?: URLSearchParams): string {
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
    const kindLabel = KIND_LABELS[b.kind] ?? b.kind;
    const undoLabel = UNDO_LABELS[b.stakes.reversibility] ?? b.stakes.reversibility;
    const stakesClass = b.stakes.reversibility === "one_way" ? "badge-danger" : b.stakes.reversibility === "costly" ? "badge-warn" : "badge-easy";
    const parts = [
      `<article><h2>${escapeText(b.question)}</h2>`,
      `<p class="card-badges"><span class="badge">${escapeText(kindLabel)}</span><span class="badge ${stakesClass}">${escapeText(undoLabel)}</span><span class="badge">Level ${b.level}</span></p>`,
    ];
    if (b.kind !== "notice") parts.push("<h3>What this question addresses</h3>");
    parts.push(notice(b.summary ?? b.why_now));
    if (b.summary && b.summary !== b.why_now) parts.push("<h3>Why now</h3>", notice(b.why_now));
    if (item.clarification) parts.push(item.clarification.outcome === "unsure"
      ? '<p role="status">Confirm the current choice before the agent continues.</p>'
      : '<p role="status">Clarification requested. The agent will see it when it checks this question.</p>');
    for (const dependency of dependencyLabels(b, review.items, review.resolved_dependencies)) parts.push(notice(`Depends on ${dependency}`));
    if (Object.keys(b.glossary ?? {}).length) parts.push("<dl>", ...Object.entries(b.glossary ?? {}).map(([term, meaning]) =>
      `<dt>${escapeText(term)}</dt><dd>${escapeText(meaning)}</dd>`), "</dl>");
    for (const preview of Array.isArray(b.previews) ? b.previews : []) {
      const content = "text" in preview
        ? `<pre>${escapeText(preview.text)}</pre>`
        : `<img src="data:${escapeText(preview.media_type)};base64,${escapeText(preview.data)}" alt="${escapeText(preview.label)}">`;
      parts.push(`<figure><figcaption>${escapeText(preview.label)}</figcaption>${content}</figure>`);
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
      if (b.options?.length) parts.push('<fieldset><legend>Choose an option</legend>', ...b.options.map((option) => {
        const authority = option.authorization;
        const scope = authority ? `<span class="muted">${escapeText(
          `Authorizes: ${authority.action} on ${authority.target} · Scope: ${authority.scope}`
            + (authority.expected_effect ? ` · Expected result: ${authority.expected_effect}` : ""))}</span>` : "";
        const next = option.agent_next ? `<span class="agent-next"><strong>Agent does next:</strong> ${escapeText(option.agent_next)}</span>` : "";
        const recTag = b.recommendation?.option === option.id ? ' <span class="badge badge-rec">Recommended</span>' : "";
        const defTag = b.default?.option === option.id ? ' <span class="badge badge-default">Default if unanswered</span>' : "";
        return `<label class="option"><input type="radio" name="choice-${index}" value="${escapeText(option.id)}"${checked(`choice-${index}`, option.id)}><span><strong>${escapeText(option.label)}</strong> <small class="muted">(${escapeText(option.id)})</small>${recTag}${defTag}<br>${escapeText(option.consequence)}${scope ? "<br>" + scope : ""}${next ? "<br>" + next : ""}</span></label>`;
      }), "</fieldset>");
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
      parts.push(`<label>Your own answer <textarea name="custom-${index}" rows="2">${field(`custom-${index}`)}</textarea></label>`);
      const sureness = chipGroup(`sureness-${index}`, "How sure are you?", SURENESS.map((choice) =>
        [choice, choice.charAt(0).toUpperCase() + choice.slice(1)]));
      const clarity = chipGroup(`feedback-${index}`, "How clear was this card?", Object.entries(CLARITY_FEEDBACK));
      parts.push(`<div class="ratings">${sureness}${clarity}</div>`);
      if (!item.clarification) {
        parts.push('<details><summary>Question or choices unclear?</summary>',
          `<label>What should the agent explain? <textarea name="clarify-note-${index}" rows="2">${field(`clarify-note-${index}`)}</textarea></label>`,
          `<button type="submit" name="clarify" value="${index}" formnovalidate>Ask for clarification</button></details>`);
      }
    }
    parts.push("</article>");
    return parts.join("\n");
  });
  const defaults = (review.default_notices ?? []).map((item) => notice(
    `${item.conflict ? "Late answer conflicts with the applied default" : "Applied by default: change?"} ${item.question} Option ${item.option}.`));
  const questionCount = review.items.filter((i) => i.body.kind !== "notice").length;
  const noticeCount = review.items.length - questionCount;
  const countText = noticeCount > 0 && questionCount > 0
    ? `${questionCount} ${questionCount === 1 ? "decision" : "decisions"} · ${noticeCount} ${noticeCount === 1 ? "notice" : "notices"}`
    : `${review.items.length} ${review.items.length === 1 ? "request" : "requests"}`;
  return page("Review", `<h1>Review</h1><p class="count">${countText}</p>
    ${contextHtml(review)}
    ${defaults.join("")}${message ? `<p role="alert" class="error">${escapeText(message)}</p>` : ""}
    <form method="post"><input type="hidden" name="presentation" value="${escapeText(token)}">
    ${cards.join("")}<button type="submit">Save answers</button></form>`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="${themeColor}">
    <title>${escapeText(title)} · UTP</title><style>${reviewStyle}</style></head>
    <body><main><div class="brand">UTP</div>${body}</main></body></html>`;
}
