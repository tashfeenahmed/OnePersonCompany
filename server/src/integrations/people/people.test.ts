/**
 * The arithmetic, tested where it can be tested without a mailbox.
 *
 * These are the eight lines the page rests on — cadence, temperature, the ISO
 * week the brief is filed under, the promise patterns and the grounding gate.
 * Everything else in this area is a Gmail call or a SQL statement, and neither
 * is a thing a unit test tells the truth about.
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
import { candidatesIn, cleanBody, grounded, isCloser, normalise, resolveDue, sentences } from "./commitments.ts";

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

test("a promise is first person, future, and not a question", () => {
  const found = candidatesIn(
    [
      "I'll send the contract on Thursday.",
      "You'll send the contract on Thursday.",
      "Can I send the contract on Thursday?",
      "I won't be able to send the contract.",
      "Let me know if you need anything else.",
    ].join("\n\n"),
  );
  assert.equal(found.length, 1);
  assert.match(found[0]!.sentence, /^I'll send the contract/);
  assert.equal(found[0]!.dueText, "on Thursday");
});

test("a closer with a real promise beside it keeps the promise", () => {
  assert.ok(isCloser("Let me know if you need anything else."));
  assert.ok(!isCloser("Let me know what you need and I'll get it sorted this week."));
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
