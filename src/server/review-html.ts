import type { ReviewView } from "../cli/render.js";
import { itemPrompts } from "../core/items.js";
import { waiverNotes } from "../core/quality.js";
import { CLARITY_FEEDBACK, SURENESS } from "../core/types.js";
import { reviewStyle, themeColor } from "./review-style.js";

export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function notice(text: string): string {
  return `<p class="preserve">${escapeText(text)}</p>`;
}

export function reviewHtml(review: ReviewView, token: string, message?: string, form?: URLSearchParams): string {
  const field = (name: string): string => escapeText(form?.get(name) ?? "");
  const checked = (name: string, value: string): string => form?.get(name) === value ? " checked" : "";
  const rating = (name: string, label: string, choices: readonly (readonly [string, string])[]): string =>
    `<label>${label}<select name="${name}"><option value="">Optional</option>${choices.map(([value, text]) =>
      `<option value="${value}"${form?.get(name) === value ? " selected" : ""}>${text}</option>`).join("")}</select></label>`;
  const cards = review.items.map((item, index) => {
    const b = item.body;
    const parts = [`<article><h2>${escapeText(b.question)}</h2>`];
    if (b.kind !== "notice") parts.push("<h3>What this question addresses</h3>");
    parts.push(notice(b.summary ?? b.why_now));
    if (b.summary && b.summary !== b.why_now) parts.push("<h3>Why now</h3>", notice(b.why_now));
    if (item.clarification) parts.push('<p role="status">Clarification requested. The agent will see it when it checks this question.</p>');
    if (b.depends_on?.length) parts.push(notice(`This question depends on ${b.depends_on.join(" and ")}.`));
    if (Object.keys(b.glossary ?? {}).length) parts.push("<dl>", ...Object.entries(b.glossary ?? {}).map(([term, meaning]) =>
      `<dt>${escapeText(term)}</dt><dd>${escapeText(meaning)}</dd>`), "</dl>");
    for (const preview of Array.isArray(b.previews) ? b.previews : []) {
      const content = "text" in preview
        ? `<pre>${escapeText(preview.text)}</pre>`
        : `<img src="data:${escapeText(preview.media_type)};base64,${escapeText(preview.data)}" alt="${escapeText(preview.label)}">`;
      parts.push(`<figure><figcaption>${escapeText(preview.label)}</figcaption>${content}</figure>`);
    }
    for (const step of Array.isArray(b.steps) ? b.steps : []) {
      parts.push(notice(`${step.id} · ${step.actor} on ${step.machine} using ${step.shell}\n${step.command}\nExpect ${step.expected_result}.\n${step.tested ? "Tested in this shell." : "This step needs a shell check."}\n${step.why_person}`));
    }
    for (const goal of Array.isArray(b.goals) ? b.goals : []) {
      parts.push(notice(`${goal.goal} · ${goal.coverage.replaceAll("_", " ")}`));
      for (const evidence of goal.evidence) parts.push(notice(`${evidence.claim} (${evidence.source}, ${evidence.date})`));
    }
    for (const assumption of Array.isArray(b.assumptions) ? b.assumptions : []) parts.push(notice(`${assumption.statement}. ${assumption.consequence}`));
    if (b.notes) parts.push(notice(b.notes));
    if (b.narrowing_reason) parts.push(notice("Why the action cannot be split: " + b.narrowing_reason));
    for (const explanation of waiverNotes(b)) parts.push(notice(explanation));
    for (const evidence of b.evidence ?? []) parts.push(notice(`${evidence.claim} (${evidence.kind}, ${evidence.source}, ${evidence.date})`));
    if (b.recommendation) {
      const rec = b.recommendation;
      const label = b.options?.find((option) => option.id === rec.option)?.label ?? rec.option;
      parts.push(notice([`Recommended option is ${label}. ${rec.because}`,
        rec.preserves && `It preserves ${rec.preserves}`, rec.bolder_alternative && `A bolder alternative is ${rec.bolder_alternative}`]
        .filter(Boolean).join("\n")));
    }
    if (b.default) parts.push(notice(`Stated default ${b.default.option}. ${b.default.consequence}`));
    for (const flag of item.flags) parts.push(notice(flag));
    if (b.kind !== "notice") {
      for (const [n, prompt] of itemPrompts(b).entries()) {
        parts.push(`<fieldset><legend>${escapeText(prompt.label)}</legend>`, ...prompt.choices.map((choice) =>
          `<label class="option"><input type="radio" name="item-${index}-${n}" value="${escapeText(choice)}"${checked(`item-${index}-${n}`, choice)}>${escapeText(choice.replaceAll("_", " "))}</label>`));
        if (prompt.detailLabel) parts.push(`<label>${escapeText(prompt.detailLabel)}<textarea name="detail-${index}-${n}" rows="2">${field(`detail-${index}-${n}`)}</textarea></label>`);
        parts.push("</fieldset>");
      }
      if (b.options?.length) parts.push('<fieldset><legend>Choose an option</legend>', ...b.options.map((option) => {
        const authority = option.authorization;
        const scope = authority ? `<span class="muted">${escapeText(
          `${authority.action} on ${authority.target}. Scope is ${authority.scope}.`
            + (authority.expected_effect ? ` Expected result is ${authority.expected_effect}.` : ""))}</span>` : "";
        return `<label class="option"><input type="radio" name="choice-${index}" value="${escapeText(option.id)}"${checked(`choice-${index}`, option.id)}><span><strong>${escapeText(option.label)}</strong><br>${escapeText(option.consequence)}${scope ? "<br>" + scope : ""}</span></label>`;
      }), "</fieldset>");
      parts.push(`<label>Your own answer <textarea name="custom-${index}" rows="2">${field(`custom-${index}`)}</textarea></label>`);
      const sureness = rating(`sureness-${index}`, "How sure are you?", SURENESS.map((choice) =>
        [choice, choice.charAt(0).toUpperCase() + choice.slice(1)]));
      const clarity = rating(`feedback-${index}`, "How clear was this card?", Object.entries(CLARITY_FEEDBACK));
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
  const count = review.items.length;
  return page("Review", `<h1>Review</h1><p class="count">${count} ${count === 1 ? "request" : "requests"}</p>
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
