// `utp review`: the person answers prepared reviews in their own terminal.
// Answers from an interactive terminal are recorded through the
// terminal-review channel, which counts as a channel the agent doesn't
// control; piped input is recorded as terminal-piped and stays unverified.

import readline from "node:readline";
import type { RecentReviewSummary } from "../core/engine.js";
import { itemPrompts, type ItemPrompt } from "../core/items.js";
import { CLARITY_FEEDBACK, EXIT, SURENESS } from "../core/types.js";
import { call } from "./client.js";
import { cardMarkdown, contextMarkdown, defaultNoticeMarkdown, letter, reviewMarkdown, type RequestView, type ReviewView } from "./render.js";

export interface ReviewIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive: boolean;
}

function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

async function readItems(prompts: ItemPrompt[], ask: (prompt: string, verbatim?: boolean) => Promise<string | null>, write: (text: string) => void):
  Promise<{ items: Record<string, string>; details: Record<string, string> } | { custom: string } | { clarify: true } | null | undefined> {
  const items = new Map<string, string>();
  const details = new Map<string, string>();
  for (const prompt of prompts) {
    for (;;) {
      const value = await ask(`${prompt.id} · ${prompt.label} (${prompt.choices.join(", ")}, ? for clarification, / for a custom reply, or Enter to skip): `);
      if (value === null) return null;
      if (!value) return undefined;
      if (value === "?") return { clarify: true };
      if (value === "/") {
        const custom = await ask("Your answer for this card: ", true);
        return custom === null ? null : custom.trim() ? { custom } : undefined;
      }
      if (!prompt.choices.includes(value)) {
        write(`Choose ${prompt.choices.join(", ")}.`);
        continue;
      }
      if (prompt.detailsFor.includes(value)) {
        const detail = await ask(`${prompt.detailLabel ?? "Details"}: `, true);
        if (detail === null) return null;
        if (!detail.trim()) {
          write("This answer needs the result or replacement text.");
          continue;
        }
        details.set(prompt.id, detail);
      }
      items.set(prompt.id, value);
      break;
    }
  }
  return { items: Object.fromEntries(items), details: Object.fromEntries(details) };
}

export async function runReview(project: string, io: ReviewIO, withFeedback = false, reviewId?: string): Promise<number> {
  const write = (text: string) => io.output.write(`${text}\n`);
  const reviews = reviewId ? [{ id: reviewId }]
    : ((await call("status", {}, { project })).reviews as { id: string; status: string }[]).filter(v => v.status === "prepared");
  const channel = io.interactive ? "terminal-review" : "terminal-piped";
  const rl = readline.createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string, verbatim = false): Promise<string | null> => {
    io.output.write(prompt);
    const next = await lines.next();
    if (next.done) return null;
    const text = String(next.value);
    return verbatim ? text : text.trim();
  };
  const optionalRating = async (question: string, allowed: readonly string[]): Promise<string | undefined> => {
    for (;;) {
      const rating = await ask(`${question} (${allowed.join(", ")}, or Enter to skip): `);
      if (!rating) return undefined;
      if (allowed.includes(rating)) return rating;
      write(`Choose ${allowed.join(", ")}.`);
    }
  };
  let saved = 0;
  let skipped = 0;
  let clarified = 0;
  let shownAny = false;
  let presentation: string | undefined;
  const save = async (id: string, args: Record<string, unknown>, shownAt: number): Promise<void> => {
    if (args.clarify) {
      const note = typeof args.note === "string" ? args.note : await ask("What should the agent explain? Enter to send without a note: ");
      const result = await call("answer", {
        id, channel, presentation, clarify: true,
        ...(args.outcome ? { outcome: args.outcome } : {}),
        note: note || undefined,
      }, { project });
      if (result.code === EXIT.OK) {
        clarified += 1;
        write("Clarification requested. The agent will see it when it checks this question.");
      } else write(`Could not request clarification. ${String(result.message ?? `Exit ${result.code}`)}`);
      return;
    }
    if (!args.hide_until) {
      if (io.interactive) args.active_response_ms = Math.round(performance.now() - shownAt);
      if (withFeedback) {
        args.sureness = await optionalRating("How sure are you?", SURENESS);
        args.feedback = await optionalRating("How clear was this card?", Object.keys(CLARITY_FEEDBACK));
      }
    }
    const r = await call("answer", { id, channel, presentation, ...args }, { project });
    if (r.code === EXIT.OK) saved += 1;
    else write(`Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
  };
  try {
    outer: for (const v of reviews) {
      const shown = await call("show", { id: v.id }, { project });
      const review = shown.review as (ReviewView & { status: string }) | undefined;
      if (review?.status !== "prepared") continue;
      const items = review.items
        .filter((i) => i.current && (i.status === "queued" || i.status === "presented"));
      if (items.length === 0) {
        if (reviewId) write(reviewMarkdown(review, "history"));
        continue;
      }
      write(`\n## Review ${v.id}\n`);
      write(contextMarkdown(review.intent) + "\n");
      for (const notice of review.default_notices ?? []) write(defaultNoticeMarkdown(notice));
      items.forEach((item, n) => write(`${cardMarkdown(item, letter(n), review)}\n`));
      const receipt = await call("presented", { review: v.id, channel, items: items.map(i => `${i.id}@${i.revision}`) }, { project });
      if (receipt.code !== EXIT.OK) {
        write(`Couldn't record that review ${v.id} was shown: ${String(receipt.message ?? receipt.code)}`);
        continue;
      }
      shownAny = true;
      presentation = String(receipt.presentation_id);
      for (const notice of review.default_notices ?? []) {
        const alts = (notice.options ?? []).filter((o) => o.id !== notice.option).map((o) => o.id);
        if (!alts.length) continue;
        const reply = await ask(`Applied default ${notice.request_id}@${notice.revision} (${notice.option_label ?? notice.option}): k to keep, switch (${alts.join(", ")}), or Enter to skip: `);
        if (reply === null) break outer;
        if (!reply) continue;
        const chosen = reply === "k" ? notice.option : alts.includes(reply) ? reply : undefined;
        if (!chosen) {
          write(`Unrecognized choice ${reply}; skipped.`);
          continue;
        }
        const r = await call("answer", { id: `${notice.request_id}@${notice.revision}`, value: chosen, channel }, { project });
        if (r.code === EXIT.OK) write(chosen === notice.option ? "Confirmed applied default." : `Recorded switch to ${chosen}.`);
        else write(`Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
      }
      for (const [n, item] of items.entries()) {
        if (item.body.kind === "notice") continue;
        if (item.clarification && item.clarification.outcome !== "unsure") continue;
        write(`${letter(n)}. ${item.body.question}`);
        const shownAt = performance.now();
        const id = `${item.id}@${item.revision}`;
        const prompts = itemPrompts(item.body);
        if (prompts.length) {
          const args = await readItems(prompts, ask, write);
          if (args === null) break outer;
          if (!args) {
            skipped += 1;
            continue;
          }
          await save(id, args, shownAt);
          continue;
        }
        const ids = (item.body.options ?? []).map((o) => o.id);
        for (;;) {
          const reply = await ask(`Answer ${letter(n)}: ${ids.length ? `an option (${ids.join(", ")}), ` : ""}`
            + "? for clarification, / for your own words, h to hide until tomorrow, or Enter to skip: ");
          if (reply === null) break outer;
          if (reply === "") {
            skipped += 1;
            break;
          }
          let args: Record<string, unknown>;
          if (reply === "?") {
            args = { clarify: true };
          } else if (reply === "/") {
            const words = await ask("Your answer: ", true);
            if (!words?.trim()) {
              skipped += 1;
              break;
            }
            const hasAuth = item.body.kind === "approve" || (item.body.options ?? []).some((o) => !!o.authorization);
            if (hasAuth) {
              write("Free text on an approval card withholds the grant and asks the agent to revise the card.");
              args = { clarify: true, outcome: "needs_clarification", note: words.trim() };
            } else {
              args = { custom: words };
            }
          } else if (reply === "h") {
            args = { hide_until: tomorrowMorning() };
          } else if (ids.includes(reply)) {
            args = { value: reply };
          } else {
            write(`${reply} isn't one of this card's options.`);
            continue;
          }
          await save(id, args, shownAt);
          break;
        }
      }
    }
  } finally {
    rl.close();
  }
  if (!shownAny) {
    write(reviewId ? "That review has no questions waiting for you." : "Nothing is waiting for your answer.");
    return EXIT.OK;
  }
  if (clarified) write(`\nRequested clarification on ${clarified} ${clarified === 1 ? "card" : "cards"}.`);
  if (saved || !clarified) write(`Saved ${saved} answer${saved === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.`);
  write("Go back to the agent's conversation, or resume its session, so it picks up your reply.");
  return EXIT.OK;
}

export async function runRecentReview(project: string, io: ReviewIO): Promise<number> {
  const write = (text: string) => io.output.write(`${text}\n`);
  const res = await call("recent", {}, { project });
  if (res.code !== EXIT.OK) {
    write(String(res.message ?? `exit ${res.code}`));
    return res.code;
  }
  const reviews = (res.reviews as RecentReviewSummary[] | undefined) ?? [];
  if (!reviews.length) {
    write("No recent or in-flight reviews.");
    return EXIT.OK;
  }
  const editable: { reviewId: string; id: string; revision: number; question: string }[] = [];
  for (const rev of reviews) {
    write(`\n## ${rev.review_id}${rev.task_title ? ` — ${rev.task_title}` : ""}`);
    for (const c of rev.cards) {
      const idxTag = c.editable ? `[${editable.length + 1}] ` : "    ";
      if (c.editable) editable.push({ reviewId: rev.review_id, id: c.id, revision: c.revision, question: c.question });
      const ans = c.answer_summary ? ` → ${c.answer_summary}` : "";
      const eff = c.applied_evidence ? ` | Applied: ${c.applied_evidence.effect}` : "";
      write(`${idxTag}${c.id}@${c.revision}  ${c.status}  ${c.question}${ans}${eff}`);
    }
  }
  if (!editable.length) {
    write("\nNo pre-begin cards are editable.");
    return EXIT.OK;
  }
  const channel = io.interactive ? "terminal-review" : "terminal-piped";
  const rl = readline.createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string, verbatim = false): Promise<string | null> => {
    io.output.write(prompt);
    const next = await lines.next();
    if (next.done) return null;
    const text = String(next.value);
    return verbatim ? text : text.trim();
  };
  try {
    for (;;) {
      const pick = await ask(`\nEdit or withdraw card [1-${editable.length}] before work begins (or Enter to finish): `);
      if (!pick) break;
      const num = /^\d+$/.test(pick) ? Number(pick) : 0;
      const target = editable[num - 1];
      if (!target) {
        write(`Choose a number from 1 to ${editable.length}, or press Enter.`);
        continue;
      }
      const shown = await call("show", { id: `${target.id}@${target.revision}` }, { project });
      if (shown.code !== EXIT.OK) {
        write(String(shown.message ?? `exit ${shown.code}`));
        continue;
      }
      const card = shown.request as RequestView;
      if (!["answered", "granted"].includes(card.status)) {
        write(`Locked: ${card.id}@${card.revision} is now ${card.status}.`);
        continue;
      }
      const ids = (card.body.options ?? []).map((o) => o.id);
      const reply = await ask(`Change ${card.id}@${card.revision}: ${ids.length ? `option (${ids.join(", ")}), ` : ""}/ for custom, w to withdraw, or Enter to cancel: `);
      if (!reply) continue;
      if (reply === "w") {
        const r = await call("edit", { id: `${card.id}@${card.revision}`, channel, withdraw: true }, { project });
        write(r.code === EXIT.OK ? `Withdrew answer for ${card.id}@${card.revision}.` : `Not withdrawn: ${String(r.message ?? `exit ${r.code}`)}`);
        continue;
      }
      if (reply === "/") {
        const words = await ask("Your answer: ", true);
        if (!words?.trim()) continue;
        const hasAuth = card.body.kind === "approve" || (card.body.options ?? []).some((o) => !!o.authorization);
        if (hasAuth) {
          const c = await call("edit", { id: `${card.id}@${card.revision}`, channel, clarify_note: words.trim() }, { project });
          write(c.code === EXIT.OK ? "Withheld grant and requested clarification." : `Not saved: ${String(c.message ?? `exit ${c.code}`)}`);
          continue;
        }
        const r = await call("edit", { id: `${card.id}@${card.revision}`, channel, custom: words }, { project });
        write(r.code === EXIT.OK ? `Updated ${card.id}@${card.revision}.` : `Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
        continue;
      }
      if (ids.includes(reply)) {
        const r = await call("edit", { id: `${card.id}@${card.revision}`, channel, value: reply }, { project });
        write(r.code === EXIT.OK ? `Updated ${card.id}@${card.revision} to ${reply}.` : `Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
        continue;
      }
      write(`${reply} isn't one of this card's options.`);
    }
  } finally {
    rl.close();
  }
  return EXIT.OK;
}
