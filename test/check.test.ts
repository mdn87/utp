import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBlind } from "../src/core/blind.js";
import { checkRequest } from "../src/core/check.js";

test("blind PNG candidates compare without identifying metadata", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwwAAAAASUVORK5CYII=", "base64");
  const text = Buffer.from("Author\0Private identity");
  const metadata = Buffer.alloc(text.length + 12);
  metadata.writeUInt32BE(text.length);
  metadata.write("tEXt", 4);
  text.copy(metadata, 8);
  const withMetadata = Buffer.concat([png.subarray(0, -12), metadata, png.subarray(-12)]);
  const duplicate = normalizeBlind({ candidates: [
    { identity: "First source", artifact: { media_type: "image/png", data: png.toString("base64") } },
    { identity: "Second source", artifact: { media_type: "image/png", data: withMetadata.toString("base64") } },
  ] });
  assert.equal(duplicate, "the two candidate previews are identical");
});
import type { RequestBody } from "../src/core/types.js";

const valid = (): RequestBody => ({
  kind: "choose", question: "Which parser should the import use?", why_now: "The import step needs one.",
  options: [
    { id: "a", label: "Strict", consequence: "Bad rows stop the import." },
    { id: "b", label: "Lenient", consequence: "Bad rows are skipped and listed." },
  ],
  recommendation: { option: "b", because: "Real exports contain a few bad rows." },
  stakes: { reversibility: "easy" }, level: 2, level_reason: "Easy to switch later.",
});

const rules = (body: unknown) => checkRequest(body).map((f) => f.rule);

test("a complete request passes", () => {
  assert.deepEqual(checkRequest(valid()), []);
});

test("each structural gap is reported with its rule id", () => {
  assert.deepEqual(rules({ ...valid(), why_now: " " }), ["S03-why-now"]);
  const a = valid().options![0]!;
  assert.deepEqual(rules({ ...valid(), recommendation: undefined, options: [a] }), ["S07-options"]);
  assert.deepEqual(rules({ ...valid(), recommendation: undefined, options: [a, a] }), ["S08-option-id"]);
  assert.deepEqual(rules({ ...valid(), options: [a] }), ["S07-options", "S13-recommendation"], "a dangling recommendation is its own problem");
  assert.deepEqual(rules({ ...valid(), recommendation: { option: "z", because: "x" } }), ["S13-recommendation"]);
  assert.deepEqual(rules({ ...valid(), kind: "approve" }), ["S12-approve-authorization"]);
  assert.deepEqual(rules({ ...valid(), stakes: { reversibility: "maybe" } }), ["S06-stakes"]);
  assert.deepEqual(rules("not an object"), ["S00-shape"]);
});

test("a level-3 request can't carry a default, because it always waits for the person", () => {
  const body = { ...valid(), level: 3, default: { option: "a", consequence: "Strict parsing is used." } };
  assert.deepEqual(rules(body), ["S15-default-level"]);
  assert.deepEqual(rules({ ...body, level: 2 }), []);
});
