// `utp review`: the person answers prepared reviews in their own terminal.
// Answers from an interactive terminal are recorded through the
// terminal-review channel, which counts as a channel the agent doesn't
// control; piped input is recorded as terminal-piped and stays unverified.

import readline from "node:readline";
import { itemPrompts, type ItemPrompt } from "../core/items.js";
import { CLARITY_FEEDBACK, EXIT, SURENESS } from "../core/types.js";
import { call } from "./client.js";
import { cardMarkdown, defaultNoticeMarkdown, letter, type ReviewView } from "./render.js";

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

async function readItems(prompts: ItemPrompt[], ask: (prompt: string) => Promise<string | null>, write: (text: string) => void):
  Promise<{ items: Record<string, string>; details: Record<string, string> } | { custom: string } | null | undefined> {
  const items = new Map<string, string>();
  const details = new Map<string, string>();
  for (const prompt of prompts) {
    for (;;) {
      const value = await ask(`${prompt.id} · ${prompt.label} (${prompt.choices.join(", ")}, / for a custom reply, or Enter to skip): `);
      if (value === null) return null;
      if (!value) return undefined;
      if (value === "/") {
        const custom = await ask("Your answer for this card: ");
        return custom === null ? null : custom ? { custom } : undefined;
      }
      if (!prompt.choices.includes(value)) {
        write(`Choose ${prompt.choices.join(", ")}.`);
        continue;
      }
      if (prompt.detailsFor.includes(value)) {
        const detail = await ask(`${prompt.detailLabel ?? "Details"}: `);
        if (detail === null) return null;
        if (!detail) {
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

export async function runReview(project: string, io: ReviewIO, withFeedback = false): Promise<number> {
  const write = (text: string) => io.output.write(`${text}\n`);
  const status = await call("status", {}, { project });
  const reviews = (status.reviews as { id: string; status: string }[]).filter((v) => v.status === "prepared");
  const channel = io.interactive ? "terminal-review" : "terminal-piped";
  const rl = readline.createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | null> => {
    io.output.write(prompt);
    const next = await lines.next();
    return next.done ? null : String(next.value).trim();
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
  let shownAny = false;
  const save = async (id: string, args: Record<string, unknown>, shownAt: number): Promise<void> => {
    if (!args.hide_until) {
      if (io.interactive) args.active_response_ms = Math.round(performance.now() - shownAt);
      if (withFeedback) {
        args.sureness = await optionalRating("How sure are you?", SURENESS);
        args.feedback = await optionalRating("How clear was this card?", Object.keys(CLARITY_FEEDBACK));
      }
    }
    const r = await call("answer", { id, channel, ...args }, { project });
    if (r.code === EXIT.OK) saved += 1;
    else write(`Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
  };
  try {
    outer: for (const v of reviews) {
      const shown = await call("show", { id: v.id }, { project });
      const review = shown.review as ReviewView;
      const items = review.items
        .filter((i) => i.current && (i.status === "queued" || i.status === "presented"));
      if (items.length === 0) continue;
      const receipt = await call("presented", { review: v.id, channel }, { project });
      if (receipt.code !== EXIT.OK) {
        write(`Couldn't record that review ${v.id} was shown: ${String(receipt.message ?? receipt.code)}`);
        continue;
      }
      shownAny = true;
      write(`\n## Review ${v.id}\n`);
      for (const notice of review.default_notices ?? []) write(defaultNoticeMarkdown(notice));
      for (const [n, item] of items.entries()) {
        write(`${cardMarkdown(item, letter(n))}\n`);
        if (item.body.kind === "notice") continue;
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
            + "/ for your own words, h to hide until tomorrow, or Enter to skip: ");
          if (reply === null) break outer;
          if (reply === "") {
            skipped += 1;
            break;
          }
          let args: Record<string, unknown>;
          if (reply === "/") {
            const words = await ask("Your answer: ");
            if (!words) {
              skipped += 1;
              break;
            }
            args = { custom: words };
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
    write("Nothing is waiting for your answer.");
    return EXIT.OK;
  }
  write(`\nSaved ${saved} answer${saved === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}. `
    + "Go back to the agent's conversation, or resume its session, so it picks them up.");
  return EXIT.OK;
}
