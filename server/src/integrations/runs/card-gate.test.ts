import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_CONTRACT, judgePrompt, readVerdicts } from "./card-gate.ts";

/* THE JUDGMENT ITSELF IS A MODEL'S and is not asserted here — a test that
   pinned the verdict for "Read their pricing page" would be testing the model,
   and it would pass against a stub while the real gate did something else. What
   IS tested is everything around the judgment that can be got wrong
   deterministically: reading the answer, refusing a half-answer, and what the
   model is shown. Those are where an LLM gate actually breaks. */

const obj = (verdicts: unknown) => JSON.stringify({ verdicts });

test("reads a well-formed answer", () => {
  const v = readVerdicts(
    obj([
      { index: 0, verdict: "change", why: "adds the property" },
      { index: 1, verdict: "homework", why: "only reads a rival's page" },
    ]),
    2,
  );
  assert.deepEqual(v, [
    { index: 0, verdict: "change", why: "adds the property" },
    { index: 1, verdict: "homework", why: "only reads a rival's page" },
  ]);
});

test("reads an answer wrapped in a fence, and a bare array without the wrapper", () => {
  const fenced = "```json\n" + obj([{ index: 0, verdict: "homework", why: "looking only" }]) + "\n```";
  assert.equal(readVerdicts(fenced, 1)?.[0]?.verdict, "homework");
  const bare = JSON.stringify([{ index: 0, verdict: "change", why: "ships a page" }]);
  assert.equal(readVerdicts(bare, 1)?.[0]?.verdict, "change");
});

test("reads a verdict whatever its case or padding, and preamble before the object", () => {
  const text = 'Sure, here you go:\n{"verdicts":[{"index":0,"verdict":" HOMEWORK ","why":"x"}]}';
  assert.equal(readVerdicts(text, 1)?.[0]?.verdict, "homework");
});

test("a missing index means the nth card answered", () => {
  const v = readVerdicts(obj([{ verdict: "change", why: "a" }, { verdict: "homework", why: "b" }]), 2);
  assert.deepEqual(v?.map((x) => [x.index, x.verdict]), [[0, "change"], [1, "homework"]]);
});

test("a half-answer is no answer, so nothing is filed on a guess", () => {
  /* The failure this prevents: a model judging two of five cards, the other
     three falling through to the caller's default, and that reading as the
     model having approved them. */
  assert.equal(readVerdicts(obj([{ index: 0, verdict: "change", why: "a" }]), 5), null);
  assert.equal(readVerdicts(obj([]), 2), null);
});

test("an unrecognised verdict word is never read as a refusal", () => {
  /* Guessing a refusal is how a gate eats real work, so "maybe" makes the whole
     answer unusable and the batch fails open instead. */
  assert.equal(readVerdicts(obj([{ index: 0, verdict: "maybe", why: "unsure" }]), 1), null);
  assert.equal(readVerdicts(obj([{ index: 0, verdict: "", why: "" }]), 1), null);
});

test("prose, an empty reply and broken JSON are all no answer", () => {
  assert.equal(readVerdicts("I think card one is fine and card two is homework.", 2), null);
  assert.equal(readVerdicts("", 1), null);
  assert.equal(readVerdicts('{"verdicts":[{"index":0,"verdict":"change"', 1), null);
});

test("an out-of-range or duplicated index cannot displace another card's verdict", () => {
  assert.equal(readVerdicts(obj([{ index: 7, verdict: "homework", why: "x" }]), 2), null);
  assert.equal(
    readVerdicts(obj([{ index: 0, verdict: "change", why: "a" }, { index: 0, verdict: "homework", why: "b" }]), 2),
    null,
  );
});

test("a why longer than the column is cut, not dropped", () => {
  const v = readVerdicts(obj([{ index: 0, verdict: "homework", why: "z".repeat(500) }]), 1);
  assert.equal(v?.[0]?.why.length, 300);
});

test("the prompt shows the judge every card, numbered, with its body and its context", () => {
  const p = judgePrompt(
    [
      { title: "Read their pricing page", body: "The register says unknown." },
      { title: "Fix the broken Arabic links", body: "Nine pages point at /ar/subjects." },
    ],
    { kind: "Competitors", venture: "v-abc" },
  );
  assert.match(p, /a Competitors run/);
  assert.match(p, /for v-abc/);
  assert.match(p, /0\. Read their pricing page/);
  assert.match(p, /1\. Fix the broken Arabic links/);
  assert.match(p, /The register says unknown\./);
  assert.match(p, /Judge all 2\./);
});

test("the prompt survives a card with no body and collapses runaway whitespace", () => {
  const p = judgePrompt([{ title: "Ship it", body: "" }]);
  assert.match(p, /\(no body\)/);
  const long = judgePrompt([{ title: "t", body: `a${"\n".repeat(40)}b` }]);
  assert.ok(!/\n\n\n/.test(long.split("0. t")[1] ?? ""), "a body's newlines are flattened");
});

test("the contract tells the model the same distinction the judge is asked to make", () => {
  /* If these two drift apart, a model gets refused for following its brief —
     the one failure mode a gate must not have. */
  assert.match(CARD_CONTRACT, /A CARD IS A CHANGE/);
  assert.match(CARD_CONTRACT, /A CARD IS NOT HOMEWORK/);
  assert.match(CARD_CONTRACT, /judged/);
});

test("the gate matches on no vocabulary of its own", async () => {
  /* The gate is a judgment, not a word list. This test exists so that a future
     edit reintroducing "refuse any title starting with X" has to delete a test
     that says why not. */
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./card-gate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /LOOKING_VERBS|CHANGE_WORDS|researchChore/);
});
