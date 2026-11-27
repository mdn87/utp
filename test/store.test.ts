import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./support/tmp.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore, StoreBusyError } from "../src/core/store.js";

const fresh = () => mkdtempSync(path.join(tmpdir(), "utp-store-"));
const writer = fileURLToPath(new URL("./fixtures/crash-writer.js", import.meta.url));
const event = (op_id: string, value: number) => ({
  type: "test.write", at: "2026-11-22T00:00:00Z", op_id, data: { value }, result: { value },
});

test("a committed operation returns its first result when retried", () => {
  const dir = fresh();
  const a = new EventStore(dir);
  a.open();
  const first = a.append(event("op-1", 1));
  const again = a.append(event("op-1", 2));
  assert.deepEqual(again.result, { value: 1 });
  assert.equal(again.seq, first.seq);
  a.close();
  const b = new EventStore(dir);
  b.open();
  assert.equal(b.all().length, 1);
  assert.deepEqual(b.append(event("op-1", 3)).result, { value: 1 });
  b.close();
});

test("payloads are stored by content hash and read back intact", () => {
  const dir = fresh();
  const s = new EventStore(dir);
  s.open();
  const e = s.append(event("op-p", 1), { body: { question: "Which one?", n: [1, 2] } });
  const sha = e.payloads?.body;
  assert.ok(sha && /^[0-9a-f]{64}$/.test(sha));
  assert.deepEqual(s.getPayload(sha), { question: "Which one?", n: [1, 2] });
  s.close();
});

test("a torn last line is moved to quarantine and its operation counts as not done", () => {
  const dir = fresh();
  const s = new EventStore(dir);
  s.open();
  s.append(event("op-a", 1));
  s.close();
  writeFileSync(path.join(dir, "events.jsonl"), readFileSync(path.join(dir, "events.jsonl"), "utf8") + '{"seq":2,"type":"test.wr');
  const t = new EventStore(dir);
  t.open();
  assert.equal(t.all().length, 1);
  assert.equal(t.findOp("op-b"), undefined);
  const q = readFileSync(path.join(dir, "quarantine.jsonl"), "utf8").trim().split("\n");
  assert.equal(q.length, 1);
  assert.match(q[0] ?? "", /torn/);
  t.append(event("op-b", 2));
  assert.equal(t.all().length, 2);
  t.close();
});

test("a complete last line that doesn't parse is quarantined too", () => {
  const dir = fresh();
  const s = new EventStore(dir);
  s.open();
  s.append(event("op-a", 1));
  s.close();
  writeFileSync(path.join(dir, "events.jsonl"), readFileSync(path.join(dir, "events.jsonl"), "utf8") + "{not json}\n");
  const t = new EventStore(dir);
  t.open();
  assert.equal(t.all().length, 1);
  assert.ok(existsSync(path.join(dir, "quarantine.jsonl")));
  t.close();
});

test("a second store on the same folder is refused while the first holds the lock", () => {
  const dir = fresh();
  const a = new EventStore(dir);
  a.open();
  assert.throws(() => new EventStore(dir).open(), StoreBusyError);
  a.close();
  const b = new EventStore(dir);
  b.open();
  b.close();
});

for (const crashAt of ["after-payload", "mid-event", "after-event"] as const) {
  test(`killing the writer ${crashAt}, then retrying the same operation, commits exactly once`, () => {
    const dir = fresh();
    const killed = spawnSync(process.execPath, [writer, dir, "op-crash", crashAt], { encoding: "utf8" });
    assert.notEqual(killed.status, 0, "the first writer should have died");
    // The dead writer left its lock behind; the retry must take it over.
    const retry = spawnSync(process.execPath, [writer, dir, "op-crash"], { encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), { ok: true, value: 42 });
    const s = new EventStore(dir);
    s.open();
    const matching = s.all().filter((e) => e.op_id === "op-crash");
    assert.equal(matching.length, 1);
    assert.equal(s.all().length, 1);
    const sha = matching[0]?.payloads?.body;
    assert.ok(sha);
    assert.deepEqual(s.getPayload(sha), { hello: "world" });
    assert.equal(existsSync(path.join(dir, "quarantine.jsonl")), crashAt === "mid-event");
    s.close();
  });
}
