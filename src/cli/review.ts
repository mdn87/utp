// `utp review`: the person answers prepared reviews in their own terminal.
// Answers from an interactive terminal are recorded through the
// terminal-review channel, which counts as a channel the agent doesn't
// control; piped input is recorded as terminal-piped and stays unverified.

import readline from "node:readline";
import { EXIT } from "../core/types.js";
import { call } from "./client.js";
import { cardMarkdown, letter, type RequestView } from "./render.js";

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

export async function runReview(project: string, io: ReviewIO): Promise<number> {
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
  let saved = 0;
  let skipped = 0;
  let shownAny = false;
  try {
    outer: for (const v of reviews) {
      const shown = await call("show", { id: v.id }, { project });
      const items = ((shown.review as { items: RequestView[] }).items)
        .filter((i) => i.current && (i.status === "queued" || i.status === "presented"));
      if (items.length === 0) continue;
      const receipt = await call("presented", { review: v.id, channel }, { project });
      if (receipt.code !== EXIT.OK) {
        write(`Couldn't record that review ${v.id} was shown: ${String(receipt.message ?? receipt.code)}`);
        continue;
      }
      shownAny = true;
      write(`\n## Review ${v.id}\n`);
      for (const [n, item] of items.entries()) {
        write(`${cardMarkdown(item, letter(n))}\n`);
        if (item.body.kind === "notice") continue;
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
          const r = await call("answer", { id: `${item.id}@${item.revision}`, channel, ...args }, { project });
          if (r.code === EXIT.OK) saved += 1;
          else write(`Not saved: ${String(r.message ?? `exit ${r.code}`)}`);
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
