import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import { mkdtempSync } from "./support/tmp.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewMarkdown, type ReviewView } from "../src/cli/render.js";
import { interpretChat } from "../src/core/conversation.js";
import type { Grant, OpResult, RequestBody } from "../src/core/types.js";
import { startServer } from "../src/server/http.js";
import { createToken } from "../src/server/tokens.js";

const card: RequestBody = { id: "D1", kind: "approve", level: 3, level_reason: "The changes reach the print shop.",
  question: "Send these catalogue entries?", why_now: "The printer needs the catalogue entries.",
  stakes: { reversibility: "costly" }, narrowing_reason: "The current edition is one order.",
  evidence: [{ kind: "observed", claim: "The order lists three entries.", source: "Print order", date: "2026-11-22" }],
  options: [{ id: "yes", label: "Send the entries", consequence: "The printer receives the entries.",
    authorization: { action: "send", target: "printer", scope: "A, B, C", expected_effect: "All three entries arrive" } },
  { id: "no", label: "Keep the entries", consequence: "The edition stays local." }],
  basis: { files: ["order.txt"] } };

test("chat choices distinguish a limited scope, a question and uncertain or overlapping assent", () => {
  const a = { id: "R-00000000-00000001", revision: 2, body: card };
  const b = { id: "R-00000000-00000002", revision: 1, body: { ...card, id: "D2" } };
  const choose = (quote: string, cards = [a], index = 0, bare = true, overlap = false) =>
    interpretChat(cards, index, quote, bare, overlap);
  assert.equal(choose("yes").value, "yes");
  assert.equal(choose("go", [a], 0, false).followup, "unsure");
  assert.equal(choose("yes", [a, b], 0, false).followup, "unsure");
  assert.equal(choose("yes", [a], 0, true, true).followup, "unsure");
  assert.equal(choose("Z: yes").followup, "unsure");
  assert.equal(choose("yes, wait").followup, "unsure");
  assert.equal(choose("what happens to the printer?").followup, "needs_clarification");
  assert.equal(choose("approve sending only A and D").followup, "needs_clarification");
  assert.deepEqual(choose("approve sending only A and B").authorization, { action: "send", target: "printer", scope: "A, B" });
  assert.equal(choose("D1: yes, send those printer; D2: decline", [a, b], 0, false).value, "yes");
  assert.equal(choose("D1: yes; D2: decline", [a, b], 1, false).value, "no");
  assert.equal(choose(a.id + "@2: yes", [a], 0, false, true).value, "yes");
  const conditional: RequestBody = { ...card, options: [{ ...card.options![0]!, authorization: {
    action: "send", target: "printer", scope: "the catalogue and only after sign-off" } }, card.options![1]!] };
  assert.equal(interpretChat([{ ...a, body: conditional }], 0, "approve sending only the catalogue", true, false).followup, "needs_clarification");
});

for (const platform of ["codex", "claude"] as const) test(`${platform} verifies a native presentation and a person's exact later reply through the service`, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "utp-chat-"));
  const session = randomUUID();
  const roots = path.join(dir, "native");
  const folder = path.join(roots, ...platform === "codex" ? ["2026", "11", "22"] : ["sample"]);
  mkdirSync(folder, { recursive: true });
  const log = path.join(folder, platform === "codex" ? `rollout-2026-11-22T12-00-00-${session}.jsonl` : session + ".jsonl");
  const put = (row: unknown) => appendFileSync(log, JSON.stringify(row) + "\n");
  let parentUuid: string | null = null;
  if (platform === "codex") put({ type: "session_meta", payload: { id: session, source: "cli" } });
  const say = (role: "user" | "assistant", text: string) => {
    if (platform === "claude") {
      const uuid = randomUUID();
      put({ type: role, origin: role === "user" ? { kind: "human" } : undefined, sessionId: session, parentUuid, uuid, message: { role, content: text } });
      parentUuid = uuid;
    }
    else if (role === "assistant") put({ type: "response_item", payload: { type: "message", role, content: [{ type: "output_text", text }] } });
    else {
      const turn_id = randomUUID();
      put({ type: "event_msg", payload: { type: "task_started", turn_id } });
      put({ type: "event_msg", payload: { type: "user_message", message: text } });
      put({ type: "response_item", payload: { type: "message", role, internal_chat_message_metadata_passthrough: { turn_id,
        content_item_kinds: ["user.text"], content_item_metadata: [{ provenance: { type: "user" } }] }, content: [{ type: "input_text", text }] } });
    }
  };
  const dataDir = path.join(dir, "service");
  const options = { port: 0, dataDir, transcriptRoots: { desktop: { [platform]: roots } } };
  let service = await startServer(options);
  const token = createToken(dataDir, "desktop");
  let project: string | undefined;
  async function op(name: string, args: Record<string, unknown> = {}, from = session, op_id?: string): Promise<OpResult> {
    const r = await fetch(service.url + "/v1/op", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ op: name, args, session: from, project, op_id }) });
    return await r.json() as OpResult;
  }
  try {
    project = ((await op("project.create")).project as { id: string }).id;
    const basis = { "order.txt": "print-order-1" };
    const ask = await op("ask", { body: card, basis });
    assert.equal(ask.code, 0, JSON.stringify(ask));
    const review = ask.review_id;
    const id = ask.id + "@1";
    assert.equal((await op("flush")).route, "conversation");
    const present = { review, channel: "conversation" };
    const show = async () => (await op("show", { id: review })).review as ReviewView & { presentations: { acknowledged_at?: string; verified?: string }[] };
    const markdown = reviewMarkdown(await show());
    say("user", "yes"); say("assistant", String(review));
    assert.equal((await op("presented", present)).code, 19);
    say("assistant", markdown);
    const receipt = await op("presented", present);
    assert.equal(receipt.code, 0);
    assert.equal((await op("presented", present)).presentation_id, receipt.presentation_id);
    assert.deepEqual((await show()).presentations.map(p => [p.verified, !!p.acknowledged_at]), [["transcript", false]]);
    const answer = (quote: string, from = session, opId?: string) => op("answer", { id, channel: "conversation", quote,
      presentation: receipt.presentation_id }, from, opId);
    assert.equal((await answer("yes")).code, 18);
    if (platform === "claude") {
      const branch = parentUuid;
      say("user", "An abandoned response"); parentUuid = branch;
      say("assistant", "The original review is still displayed.");
      assert.equal((await answer("An abandoned response")).code, 18);
    }
    if (platform === "codex") put({ type: "response_item", payload: { type: "function_call_output", output: "yes" } });
    else put({ type: "user", sessionId: session, message: { role: "user", content: [{ type: "tool_result", content: "yes" }] } });
    assert.equal((await answer("yes")).code, 18);
    const quote = "approve sending only A and B";
    say("user", quote);
    assert.equal((await answer(quote, randomUUID())).code, 18);
    const saved = await answer(quote, session, "save-first");
    assert.equal(saved.code, 0, JSON.stringify(saved));
    const granted = (await op("wait", { id, basis })).grant as Grant;
    assert.deepEqual(granted.authorization, { action: "send", target: "printer", scope: "A, B" });
    assert.equal(granted.provenance, "transcript");
    await service.close(); service = await startServer(options);
    assert.deepEqual((await answer(quote, session, "save-first")).answer, saved.answer);
    assert.ok((await show()).presentations[0]?.acknowledged_at);
    say("user", "wait");
    assert.equal((await op("begin", { grant: granted.id, basis })).code, 17);
    assert.equal((await answer(quote)).outcome, "unsure");
    assert.equal((await op("wait", { id, basis })).code, 21);
    say("user", "D1: no");
    assert.equal(((await answer("D1: no")).answer as { value: string }).value, "no");
    assert.equal((await answer(quote)).code, 18);
    // A delayed chat reply cannot replace a later confirmation from another surface.
    say("user", "D1: yes");
    assert.equal((await op("answer", { id, value: "no", channel: "terminal-review" })).code, 0);
    assert.equal((await answer("D1: yes")).code, 19);

    const second = await op("ask", { body: { ...card, question: "Send the revised catalogue entries?" }, basis });
    const secondId = second.id + "@1";
    await op("flush");
    const secondView = (await op("show", { id: second.review_id })).review as ReviewView;
    say("assistant", reviewMarkdown(secondView));
    assert.equal((await op("presented", { review: second.review_id, channel: "conversation" })).code, 0);
    say("user", "yes");
    assert.equal((await op("answer", { id: secondId, channel: "conversation", quote: "yes" })).code, 0);
    renameSync(log, log + ".offline");
    assert.equal((await op("wait", { id: secondId, basis })).code, 18);
    const retry = await op("review-page.prepare", { review: second.review_id });
    assert.equal(retry.code, 0, JSON.stringify(retry));
    const opened = await fetch(String(retry.url));
    assert.equal(opened.status, 200);
  } finally { await service.close(); }
});
