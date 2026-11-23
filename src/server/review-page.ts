import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewView } from "../cli/render.js";
import { Engine, type BrowserAnswer } from "../core/engine.js";
import { itemPrompts } from "../core/items.js";
import { EXIT, type Actor, type ClarificationRequest, type OpResult } from "../core/types.js";
import { page, reviewHtml } from "./review-html.js";
import { linkKey, ReviewLinks, token } from "./review-links.js";
import type { Service } from "./service.js";

const reviewPath = /^\/review\/([A-Za-z0-9_-]{32})$/;
export const answerable = (status: string): boolean => ["queued", "presented", "default_claimed"].includes(status);

export function sendHtml(response: ServerResponse, code: number, html: string, cookie?: string): void {
  response.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
  response.end(html);
}

function choices(view: ReviewView, form: URLSearchParams): BrowserAnswer[] {
  return view.items.flatMap<BrowserAnswer>((card, index) => {
    if (card.body.kind === "notice") return [];
    const ref = {
      id: card.id,
      revision: card.revision,
      sureness: form.get(`sureness-${index}`) || undefined,
      feedback: form.get(`feedback-${index}`) || undefined,
    };
    const custom = form.get(`custom-${index}`)?.trim();
    if (custom) return [{ ...ref, custom }];
    const prompts = itemPrompts(card.body);
    if (prompts.length) {
      const items = Object.fromEntries(prompts.map(({ id }, n) => [id, form.get(`item-${index}-${n}`) ?? ""]));
      const details = Object.fromEntries(prompts.flatMap(({ id }, n) => {
        const text = form.get(`detail-${index}-${n}`)?.trim();
        return text ? [[id, text]] : [];
      }));
      return [{ ...ref, items, details }];
    }
    return [{ ...ref, value: form.get(`choice-${index}`) ?? undefined }];
  });
}

export class ReviewPages {
  private readonly links: ReviewLinks;
  constructor(readonly origin: URL, private readonly service: Service, private readonly now: () => number, private readonly hasInbox: boolean) {
    this.links = new ReviewLinks(service.dataDir, now);
  }

  prepare(project: string, actor: Actor, reviewId: unknown, requireQuestion = false): OpResult {
    if (typeof reviewId !== "string") return { code: EXIT.OTHER, message: "a review id is required" };
    const engine = this.service.engine(project);
    if (!(engine instanceof Engine)) return engine;
    const shown = engine.run("show", { id: reviewId }, actor);
    if (shown.code !== EXIT.OK) return shown;
    const review = shown.review as (ReviewView & { status: string }) | undefined;
    if (review?.status !== "prepared") return { code: EXIT.NOT_ALLOWED, message: "prepare the review with utp flush first" };
    const items = review.items.filter((card) => card.current && answerable(card.status));
    if (!items.length || (requireQuestion && items.every((item) => item.body.kind === "notice"))) {
      return { code: EXIT.NOT_ALLOWED, message: "this review has no unanswered cards" };
    }
    const id = this.links.create({ project, actor, review: review.id, items: items.map(({ id, revision }) => ({ id, revision })) });
    if (!id) return { code: EXIT.BUSY, message: "too many open review pages; try again after one expires" };
    return { code: EXIT.OK, review_id: review.id, url: new URL(`/review/${id}`, this.origin).href };
  }

  async handle(request: IncomingMessage, response: ServerResponse, readBody: (req: IncomingMessage) => Promise<string | undefined>): Promise<void> {
    const denied = () => sendHtml(response, 403, page("Review unavailable", "<h1>Review unavailable</h1><p>Open the review link from the configured UTP address.</p>"));
    if (request.headers.host?.toLowerCase() !== this.origin.host) return denied();
    const path = request.url ?? "";
    const id = reviewPath.exec(path)?.[1];
    if (request.method !== "POST" && request.method !== "GET") return denied();
    let form: URLSearchParams | undefined;
    if (request.method === "POST") {
      if (request.headers.origin !== this.origin.origin || !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return denied();
      const raw = await readBody(request);
      if (raw === undefined) return sendHtml(response, 413, page("Answer too large", "<h1>Answer too large</h1>"));
      form = new URLSearchParams(raw);
    }
    const entry = id && this.links.get(id);
    if (!id || !entry) {
      return sendHtml(response, 404, page("Review expired", "<h1>Review expired</h1>" +
        (this.hasInbox ? this.inboxLink() : "<p>Prepare a fresh review link.</p>")));
    }
    const hasCookie = () => !!entry.browser && request.headers.cookie?.split(";").some((part) => part.trim() === `utp_review=${entry.browser?.cookie}`);
    if (entry.browser && !hasCookie()) return denied();
    if (form && (!entry.browser || form.get("presentation") !== entry.browser.form)) return denied();
    const engine = this.service.engine(entry.project);
    if (!(engine instanceof Engine)) return sendHtml(response, 503, page("Review unavailable", "<h1>Review unavailable</h1>"));
    const saveId = `review-save-${linkKey(id)}`;
    const saved = engine.browserAnswerReceipt(entry.review, saveId);
    if (saved !== undefined) return this.saved(response, saved);
    const shown = engine.run("show", { id: entry.review }, entry.actor).review as ReviewView | undefined;
    const items = entry.items.map((ref) => shown?.items.find((card) => card.id === ref.id && card.revision === ref.revision));
    if (items.some((card) => !card?.current || (!form && card.body.kind !== "notice" && !answerable(card.status)))) {
      return sendHtml(response, 409, page("Review changed", "<h1>Review changed</h1><p>Open a fresh link before answering.</p>" + this.inboxLink()));
    }
    const view: ReviewView = { id: entry.review, items: items.filter((card) => card !== undefined), default_notices: shown?.default_notices };
    if (request.method === "GET") {
      const browser = entry.browser ?? { cookie: token(), form: token(), openedAt: this.now() };
      const html = reviewHtml(view, browser.form);
      const presented = engine.run("presented", { review: view.id, channel: "review-page" }, entry.actor, `review-page-${linkKey(id)}`);
      if (presented.code !== EXIT.OK) return denied();
      const remainingSeconds = Math.ceil((entry.expiresAt - this.now()) / 1000);
      const cookie = entry.browser ? undefined
        : `utp_review=${browser.cookie}; Path=${path}; Max-Age=${remainingSeconds}; HttpOnly; SameSite=Strict${this.origin.protocol === "https:" ? "; Secure" : ""}`;
      if (!entry.browser) this.links.save(id, { ...entry, browser });
      sendHtml(response, 200, html, cookie);
      return;
    }
    if (!form || !entry.browser) return denied();
    const requested = form.get("clarify");
    if (requested !== null) {
      const card = /^\d+$/.test(requested) ? view.items[Number(requested)] : undefined;
      if (!card) return denied();
      const result = engine.run("answer", {
        id: `${card.id}@${card.revision}`, channel: "review-page", clarify: true,
        note: form.get(`clarify-note-${requested}`)?.trim(),
      }, entry.actor);
      if (result.code !== EXIT.OK) {
        return sendHtml(response, 409, reviewHtml(view, entry.browser.form, result.message ?? "This question changed.", form));
      }
      card.clarification = result.clarification as ClarificationRequest;
      return sendHtml(response, 200, reviewHtml(view, entry.browser.form, undefined, form));
    }
    const answers = choices(view, form);
    const result = engine.saveBrowserAnswers(view.id, answers, entry.actor, Math.max(0, this.now() - entry.browser.openedAt), saveId);
    if (result.code !== EXIT.OK) {
      return sendHtml(response, result.code === EXIT.REVOKED ? 409 : 400,
        reviewHtml(view, entry.browser.form, result.message ?? "Review the answers and try again.", form));
    }
    this.saved(response, Number(result.saved));
  }

  private saved(response: ServerResponse, count: number): void {
    sendHtml(response, 200, page("Answers saved", `<h1>Answers saved</h1><p class="receipt">UTP recorded ${count} ${count === 1 ? "answer" : "answers"}.</p>` + this.inboxLink()));
  }

  private inboxLink(): string {
    return this.hasInbox ? '<p><a href="/">Back to the review inbox</a></p>' : "";
  }
}
