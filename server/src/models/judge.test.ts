import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db } from "../db.ts";
import { judge, readJudgement, recentVerdicts, recordJudgement } from "./judge.ts";

/* WHAT IS TESTED AND WHAT IS NOT. The judgment is a model's and is not asserted
   here: a test pinning "Read their pricing page" to `homework` would be testing
   the model, and would pass against a stub while the live gate did something
   else. What is tested is the machinery around the judgment, which is where an
   LLM gate actually fails — reading a reply, refusing a partial one, keying
   verdicts back to the right items, and failing open when no model answers. */

const KEYS = ["a", "b"];
const WORDS = ["keep", "drop"] as const;
const obj = (verdicts: unknown) => JSON.stringify({ verdicts });

beforeEach(() => {
  db.exec("DELETE FROM gate_verdicts");
});

test("reads a well-formed reply and keys it by the caller's own keys", () => {
  const v = readJudgement(
    obj([
      { key: "a", verdict: "keep", why: "it changes the page" },
      { key: "b", verdict: "drop", why: "it only looks" },
    ]),
    KEYS,
    WORDS,
  );
  assert.deepEqual(v, [
    { key: "a", verdict: "keep", why: "it changes the page" },
    { key: "b", verdict: "drop", why: "it only looks" },
  ]);
});

test("reads a fenced reply, a bare array, and a reply with a preamble", () => {
  assert.equal(readJudgement("```json\n" + obj([{ key: "a", verdict: "drop" }]) + "\n```", ["a"], WORDS)?.[0]?.verdict, "drop");
  assert.equal(readJudgement(JSON.stringify([{ key: "a", verdict: "keep" }]), ["a"], WORDS)?.[0]?.verdict, "keep");
  assert.equal(readJudgement('Sure:\n{"verdicts":[{"key":"a","verdict":" KEEP "}]}', ["a"], WORDS)?.[0]?.verdict, "keep");
});

test("an answer in the given order needs no keys at all", () => {
  const v = readJudgement(obj([{ verdict: "drop" }, { verdict: "keep" }]), KEYS, WORDS);
  assert.deepEqual(v?.map((x) => [x.key, x.verdict]), [["a", "drop"], ["b", "keep"]]);
});

test("verdicts come back in the order asked, however the model ordered them", () => {
  const v = readJudgement(obj([{ key: "b", verdict: "drop" }, { key: "a", verdict: "keep" }]), KEYS, WORDS);
  assert.deepEqual(v?.map((x) => x.key), ["a", "b"]);
});

test("a partial answer is no answer", () => {
  /* Applying half and defaulting the rest reads downstream exactly like a model
     that approved the rest. */
  assert.equal(readJudgement(obj([{ key: "a", verdict: "keep" }]), KEYS, WORDS), null);
  assert.equal(readJudgement(obj([]), KEYS, WORDS), null);
});

test("a word outside the allowed set is never read as a verdict", () => {
  assert.equal(readJudgement(obj([{ key: "a", verdict: "maybe" }]), ["a"], WORDS), null);
  assert.equal(readJudgement(obj([{ key: "a", verdict: "" }]), ["a"], WORDS), null);
  assert.equal(readJudgement(obj([{ key: "a", verdict: "homework" }]), ["a"], WORDS), null);
});

test("a duplicated key cannot displace another item's verdict", () => {
  assert.equal(
    readJudgement(obj([{ key: "a", verdict: "keep" }, { key: "a", verdict: "drop" }]), KEYS, WORDS),
    null,
  );
});

test("prose, emptiness and broken JSON are all no answer", () => {
  assert.equal(readJudgement("I would keep the first and drop the second.", KEYS, WORDS), null);
  assert.equal(readJudgement("", ["a"], WORDS), null);
  assert.equal(readJudgement('{"verdicts":[{"key":"a","verdict":"keep"', ["a"], WORDS), null);
});

test("a why longer than the column is cut, not dropped", () => {
  const v = readJudgement(obj([{ key: "a", verdict: "keep", why: "z".repeat(500) }]), ["a"], WORDS);
  assert.equal(v?.[0]?.why.length, 300);
});

test("with no model reachable every item comes back unjudged, and it is on the record", async () => {
  /* There is no provider in a test process, which is the production case of a
     busy or missing GPU. */
  const res = await judge({
    gate: "test.gate",
    question: "Keep or drop?",
    items: [{ key: "a", text: "one" }, { key: "b", text: "two" }],
    allowed: WORDS,
  });
  assert.equal(res.verdicts.length, 2);
  assert.ok(res.verdicts.every((v) => v.verdict === "unjudged"), "nothing was judged");
  assert.ok(res.why && res.why.length > 0, "the result says why");
  assert.equal(res.by.get("a")?.verdict, "unjudged");

  const logged = recentVerdicts("test.gate");
  assert.equal(logged.length, 2, "both are recorded, so a silent gate is visible");
  assert.equal(logged[0]!.verdict, "unjudged");
});

test("an empty batch asks nothing and records nothing", async () => {
  const res = await judge({ gate: "test.gate", question: "?", items: [], allowed: WORDS });
  assert.deepEqual(res.verdicts, []);
  assert.equal(res.why, null);
  assert.equal(recentVerdicts("test.gate").length, 0);
});

test("the record keeps every pass, so a flip-flopping verdict is visible", () => {
  recordJudgement("test.gate", [{ key: "same subject", verdict: "keep", why: "monday" }], "m1");
  recordJudgement("test.gate", [{ key: "same subject", verdict: "drop", why: "tuesday" }], "m2");
  const rows = recentVerdicts("test.gate");
  assert.equal(rows.length, 2, "history, not an upsert");
  assert.deepEqual(rows.map((r) => r.verdict).sort(), ["drop", "keep"]);
});

test("one gate's record does not answer for another's", () => {
  recordJudgement("gate.one", [{ key: "x", verdict: "keep", why: "" }], null);
  assert.equal(recentVerdicts("gate.two").length, 0);
  assert.equal(recentVerdicts("gate.one").length, 1);
});
