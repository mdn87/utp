import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { reviewRequestsHash } from "../core/check.js";
import { Engine } from "../core/engine.js";
import { previousDecision, type HistoryReview } from "../core/review-history.js";
import { EXIT, type Actor } from "../core/types.js";
import type { ReviewView } from "../cli/render.js";
import { cardPinControl, escapeText, page, pinForm, type PinContext } from "./review-html.js";
import { answerable, type ReviewPages, sendHtml } from "./review-page.js";
import type { ProjectInfo, Service } from "./service.js";

export function historySearch(query = ""): string {
  return `<form action="/history" method="get" class="history-search" role="search">
    <label for="history-query">Find a past review</label><div><input id="history-query" name="q" type="search"
    placeholder="Title, question, or tag" value="${escapeText(query)}"><button type="submit">Search reviews</button></div></form>`;
}

const reviewPath = (project: string, review: string) => `/history/${encodeURIComponent(project)}/${encodeURIComponent(review)}`;

function historyDetail(context: PinContext, saved: HistoryReview, view: ReviewView, form?: URLSearchParams, error?: string): string {
  const { project, returnTo: target } = context;
  const title = saved.task_title || saved.review_id;
  const checked = new Set(form?.getAll("card"));
  const cards = saved.cards.map((card, i) => {
    const item = view.items[i]!;
    const body = item.body;
    const options = body.options?.map(o => `<li><strong>${escapeText(o.label)}</strong> — ${escapeText(o.consequence)}</li>`).join("");
    return `<article class="history-card" id="${escapeText(card.ref)}"><label class="history-pick"><input type="checkbox" name="card" value="${escapeText(card.ref)}"${checked.has(card.ref) ? " checked" : ""}>
      <strong>${escapeText(card.question)}</strong></label><p class="preserve">${escapeText(previousDecision(card))}</p>
      ${body.summary ? `<p class="muted">${escapeText(body.summary)}</p>` : ""}
      ${options ? `<details><summary>Original choices</summary><ul>${options}</ul></details>` : ""}
      ${cardPinControl(context, item.id, item.revision, item.answer)}</article>`;
  }).join("");
  const src = saved.source_review;
  const open = saved.cards.some(c => answerable(c.status)) ?
    `<form method="post" action="/open/${encodeURIComponent(project)}/${encodeURIComponent(saved.review_id)}"><button>Answer open cards</button></form>` : "";
  return page(title, `<nav><a href="/history">Review history</a> · <a href="/">Inbox</a></nav><h1>${escapeText(title)}</h1>
    ${src ? `<p><a href="${reviewPath(project, src)}">View source review</a></p>` : ""}
    ${view.intent?.already_done ? `<p class="preserve">${escapeText(view.intent.already_done)}</p>` : ""}${open}
    ${pinForm(target)}<form method="post" action="${target}/follow-up">
    <input type="hidden" name="submission" value="${randomUUID()}">
    <input type="hidden" name="version" value="${reviewRequestsHash(saved.cards)}">
    <fieldset><legend>Select cards for a follow-up</legend>${error ? `<p role="alert" class="error">${escapeText(error)}</p>` : ""}${cards}</fieldset>
    <label>Follow-up title <span class="muted">(optional)</span><input type="text" name="title" maxlength="80" value="${escapeText(form?.get("title") ?? "")}"></label>
    <label>New ideas <span class="muted">(optional, one per line)</span><textarea name="ideas" rows="3">${escapeText(form?.get("ideas") ?? "")}</textarea></label>
    <button type="submit">Start follow-up</button></form>`);
}

export async function handleHistory(req: IncomingMessage, res: ServerResponse, service: Service, pages: ReviewPages,
  readBody: (req: IncomingMessage) => Promise<string | undefined>, actor: Actor, label: (project: ProjectInfo) => string): Promise<void> {
  const url = new URL(req.url!, pages.origin);
  if (url.pathname === "/history" && req.method === "GET") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    const results: { project: ProjectInfo; review: HistoryReview }[] = [];
    for (const project of service.projects()) {
      const engine = service.engine(project.id);
      if (!(engine instanceof Engine)) return sendHtml(res, 503, page("Review history", "<h1>Review history is unavailable</h1>"));
      for (const review of engine.searchHistory(query)) results.push({ project, review });
    }
    results.sort((a, b) => b.review.updated_at.localeCompare(a.review.updated_at) || b.review.review_id.localeCompare(a.review.review_id));
    const size = 20;
    const last = Math.max(1, Math.ceil(results.length / size));
    const pageNumber = Math.min(last, Math.max(1, parseInt(url.searchParams.get("page") ?? "", 10) || 1));
    const pager = (n: number, text: string) => `<a href="/history?q=${encodeURIComponent(query)}&amp;page=${n}">${text}</a>`;
    const rows = results.slice((pageNumber - 1) * size, pageNumber * size).map(({ project, review }) => {
      const title = review.task_title || review.cards[0]?.question || review.review_id;
      const count = review.cards.length;
      return `<article><h2><a href="${reviewPath(project.id, review.review_id)}">${escapeText(title)}</a></h2>
        <p class="inbox-meta">${escapeText(label(project))} · ${count} ${count === 1 ? "card" : "cards"} · ${escapeText(review.updated_at.slice(0, 10))}</p></article>`;
    }).join("");
    return sendHtml(res, 200, page("Review history", `<a href="/">Inbox</a><h1>Review history</h1>${historySearch(query)}
      ${rows || '<p class="empty">No saved reviews match.</p>'}<nav class="form-actions">
      ${pageNumber > 1 ? pager(pageNumber - 1, "Previous page") : ""}${pageNumber < last ? pager(pageNumber + 1, "Next page") : ""}</nav>`));
  }
  const route = /^\/history\/(prj-[a-f0-9]{12})\/(V-[A-Za-z0-9-]+)(\/follow-up)?$/.exec(url.pathname);
  const missing = () => sendHtml(res, 404, page("Review history", '<h1>Saved review not found</h1><a href="/history">Review history</a>'));
  if (!route || req.method !== (route[3] ? "POST" : "GET")) return missing();
  if (route[3] && req.headers.origin !== pages.origin.origin) return sendHtml(res, 403, page("Review unavailable", "<h1>Review unavailable</h1>"));
  const project = route[1]!;
  const id = route[2]!;
  const engine = service.engine(project);
  if (!(engine instanceof Engine)) {
    if (engine.code === EXIT.NOT_FOUND) return missing();
    return sendHtml(res, 503, page("Review unavailable", "<h1>Review unavailable</h1>"));
  }
  const render = (status: number, form?: URLSearchParams, error?: string) => {
    const saved = engine.historyReview(id);
    if (!saved) return missing();
    const shown = engine.run("show", { id }, actor).review as ReviewView;
    sendHtml(res, status, historyDetail({ project, pins: engine.decisionPins(), returnTo: reviewPath(project, id) }, saved, shown, form, error));
  };
  if (!route[3]) return render(200);
  const raw = await readBody(req);
  if (raw === undefined) return render(413, undefined, "The follow-up is too large.");
  const form = new URLSearchParams(raw);
  const submission = form.get("submission") ?? "";
  if (!/^[\da-f-]{36}$/.test(submission) || !form.get("version")) return render(400, form, "Open the saved review to start a follow-up.");
  const ideas = (form.get("ideas") ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const result = engine.run("follow-up", { review: id, version: form.get("version"), cards: form.getAll("card"),
    title: form.get("title") ?? "", ideas }, actor, `inbox-follow-up:${id}:${submission}`);
  if (result.code === EXIT.NOT_FOUND) return missing();
  if (result.code !== EXIT.OK) return render(result.code === EXIT.NOT_ALLOWED ? 409 : 400, form, result.message);
  const opened = pages.prepare(project, actor, result.review_id, true);
  const location = opened.code === EXIT.OK ? new URL(String(opened.url)).pathname : reviewPath(project, String(result.review_id));
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}
