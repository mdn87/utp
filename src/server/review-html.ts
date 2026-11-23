import { createHash } from "node:crypto";
import type { ReviewView } from "../cli/render.js";
import type { BlindReveal } from "../core/blind.js";
import { itemPrompts } from "../core/items.js";
import { CLARITY_FEEDBACK, SURENESS } from "../core/types.js";

const playComparisons = `document.addEventListener("click", (event) => {
  const pair = event.target instanceof Element && event.target.closest("[data-play-comparison]")?.closest("article");
  if (!pair) return;
  for (const video of pair.querySelectorAll(".compare video")) {
    video.currentTime = 0;
    video.play().catch(() => {});
  }
});`;
export const comparisonScriptHash = createHash("sha256").update(playComparisons).digest("base64");

const css = `
:root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; color: #183028; background: #f1f5f0; }
body { margin: 0; }
main { max-width: 56rem; margin: auto; padding: 3rem clamp(1rem, 5vw, 3.5rem); }
h1 { font-size: clamp(2rem, 6vw, 3.7rem); margin: 0 0 .25rem; letter-spacing: -.045em; }
h2 { font-size: clamp(1.3rem, 4vw, 1.9rem); line-height: 1.25; margin: 0; }
h3 { font-size: 1rem; margin-bottom: .4rem; }
p, dl { margin: .65rem 0; }
dd { margin: 0 0 .45rem; }
dt { font-weight: 700; }
article { background: white; border: 1px solid #cbd8cd; border-radius: 1rem; padding: clamp(1rem, 4vw, 2rem); margin: 1rem 0; }
.muted { color: #4c675b; }
.preserve { white-space: pre-wrap; overflow-wrap: anywhere; }
figure { margin: 1rem 0; }
.compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: clamp(.45rem, 2vw, 1.25rem); }
.compare figure { min-width: 0; border: 1px solid #cbd8cd; border-radius: .65rem; padding: clamp(.5rem, 2vw, 1rem); }
.compare img, .compare video { display: block; width: 100%; height: auto; }
figcaption { font-weight: 700; margin-bottom: .4rem; }
pre { padding: 1rem; border-radius: .65rem; background: #eef3ee; white-space: pre-wrap; overflow-wrap: anywhere; }
img { max-width: 100%; max-height: 36rem; object-fit: contain; border-radius: .65rem; }
fieldset { border: 0; padding: 0; margin: 1rem 0; }
legend { padding: 0; font-weight: 700; }
.option { display: flex; align-items: start; gap: .65rem; border: 1px solid #cbd8cd; border-radius: .6rem; padding: .75rem; margin: .5rem 0; }
.option:has(input:checked) { border-color: #1c6c4a; background: #eaf5ed; }
input { accent-color: #1c6c4a; margin-top: .3rem; }
textarea { font: inherit; width: 100%; box-sizing: border-box; margin: .35rem 0; border: 1px solid #9fb5a6; border-radius: .45rem; padding: .6rem; }
.ratings { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; }
.ratings label { display: grid; gap: .25rem; }
select { font: inherit; color: inherit; background: white; border: 1px solid #9fb5a6; border-radius: .45rem; padding: .4rem; }
button { color: white; background: #175c40; border: 0; border-radius: .55rem; padding: .8rem 1.25rem; font: inherit; font-weight: 700; }
button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #27714e; outline-offset: 2px; }
.error { border-left: .25rem solid #a23822; padding-left: .8rem; }
`;

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function notice(text: string): string {
  return `<p class="preserve">${escapeText(text)}</p>`;
}

export function blindRevealHtml(reveal: BlindReveal, question: string): string {
  return `<article><h2>${escapeText(question)}</h2><dl><dt>Candidate A</dt><dd>${escapeText(reveal.identities.a)}</dd>
    ${reveal.notes?.a ? `<dd>${escapeText(reveal.notes.a)}</dd>` : ""}
    <dt>Candidate B</dt><dd>${escapeText(reveal.identities.b)}</dd>
    ${reveal.notes?.b ? `<dd>${escapeText(reveal.notes.b)}</dd>` : ""}</dl>`
    + (reveal.recommendation ? notice(`The recommendation was Candidate ${reveal.recommendation.toUpperCase()}.`) : "") + "</article>";
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
    const previews = (Array.isArray(b.previews) ? b.previews : []).map((preview) => {
      const label = escapeText(preview.label);
      const content = "text" in preview
        ? `<pre>${escapeText(preview.text)}</pre>`
        : preview.media_type === "video/mp4"
          ? `<video controls muted playsinline preload="metadata" aria-label="${label}" src="data:video/mp4;base64,${escapeText(preview.data)}"></video>`
          : `<img src="data:${escapeText(preview.media_type)};base64,${escapeText(preview.data)}" alt="${label}">`;
      return `<figure><figcaption>${label}</figcaption>${content}</figure>`;
    });
    if (b.kind === "judge") {
      parts.push(`<div class="compare">${previews.join("")}</div>`);
      if (b.previews?.every((preview) => "media_type" in preview && preview.media_type === "video/mp4")) {
        parts.push('<button type="button" data-play-comparison>Play both from the start</button>');
      }
    }
    else parts.push(...previews);
    for (const step of Array.isArray(b.steps) ? b.steps : []) {
      parts.push(notice(`${step.id} · ${step.actor} on ${step.machine} using ${step.shell}\n${step.command}\nExpect ${step.expected_result}.\n${step.tested ? "Tested in this shell." : "This step needs a shell check."}\n${step.why_person}`));
    }
    for (const goal of Array.isArray(b.goals) ? b.goals : []) {
      parts.push(notice(`${goal.goal} · ${goal.coverage.replaceAll("_", " ")}`));
      for (const evidence of goal.evidence) parts.push(notice(`${evidence.claim} (${evidence.source}, ${evidence.date})`));
    }
    for (const assumption of Array.isArray(b.assumptions) ? b.assumptions : []) parts.push(notice(`${assumption.statement}. ${assumption.consequence}`));
    if (b.notes) parts.push(notice(b.notes));
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
      if (b.kind === "judge") {
        const scores = ["1", "2", "3", "4", "5"].map((score) => [score, score] as const);
        parts.push(`<div class="ratings">${rating(`rating-a-${index}`, "Rate Candidate A", scores)}
          ${rating(`rating-b-${index}`, "Rate Candidate B", scores)}
          ${rating(`repeat-${index}`, "Would you run this test again?", [["yes", "Yes"], ["no", "No"]])}</div>`,
          `<label>Reason (optional) <textarea name="reason-${index}" rows="3">${field(`reason-${index}`)}</textarea></label>`);
      } else {
        parts.push(`<label>Your own answer <textarea name="custom-${index}" rows="2">${field(`custom-${index}`)}</textarea></label>`);
      }
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
  return page("Review", `<h1>Review</h1><p class="muted">${review.items.length} requests</p>
    ${defaults.join("")}${message ? `<p role="alert" class="error">${escapeText(message)}</p>` : ""}
    <form method="post"><input type="hidden" name="presentation" value="${escapeText(token)}">
    ${cards.join("")}<button type="submit">Save answers</button></form><script>${playComparisons}</script>`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeText(title)} · UTP</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}
