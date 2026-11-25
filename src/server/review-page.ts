import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewView } from "../cli/render.js";
import { Engine, type BrowserAnswer } from "../core/engine.js";
import { itemPrompts } from "../core/items.js";
import { EXIT, type Actor, type ClarificationRequest, type Disposition, type OpResult } from "../core/types.js";
import { cardHasAuthorization, editReviewHtml, page, pickupStatusHtml, reviewHtml, savedHtml } from "./review-html.js";
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

function tomorrowMorningIso(nowMs: number): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

interface ParsedBatch {
  answers: BrowserAnswer[];
  leftOpen: string[];
  previewLines: string[];
  error?: string;
}

function parseBatchForm(view: ReviewView, form: URLSearchParams, nowMs: number): ParsedBatch {
  const answers: BrowserAnswer[] = [];
  const leftOpen: string[] = [];
  const previewLines: string[] = [];
  const chosenByRef = new Map<string, string>();
  const pendingCards: { index: number; card: ReviewView["items"][number] }[] = [];

  for (const [index, card] of view.items.entries()) {
    if (card.body.kind === "notice") continue;
    const ref = {
      id: card.id,
      revision: card.revision,
      sureness: form.get(`sureness-${index}`) || undefined,
      feedback: form.get(`feedback-${index}`) || undefined,
    };
    const action = form.get(`action-${index}`)?.trim() ?? "";
    if (action === "hide") {
      const until = tomorrowMorningIso(nowMs);
      answers.push({ ...ref, hide_until: until });
      previewLines.push(`Hide until tomorrow: ${card.body.question}`);
      continue;
    }
    if (action === "answered_elsewhere" || action === "no_longer_matters") {
      answers.push({ ...ref, disposition: action as Disposition });
      previewLines.push(`${action.replaceAll("_", " ")}: ${card.body.question}`);
      continue;
    }

    const custom = form.get(`custom-${index}`);
    const hasCustom = !!custom?.trim();
    const hasAuth = cardHasAuthorization(card.body);
    const choice = form.get(`choice-${index}`)?.trim() ?? "";
    const note = hasAuth ? undefined : (form.get(`note-${index}`)?.trim() || undefined);
    const prompts = itemPrompts(card.body);

    if (hasAuth && hasCustom) {
      answers.push({ ...ref, clarify_note: custom!.trim() });
      previewLines.push(`Approval withheld pending clarification: ${card.body.question} ("${custom!.trim()}")`);
      continue;
    }

    if (prompts.length) {
      const chosenItems = prompts.map(({ id }, n) => [id, form.get(`item-${index}-${n}`) ?? ""] as const);
      const anySelected = chosenItems.some(([, v]) => v.trim() !== "");
      if (!anySelected && !hasCustom) {
        pendingCards.push({ index, card });
        continue;
      }
      if (hasCustom && !anySelected) {
        answers.push({ ...ref, custom: custom! });
        previewLines.push(`Custom reply on "${card.body.question}": "${custom!.trim()}"`);
        continue;
      }
      if (hasCustom && anySelected) {
        return { answers: [], leftOpen: [], previewLines: [],
          error: `Card ${index + 1} has both item selections and "Your own answer". Clear one before saving.` };
      }
      const items = Object.fromEntries(chosenItems);
      const details = Object.fromEntries(prompts.flatMap(({ id }, n) => {
        const text = form.get(`detail-${index}-${n}`);
        return text?.trim() ? [[id, text]] : [];
      }));
      answers.push({ ...ref, items, details, ...(note ? { note } : {}) });
      previewLines.push(`Saved items for "${card.body.question}": ${Object.entries(items).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      continue;
    }

    if (choice === "__custom__") {
      if (!hasCustom) {
        return { answers: [], leftOpen: [], previewLines: [],
          error: `Card ${index + 1} selected "Your own answer" with no text. Enter your answer or pick a listed option.` };
      }
      answers.push({ ...ref, custom: custom! });
      previewLines.push(`Your own answer for "${card.body.question}": "${custom!.trim()}"`);
      continue;
    }

    if (choice && hasCustom) {
      return { answers: [], leftOpen: [], previewLines: [],
        error: `Card ${index + 1} has both a selected option and "Your own answer". Clear one or move your comment to the optional note box.` };
    }

    if (hasCustom) {
      answers.push({ ...ref, custom: custom! });
      previewLines.push(`Your own answer for "${card.body.question}": "${custom!.trim()}"`);
      continue;
    }

    if (choice) {
      answers.push({ ...ref, value: choice, ...(note ? { note } : {}) });
      chosenByRef.set(card.id, choice);
      chosenByRef.set(`${card.id}@${card.revision}`, choice);
      if (card.body.id) chosenByRef.set(card.body.id, choice);
      const opt = card.body.options?.find((o) => o.id === choice);
      if (opt?.authorization) {
        const a = opt.authorization;
        previewLines.push(`Authorizes ${a.action} on ${a.target} (scope: ${a.scope}) — ${card.body.question}`);
      } else {
        previewLines.push(`Sets "${opt?.label ?? choice}" (${choice}) — ${card.body.question}`);
      }
      continue;
    }

    pendingCards.push({ index, card });
  }

  for (const { card } of pendingCards) {
    const matched = (card.body.skip_if ?? []).find((rule) => chosenByRef.get(rule.card) === rule.option);
    if (matched) {
      const reason = matched.reason ?? `Skipped because ${matched.card} chose ${matched.option}.`;
      answers.push({ id: card.id, revision: card.revision, disposition: "no_longer_matters", note: reason });
      previewLines.push(`Auto-skipped (${reason}): ${card.body.question}`);
    } else {
      leftOpen.push(card.body.question);
      previewLines.push(`Left open for later: ${card.body.question}`);
    }
  }

  return { answers, leftOpen, previewLines };
}

export class ReviewPages {
  private readonly links: ReviewLinks;
  constructor(
    readonly origin: URL,
    private readonly service: Service,
    private readonly now: () => number,
    private readonly hasInbox: boolean,
    private readonly waitersFor?: (project: string, reviewId: string) => Actor[],
  ) {
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
    const id = this.links.create({ project, actor, review: review.id, mode: "answer", items: items.map(({ id, revision }) => ({ id, revision })) });
    if (!id) return { code: EXIT.BUSY, message: "too many open review pages; try again after one expires" };
    return { code: EXIT.OK, review_id: review.id, url: new URL(`/review/${id}`, this.origin).href };
  }

  prepareEdit(project: string, actor: Actor, reviewId: unknown): OpResult {
    if (typeof reviewId !== "string") return { code: EXIT.OTHER, message: "a review id is required" };
    const engine = this.service.engine(project);
    if (!(engine instanceof Engine)) return engine;
    const shown = engine.run("show", { id: reviewId }, actor);
    if (shown.code !== EXIT.OK) return shown;
    const review = shown.review as (ReviewView & { status: string }) | undefined;
    if (review?.status !== "prepared") return { code: EXIT.NOT_ALLOWED, message: "prepare the review with utp flush first" };
    const items = review.items.filter((card) => card.current && card.body.kind !== "notice");
    if (!items.length) return { code: EXIT.NOT_ALLOWED, message: "this review has no cards to inspect or edit" };
    const id = this.links.create({ project, actor, review: review.id, mode: "edit", items: items.map(({ id, revision }) => ({ id, revision })) });
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
    const shown = engine.run("show", { id: entry.review }, entry.actor).review as ReviewView | undefined;
    if (!shown) return denied();
    if (entry.mode === "edit") {
      const pinned = entry.items.map((ref) => shown.items.find((card) => card.id === ref.id && card.revision === ref.revision));
      if (pinned.some((card) => !card?.current)) {
        return sendHtml(response, 409, page("Review changed", "<h1>Review changed</h1><p>A card in this review was revised. Open a fresh link before editing.</p>" + this.inboxLink()));
      }
      const pinnedItems = pinned.filter((card): card is NonNullable<typeof card> => card !== undefined);
      const editView: ReviewView = { ...shown, items: pinnedItems };
      const refreshPinned = (): ReviewView => {
        const latest = (engine.run("show", { id: entry.review }, entry.actor).review as ReviewView | undefined) ?? shown;
        const latestItems = entry.items
          .map((ref) => latest.items.find((card) => card.id === ref.id && card.revision === ref.revision))
          .filter((card): card is NonNullable<typeof card> => card !== undefined);
        return { ...latest, items: latestItems };
      };
      if (request.method === "GET") {
        const browser = entry.browser ?? { cookie: token(), form: token(), openedAt: this.now() };
        const remainingSeconds = Math.ceil((entry.expiresAt - this.now()) / 1000);
        const cookie = entry.browser ? undefined
          : `utp_review=${browser.cookie}; Path=${path}; Max-Age=${remainingSeconds}; HttpOnly; SameSite=Strict${this.origin.protocol === "https:" ? "; Secure" : ""}`;
        if (!entry.browser) this.links.save(id, { ...entry, browser });
        return sendHtml(response, 200, editReviewHtml(editView, browser.form, this.inboxLink()), cookie);
      }
      if (!form || !entry.browser) return denied();
      const withdrawRef = form.get("edit-withdraw");
      if (withdrawRef !== null) {
        const card = pinnedItems.find((c) => `${c.id}@${c.revision}` === withdrawRef);
        if (!card) return denied();
        const r = engine.editBrowserAnswer(`${card.id}@${card.revision}`, { withdraw: true }, entry.actor);
        const refreshed = refreshPinned();
        if (r.code !== EXIT.OK) {
          return sendHtml(response, 409, editReviewHtml(refreshed, entry.browser.form, this.inboxLink(), r.message ?? "Could not withdraw answer."));
        }
        return sendHtml(response, 200, editReviewHtml(refreshed, entry.browser.form, this.inboxLink(), undefined,
          `Withdrew answer for "${card.body.question}". It is open in the waiting inbox again.`));
      }
      const saveRef = form.get("edit-save");
      if (saveRef !== null) {
        const idx = pinnedItems.findIndex((c) => `${c.id}@${c.revision}` === saveRef);
        const card = idx >= 0 ? pinnedItems[idx] : undefined;
        if (!card) return denied();
        const hasAuth = cardHasAuthorization(card.body);
        const custom = form.get(`custom-${idx}`);
        const hasCustom = !!custom?.trim();
        const choice = form.get(`choice-${idx}`)?.trim() ?? "";
        const note = hasAuth ? undefined : (form.get(`note-${idx}`)?.trim() || undefined);
        const prompts = itemPrompts(card.body);
        let editInput: Parameters<Engine["editBrowserAnswer"]>[1];
        if (hasAuth && hasCustom) {
          editInput = { clarify_note: custom!.trim() };
        } else if (prompts.length) {
          const chosenItems = prompts.map(({ id: itemId }, n) => [itemId, form.get(`item-${idx}-${n}`) ?? ""] as const);
          const anySelected = chosenItems.some(([, v]) => v.trim() !== "");
          if (hasCustom && anySelected) {
            return sendHtml(response, 400, editReviewHtml(editView, entry.browser.form, this.inboxLink(),
              'Choose either item answers or "Your own answer", not both.'));
          }
          if (hasCustom) editInput = { custom: custom! };
          else {
            const itemsMap = Object.fromEntries(chosenItems);
            const details = Object.fromEntries(prompts.flatMap(({ id: itemId }, n) => {
              const text = form.get(`detail-${idx}-${n}`);
              return text?.trim() ? [[itemId, text]] : [];
            }));
            editInput = { items: itemsMap, details, ...(note ? { note } : {}) };
          }
        } else if (choice === "__custom__") {
          if (!hasCustom) {
            return sendHtml(response, 400, editReviewHtml(editView, entry.browser.form, this.inboxLink(),
              'Enter your own answer or pick a listed option before saving.'));
          }
          editInput = { custom: custom! };
        } else if (choice && hasCustom) {
          return sendHtml(response, 400, editReviewHtml(editView, entry.browser.form, this.inboxLink(),
            'Choose either a listed option or "Your own answer", or move your comment to the optional note box.'));
        } else if (hasCustom) {
          editInput = { custom: custom! };
        } else if (choice) {
          editInput = { value: choice, ...(note ? { note } : {}) };
        } else {
          return sendHtml(response, 400, editReviewHtml(editView, entry.browser.form, this.inboxLink(),
            "Choose an option, enter an answer, or withdraw before saving."));
        }
        const r = engine.editBrowserAnswer(`${card.id}@${card.revision}`, editInput, entry.actor);
        const refreshed = refreshPinned();
        if (r.code !== EXIT.OK) {
          return sendHtml(response, r.code === EXIT.NOT_ALLOWED ? 409 : 400,
            editReviewHtml(refreshed, entry.browser.form, this.inboxLink(), r.message ?? "Could not update answer."));
        }
        const msg = editInput.clarify_note
          ? `Held "${card.body.question}" for clarification and revoked any unused grant.`
          : `Updated answer for "${card.body.question}".`;
        return sendHtml(response, 200, editReviewHtml(refreshed, entry.browser.form, this.inboxLink(), undefined, msg));
      }
      return denied();
    }
    const receipt = engine.browserBatchReceipt(entry.review, saveId);
    if (receipt) {
      const remaining = shown.items.filter((c) => c.current && c.body.kind !== "notice" && answerable(c.status) && !c.clarification)
        .map((c) => c.body.question);
      return sendHtml(response, 200, savedHtml(shown, receipt.answers, this.inboxLink(), {
        receipt, remainingQuestions: remaining,
        pickupHtml: pickupStatusHtml(shown, this.waitersFor?.(entry.project, entry.review) ?? []),
        editFormHtml: this.editFormLink(entry.project, entry.review, shown),
      }));
    }
    const items = entry.items.map((ref) => shown.items.find((card) => card.id === ref.id && card.revision === ref.revision));
    if (items.some((card) => !card?.current || (!form && card.body.kind !== "notice" && !answerable(card.status)))) {
      return sendHtml(response, 409, page("Review changed", "<h1>Review changed</h1><p>Open a fresh link before answering.</p>" + this.inboxLink()));
    }
    const view: ReviewView = { ...shown, items: items.filter((card) => card !== undefined) };
    if (request.method === "GET") {
      const browser = entry.browser ?? { cookie: token(), form: token(), openedAt: this.now() };
      const html = reviewHtml(view, browser.form);
      const presented = engine.run("presented", { review: view.id, channel: "review-page",
        items: view.items.map(card => `${card.id}@${card.revision}`) }, entry.actor, `review-page-${linkKey(id)}`);
      if (presented.code !== EXIT.OK) return denied();
      const remainingSeconds = Math.ceil((entry.expiresAt - this.now()) / 1000);
      const cookie = entry.browser ? undefined
        : `utp_review=${browser.cookie}; Path=${path}; Max-Age=${remainingSeconds}; HttpOnly; SameSite=Strict${this.origin.protocol === "https:" ? "; Secure" : ""}`;
      if (!entry.browser) this.links.save(id, { ...entry, browser });
      sendHtml(response, 200, html, cookie);
      return;
    }
    if (!form || !entry.browser) return denied();
    const defaultAction = form.get("default-action");
    if (defaultAction !== null) {
      const m = /^(keep|switch):(R-[A-Za-z0-9-]+@\d+):([A-Za-z0-9_-]+)$/.exec(defaultAction);
      if (!m) return denied();
      const [, , ref, optId] = m;
      const inReview = (view.default_notices ?? []).some((n) => `${n.request_id}@${n.revision}` === ref);
      if (!inReview) return denied();
      const r = engine.recordBrowserDefaultAction(ref!, optId!, entry.actor);
      if (r.code !== EXIT.OK) {
        return sendHtml(response, 409, reviewHtml(view, entry.browser.form, r.message ?? "Could not update that applied default.", form));
      }
      const msg = r.kept === true
        ? `Confirmed applied default (${optId}) on ${ref}.`
        : `Recorded switch to option ${optId} on ${ref}; flagged as a late conflict for the agent to reconcile.`;
      return sendHtml(response, 200, reviewHtml(view, entry.browser.form, undefined, form, { statusMessage: msg }));
    }
    const reverseNotice = form.get("reverse-notice");
    if (reverseNotice !== null) {
      const card = /^\d+$/.test(reverseNotice) ? view.items[Number(reverseNotice)] : undefined;
      if (!card || card.body.kind !== "notice") return denied();
      const reason = form.get(`reverse-reason-${reverseNotice}`)?.trim() || "Flagged for reversal on the review page.";
      const r = engine.run("reverse", { id: card.id, reason, tags: card.body.tags ?? [] }, entry.actor);
      if (r.code !== EXIT.OK) {
        return sendHtml(response, 409, reviewHtml(view, entry.browser.form, r.message ?? "Could not record reversal.", form));
      }
      return sendHtml(response, 200, reviewHtml(view, entry.browser.form, undefined, form,
        { statusMessage: `Flagged notice ${card.id} for reversal. Future lookups on its tags will show this reversal.` }));
    }
    const requested = form.get("clarify");
    if (requested !== null) {
      const card = /^\d+$/.test(requested) ? view.items[Number(requested)] : undefined;
      if (!card) return denied();
      const result = engine.run("answer", {
        id: `${card.id}@${card.revision}`, channel: "review-page", clarify: true,
        presentation: engine.browserPresentation(view.id, `review-page-${linkKey(id)}`),
        note: form.get(`clarify-note-${requested}`)?.trim(),
      }, entry.actor);
      if (result.code !== EXIT.OK) {
        return sendHtml(response, 409, reviewHtml(view, entry.browser.form, result.message ?? "This question changed.", form));
      }
      card.clarification = result.clarification as ClarificationRequest;
      return sendHtml(response, 200, reviewHtml(view, entry.browser.form, undefined, form));
    }
    const parsed = parseBatchForm(view, form, this.now());
    if (parsed.error) {
      return sendHtml(response, 400, reviewHtml(view, entry.browser.form, parsed.error, form));
    }
    if (form.get("preview") === "1") {
      return sendHtml(response, 200, reviewHtml(view, entry.browser.form, undefined, form, { previewLines: parsed.previewLines }));
    }
    const liveWaiters = this.waitersFor?.(entry.project, entry.review) ?? [];
    const result = engine.saveBrowserAnswers(view.id, parsed.answers, entry.actor, Math.max(0, this.now() - entry.browser.openedAt), saveId,
      `review-page-${linkKey(id)}`);
    if (result.code !== EXIT.OK) {
      return sendHtml(response, result.code === EXIT.REVOKED ? 409 : 400,
        reviewHtml(view, entry.browser.form, result.message ?? "Review the answers and try again.", form));
    }
    const batchReceipt = engine.browserBatchReceipt(view.id, saveId)!;
    const after = (engine.run("show", { id: view.id }, entry.actor).review as ReviewView | undefined) ?? view;
    const remaining = after.items.filter((c) => c.current && c.body.kind !== "notice" && answerable(c.status) && !c.clarification)
      .map((c) => c.body.question);
    sendHtml(response, 200, savedHtml(view, batchReceipt.answers, this.inboxLink(), {
      receipt: batchReceipt,
      remainingQuestions: remaining,
      pickupHtml: pickupStatusHtml(after, liveWaiters),
      editFormHtml: this.editFormLink(entry.project, entry.review, after),
    }));
  }

  private editFormLink(project: string, reviewId: string, review: ReviewView): string {
    if (!this.hasInbox) return "";
    const editable = review.items.some((c) => c.current && (c.status === "answered" || c.status === "granted"));
    if (!editable) return "";
    return `<form method="post" action="/edit/${encodeURIComponent(project)}/${encodeURIComponent(reviewId)}" class="form-actions"><button type="submit" class="button-secondary">Edit or withdraw answers (before work begins)</button></form>`;
  }

  private inboxLink(): string {
    return this.hasInbox ? '<p><a href="/">Back to the review inbox</a></p>' : "";
  }
}
