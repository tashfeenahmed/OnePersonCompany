/**
 * The arithmetic, tested where it can be tested without a mailbox.
 *
 * These are the lines the page rests on — cadence, temperature, the ISO week
 * the brief is filed under, what reaches the promise judge, and the grounding
 * gate. Everything else in this area is a Gmail call, a SQL statement or a
 * model's judgment, and a unit test tells the truth about none of the three.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_QUIET_DAYS,
  cadence,
  displayName,
  looksBulk,
  temperature,
  weightOf,
} from "./contacts.ts";
import { isoWeek, refuse, type Figures } from "./brief.ts";
import {
  MAX_CANDIDATES,
  PROMISE_GATE,
  PROMISE_WORDS,
  QUESTION,
  candidatesIn,
  cleanBody,
  grounded,
  judgePromises,
  keep,
  normalise,
  refine,
  resolveDue,
  sentences,
} from "./commitments.ts";
import { db } from "../../db.ts";
import { recentVerdicts } from "../../models/judge.ts";

/* ------------------------------------------------------------------ cadence */

test("cadence is the median gap between contact DAYS, not messages", () => {
  /* Four messages on one Tuesday is one contact day and no gaps at all. */
  assert.deepEqual(cadence([100, 100, 100, 100]), { days: null, gaps: 0 });
  /* Five weekly days give four gaps of seven — the minimum that says anything. */
  assert.deepEqual(cadence([0, 7, 14, 21, 28]), { days: 7, gaps: 4 });
  /* One long silence must not drag the answer the way a mean would: the mean
     of 7,7,7,120 is 35 and the median is 7. */
  assert.equal(cadence([0, 7, 14, 21, 141]).days, 7);
});

test("under four gaps there is no rhythm and therefore no claim", () => {
  const c = cadence([0, 7, 14, 21]);
  assert.equal(c.days, null);
  assert.equal(c.gaps, 3);
  assert.equal(temperature(c.days, 400).temperature, null);
});

/* -------------------------------------------------------------- temperature */

test("temperature is relative to the pair, never to the calendar", () => {
  assert.equal(temperature(7, 42).temperature, "cold"); // 6× a weekly rhythm
  assert.equal(temperature(7, 14).temperature, "cooling"); // 2×
  assert.equal(temperature(7, 5).temperature, "warm");
  /* The one that makes the whole design worth having: somebody written to
     once a year is not cold six weeks after the last letter. */
  assert.equal(temperature(365, 42).temperature, "warm");
  /* And the floor: a daily correspondence is not broken after three days. */
  assert.equal(temperature(1, MIN_QUIET_DAYS - 1).temperature, "warm");
  assert.equal(temperature(1, 21).temperature, "cold");
});

test("a temperature with no measurement says which measurement is missing", () => {
  assert.match(temperature(null, 40).why, /not enough separate days/);
  assert.match(temperature(7, null).why, /no dated message/);
});

test("weight counts the smaller side ten times over", () => {
  assert.equal(weightOf(10, 10), 120);
  /* A one-way blast of forty is worth less than a two-way five. */
  assert.ok(weightOf(5, 5) > weightOf(40, 0));
});

/* -------------------------------------------------------------- the people */

test("machine addresses are refused and ordinary ones are not", () => {
  assert.ok(looksBulk("no-reply@stripe.com"));
  assert.ok(looksBulk("noreply-billing@x.io"));
  assert.ok(looksBulk("notifications-team@google.com"));
  assert.ok(!looksBulk("jane@acme.io"));
  /* The deliberate non-guesses: these are real people at their own domains. */
  assert.ok(!looksBulk("hello@someone.com"));
  assert.ok(!looksBulk("info@studio.ie"));
});

test("a display name is never invented from the address", () => {
  assert.equal(displayName("Jane Smith"), "Jane Smith");
  assert.equal(displayName('"Jane Smith"'), "Jane Smith");
  assert.equal(displayName("jane@acme.io"), null);
  assert.equal(displayName("+353 87 000"), null);
  assert.equal(displayName(""), null);
});

/* ---------------------------------------------------------------- the week */

test("the ISO week is the calendar's, including the ones that cross a year", () => {
  assert.equal(isoWeek(new Date("2026-09-05T12:00:00Z")), "2026-W36");
  /* 2027-01-01 is a Friday, so it belongs to 2026's last week. */
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(isoWeek(new Date("2026-01-01T12:00:00Z")), "2026-W01");
});

/* ------------------------------------------------------------ the validator */

const FIGURES = {
  counts: { tracked: 12, warm: 4, cooling: 3, cold: 5, noRhythm: 0, stale: 2 },
  windowDays: 365,
  wentQuiet: [{ address: "jane@acme.io", name: "Jane Smith", quietDays: 31, cadenceDays: 9 }],
} as unknown as Figures;

test("the paragraph is refused for a number the figures do not carry", () => {
  assert.equal(refuse("Twelve correspondences, 3 of them cooling.", FIGURES), null);
  assert.match(refuse("You have 47 contacts.", FIGURES) ?? "", /number/);
});

test("the paragraph is refused for an invented person or address", () => {
  assert.equal(refuse("Jane Smith has been quiet for 31 days.", FIGURES), null);
  assert.match(refuse("Peter Nolan has been quiet.", FIGURES) ?? "", /name/);
  assert.match(refuse("Write to bob@other.io.", FIGURES) ?? "", /address/);
});

/* ------------------------------------------------------------- commitments */

/* WHAT IS TESTED HERE AND WHAT IS NOT. Whether a sentence is a promise is a
   model's judgment and nothing below asserts one: a test pinning "I'll send the
   contract" to `promise` would be testing the model, and it would pass against
   a stub while the live gate did something else. What is tested is everything
   around the judgment that can be got wrong deterministically — cutting the
   mail client's furniture off, healing a wrapped sentence, which sentences are
   put to the judge at all, what the judge is asked, and what happens to a batch
   nobody judged. Those are where an LLM gate actually breaks. */

test("everything below a quote marker is somebody else's writing", () => {
  const body = cleanBody(
    "I'll send the invoice on Friday.\n\nOn Tue, 1 Sep 2026, Jane wrote:\n> I'll pay you double.",
  );
  assert.ok(body.includes("I'll send the invoice"));
  assert.ok(!body.includes("pay you double"));
});

test("a signature ends the message", () => {
  const body = cleanBody("I'll call you Monday.\n--\nAlex\nI'll do anything you like");
  assert.ok(!body.includes("anything you like"));
});

test("a hard-wrapped sentence is healed rather than cut in half", () => {
  const s = sentences("I'll send you the deck\nand the numbers on Friday.");
  assert.deepEqual(s, ["I'll send you the deck and the numbers on Friday."]);
});

test("every sentence he wrote is put to the judge, whatever words it uses", () => {
  /* THE BUG THIS REPLACED. The old pass required one of fifty-nine doing verbs
     after a first-person-future marker, and the model that ran afterwards was
     only allowed to REMOVE — so a promise worded any other way was invisible
     and unrecoverable. All four of these reach the judge now; which of them is
     a promise is the judge's business and not this file's. */
  const found = candidatesIn(
    [
      "I'll knock the deck into shape tonight.",
      "You'll send the contract on Thursday.",
      "Can I send the contract on Thursday?",
      "Let me know if you need anything else.",
    ].join("\n\n"),
  );
  assert.equal(found.length, 4);
  assert.deepEqual(
    found.map((c) => c.sentence),
    [
      "I'll knock the deck into shape tonight.",
      "You'll send the contract on Thursday.",
      "Can I send the contract on Thursday?",
      "Let me know if you need anything else.",
    ],
  );
});

test("the same sentence twice in one message is one candidate, and a fragment is none", () => {
  const found = candidatesIn(
    "I'll send the contract on Thursday.\n\nI'll send the contract on Thursday.\n\nThanks.",
  );
  assert.equal(found.length, 1);
  /* Under twelve characters there is no sentence to judge and no span the
     grounding test could check. */
  assert.ok(!found.some((c) => c.sentence.startsWith("Thanks")));
});

test("the deadline is lifted from his own words and stays code", () => {
  /* A date FORMAT is a fact, not a matter of meaning, so it did not move to a
     model with the rest of the gate. */
  const found = candidatesIn("I'll send the contract on Thursday.");
  assert.equal(found[0]!.dueText, "on Thursday");
  assert.equal(candidatesIn("I'll send the contract when I can.")[0]!.dueText, null);
});

test("nothing in the candidate pass caps the batch — the ceiling is where it is counted", () => {
  /* The per-message ceiling lives in the scan, which reports what it did not
     show as `unshown`. A silent cap here would be the old bug in a new place:
     sentences disappearing with nothing on the page to say so. */
  const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `Sentence number ${i} of mine.`);
  assert.equal(candidatesIn(many.join("\n\n")).length, MAX_CANDIDATES + 5);
});

test("the judge is asked for one of two words, and told which way to lean", () => {
  /* The lean is the whole reason this gate differs from the others: these
     sentences reach an outbound draft, so an unsure "promise" can put an
     undertaking he never gave into a real email. If somebody softens the
     question, this test is what they have to delete first. */
  assert.deepEqual([...PROMISE_WORDS], ["promise", "not"]);
  assert.match(QUESTION, /WHEN YOU ARE GENUINELY UNSURE, ANSWER "not"/);
  assert.match(QUESTION, /drafter/);
  /* And the cases the four deleted word lists used to cover, by name. */
  assert.match(QUESTION, /question he is asking/i);
  assert.match(QUESTION, /closing pleasantry/i);
  assert.match(QUESTION, /won't be able/i);
  assert.match(QUESTION, /Judge the sentence ALONE/);
});

test("a batch nobody judged files nothing, and says so on the record", async () => {
  /* No provider answers in a test process, which is the production case of a
     busy or missing GPU. Everywhere else in this codebase failing open means
     letting the content through; here it means silence, because letting a
     sentence through means asserting he promised something. */
  db.exec("DELETE FROM gate_verdicts WHERE gate = 'people.commitment'");
  const candidates = candidatesIn("I'll send the contract on Thursday.\n\nGood to meet you today.");
  const gate = await judgePromises(candidates, "msg-1");
  assert.equal(gate.judged.length, 2);
  assert.ok(gate.judged.every((j) => j.verdict === "unjudged"));
  assert.equal(keep(gate.judged).length, 0, "nothing is filed on a judgment nobody made");
  assert.ok(gate.why, "the scan is told why, so it can put it on the page");

  const logged = recentVerdicts(PROMISE_GATE);
  assert.equal(logged.length, 2, "an unjudged pass is visible rather than silent");
  /* THE SUBJECT IS A POINTER, NOT THE SENTENCE. gate_verdicts must not become a
     copy of every line he has ever written to anybody. */
  assert.deepEqual(logged.map((r) => r.subject).sort(), ["msg-1#1", "msg-1#2"]);
  assert.ok(!logged.some((r) => r.subject.includes("contract")));
});

test("keep() passes only what was judged a promise", () => {
  const c = (sentence: string) => ({ sentence, dueText: null, clipped: false });
  const kept = keep([
    { candidate: c("one"), verdict: "promise", why: "" },
    { candidate: c("two"), verdict: "not", why: "" },
    { candidate: c("three"), verdict: "unjudged", why: "" },
  ]);
  assert.deepEqual(kept.map((k) => k.sentence), ["one"]);
});

test("with no model the span pass keeps every promise, untouched", async () => {
  /* The other half of the model pass fails open the ordinary way: a promise
     with an untidy title is still a promise. */
  const candidates = candidatesIn("I'll send the contract on Thursday.");
  const refined = await refine(candidates, normalise("I'll send the contract on Thursday."));
  assert.equal(refined.items.length, 1);
  assert.equal(refined.items[0]!.by, "verbatim");
  assert.equal(refined.items[0]!.what, refined.items[0]!.sentence);
});

test("a model span must be literally in the message or it is thrown away", () => {
  const body = normalise("I'll send the contract on Thursday.");
  assert.ok(grounded("I'll send the contract", body));
  assert.ok(!grounded("I'll fix the contract", body));
  /* Too short to claim anything: two words match almost any message. */
  assert.ok(!grounded("I'll", body));
});

test("a deadline is resolved only where the words resolve, and never invented", () => {
  const friday = Date.parse("2026-09-01T10:00:00Z"); // a Tuesday
  assert.equal(resolveDue("on Thursday", friday), "2026-09-03");
  assert.equal(resolveDue("tomorrow", friday), "2026-09-02");
  /* The ones this box refuses to decide. */
  assert.equal(resolveDue("by end of the week", friday), null);
  assert.equal(resolveDue(null, friday), null);
  assert.equal(resolveDue("on Thursday", null), null);
});

test("the gate matches on no vocabulary of its own", async () => {
  /* The promise gate is a judgment, not a word list. This test exists so that a
     future edit reintroducing "a promise starts with I'll" has to delete a test
     that says why not. The names are the four constants and the two helpers
     that were deleted on 2026-09-21. */
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./commitments.ts", import.meta.url), "utf8");
  const code = src.slice(src.indexOf("import "));
  assert.doesNotMatch(code, /\bFUTURE\b|\bNEGATION\b|\bVERBS\b|\bCLOSERS\b|qualifyingMarks|isCloser/);
});
