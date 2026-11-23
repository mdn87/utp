import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewView } from "../cli/render.js";
import type { BlindReveal } from "../core/blind.js";
import type { BrowserAnswer, Engine } from "../core/engine.js";
import { itemPrompts } from "../core/items.js";
import { EXIT, type Actor, type ClarificationRequest, type OpResult } from "../core/types.js";
import { blindRevealHtml, comparisonScriptHash, page, reviewHtml } from "./review-html.js";

const PAGE_LIFETIME_MS = 30 * 60 * 1000;
const MAX_PREPARED_PAGES = 256;
const token = (): string => randomBytes(24).toString("base64url");
const reviewPath = /^\/review\/([A-Za-z0-9_-]+)$/;

interface Presentation {
  engine: Engine;
  actor: Actor;
  view: ReviewView;
  expiresAt: number;
  browser?: { cookie: string; form: string; openedAt: number };
  saved?: { count: number; ballot: string; reveals: { question: string; reveal: BlindReveal }[] };
}

function sendHtml(response: ServerResponse, code: number, html: string, cookie?: string): void {
  response.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; `
      + `script-src 'sha256-${comparisonScriptHash}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
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
    if (card.body.kind === "judge") {
      const a = form.get(`rating-a-${index}`);
      const b = form.get(`rating-b-${index}`);
      const repeat = form.get(`repeat-${index}`);
      return [{ ...ref, value: form.get(`choice-${index}`) ?? undefined, note: form.get(`reason-${index}`)?.trim(),
        ratings: a || b ? { a: Number(a), b: Number(b) } : undefined,
        repeat_test: repeat === "yes" ? true : repeat === "no" ? false : undefined }];
    }
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
  private readonly pending = new Map<string, Presentation>();

  constructor(private readonly origin: URL) {}

  prepare(engine: Engine, actor: Actor, reviewId: unknown): OpResult {
    if (typeof reviewId !== "string") return { code: EXIT.OTHER, message: "a review id is required" };
    const shown = engine.run("show", { id: reviewId }, actor);
    if (shown.code !== EXIT.OK) return shown;
    const review = shown.review as (ReviewView & { status: string }) | undefined;
    if (review?.status !== "prepared") return { code: EXIT.NOT_ALLOWED, message: "prepare the review with utp flush first" };
    const items = review.items.filter((card) => card.current && ["queued", "presented", "default_claimed"].includes(card.status));
    if (!items.length) return { code: EXIT.NOT_ALLOWED, message: "this review has no unanswered cards" };
    const now = Date.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
    if (this.pending.size >= MAX_PREPARED_PAGES) return { code: EXIT.BUSY, message: "too many open review pages; try again after one expires" };
    const id = token();
    this.pending.set(id, { engine, actor, view: { id: review.id, items, default_notices: review.default_notices }, expiresAt: now + PAGE_LIFETIME_MS });
    return { code: EXIT.OK, review_id: review.id, url: new URL(`/review/${id}`, this.origin).href };
  }

  async handle(request: IncomingMessage, response: ServerResponse, readBody: (req: IncomingMessage) => Promise<string | undefined>): Promise<void> {
    const denied = () => sendHtml(response, 403, page("Review unavailable", "<h1>Review unavailable</h1><p>Open the review link from the configured UTP address.</p>"));
    if (request.headers.host?.toLowerCase() !== this.origin.host) return denied();
    const path = request.url ?? "";
    const id = reviewPath.exec(path)?.[1];
    const entry = id && this.pending.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      return sendHtml(response, 404, page("Review expired", "<h1>Review expired</h1><p>Prepare a fresh review link.</p>"));
    }
    const hasCookie = () => !!entry.browser && request.headers.cookie?.split(";").some((part) => part.trim() === `utp_review=${entry.browser?.cookie}`);
    if (request.method === "GET") {
      if (entry.browser && !hasCookie()) return denied();
      if (entry.saved) return this.saved(response, entry.saved);
      const shown = entry.engine.run("show", { id: entry.view.id }, entry.actor);
      const current = (shown.review as ReviewView | undefined)?.items ?? [];
      if (entry.view.items.some((card) => !current.some((candidate) => candidate.id === card.id && candidate.revision === card.revision
        && candidate.current && (candidate.body.kind === "notice" || ["queued", "presented", "default_claimed"].includes(candidate.status))))) {
        return sendHtml(response, 409, page("Review changed", "<h1>Review changed</h1><p>Prepare a fresh link before answering.</p>"));
      }
      const browser = entry.browser ?? { cookie: token(), form: token(), openedAt: performance.now() };
      const html = reviewHtml(entry.view, browser.form);
      const presented = entry.engine.run("presented", { review: entry.view.id, channel: "review-page" }, entry.actor, `review-page-${id}`);
      if (presented.code !== EXIT.OK) return denied();
      const cookie = entry.browser ? undefined
        : `utp_review=${browser.cookie}; Path=${path}; HttpOnly; SameSite=Strict${this.origin.protocol === "https:" ? "; Secure" : ""}`;
      entry.browser = browser;
      sendHtml(response, 200, html, cookie);
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== this.origin.origin || !hasCookie()) return denied();
    if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return denied();
    const raw = await readBody(request);
    if (raw === undefined) return sendHtml(response, 413, page("Answer too large", "<h1>Answer too large</h1>"));
    const form = new URLSearchParams(raw);
    if (form.get("presentation") !== entry.browser?.form) return denied();
    const requested = form.get("clarify");
    if (requested !== null) {
      if (entry.saved) return this.saved(response, entry.saved);
      const card = /^\d+$/.test(requested) ? entry.view.items[Number(requested)] : undefined;
      if (!card) return denied();
      const result = entry.engine.run("answer", {
        id: `${card.id}@${card.revision}`, channel: "review-page", clarify: true,
        note: form.get(`clarify-note-${requested}`)?.trim(),
      }, entry.actor);
      if (result.code !== EXIT.OK) {
        return sendHtml(response, 409, reviewHtml(entry.view, entry.browser.form, result.message ?? "This question changed.", form));
      }
      card.clarification = result.clarification as ClarificationRequest;
      return sendHtml(response, 200, reviewHtml(entry.view, entry.browser.form, undefined, form));
    }
    const answers = choices(entry.view, form);
    const judges = new Set(entry.view.items.filter((card) => card.body.kind === "judge").map((card) => card.id));
    const ballot = JSON.stringify(answers.filter(({ id }) => judges.has(id)));
    if (entry.saved) {
      if (ballot !== entry.saved.ballot) {
        return sendHtml(response, 409, page("Ballot already saved", "<h1>Ballot already saved</h1><p>The original choices still apply.</p>"));
      }
      return this.saved(response, entry.saved);
    }
    const result = entry.engine.saveBrowserAnswers(entry.view.id, answers, entry.actor,
      Math.round(performance.now() - entry.browser.openedAt));
    if (result.code !== EXIT.OK) {
      return sendHtml(response, result.code === EXIT.REVOKED ? 409 : 400,
        reviewHtml(entry.view, entry.browser.form, result.message ?? "Review the answers and try again.", form));
    }
    const stored = judges.size ? entry.engine.run("show", { id: entry.view.id }, entry.actor).review as ReviewView : undefined;
    const reveals = stored?.items.flatMap((card) => judges.has(card.id) && card.blind_reveal
      ? [{ question: card.body.question, reveal: card.blind_reveal }] : []) ?? [];
    entry.saved = { count: Number(result.saved), ballot, reveals };
    this.saved(response, entry.saved);
  }

  private saved(response: ServerResponse, result: NonNullable<Presentation["saved"]>): void {
    const { count, reveals } = result;
    sendHtml(response, 200, page("Answers saved", `<h1>Answers saved</h1><p>UTP recorded ${count} ${count === 1 ? "answer" : "answers"}.</p>`
      + reveals.map(({ question, reveal }) => blindRevealHtml(reveal, question)).join("")));
  }
}
