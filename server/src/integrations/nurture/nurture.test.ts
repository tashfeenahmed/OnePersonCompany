/**
 * The pure halves of the nurture area, pinned.
 *
 * THREE THINGS ARE TESTED AND THEY ARE THE THREE THAT WOULD FAIL SILENTLY AND
 * EXPENSIVELY.
 *
 * THE FACT VALIDATOR is the code that decides whether an email going out in the
 * owner's name may contain a number. A hole in it does not produce a wrong
 * figure on a page; it produces a wrong figure in a stranger's inbox, signed by
 * him. Every kind of token it separates — address, link, amount, date, plain
 * number — is exercised in both directions, because a gate that refuses
 * everything is as broken as one that allows everything and looks safer.
 *
 * DUE-STEP SELECTION decides which morning somebody gets written to. Off by one
 * and a person gets two emails in a day; wrong about the offset base and a step
 * inserted in the middle shoves the rest of the sequence forward for everybody
 * already enrolled.
 *
 * THE STOP CONDITIONS decide whether somebody who has already answered gets
 * written to again. The `hold` case is the one worth the test: a check that
 * could not be made must never read as "no".
 *
 * Nothing here opens the database or the network.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allowedFrom,
  dueStep,
  notAStyleRule,
  ungrounded,
  verdict,
  type Fact,
  type Observed,
  type SequenceStep,
} from "./validate.ts";
import { parseReply } from "./wording.ts";
import { messageIdHeader } from "./resend-send.ts";
import { parseRules } from "./style.ts";

const fact = (key: string, value: string | number, unit?: string): Fact => ({
  key,
  value,
  unit: unit ?? null,
  source: "a test",
  observed_at: "2026-09-06T10:00:00.000Z",
});

const PACKET: Fact[] = [
  fact("person.address", "mary@example.com"),
  fact("person.messages_from_them", 145, "messages"),
  fact("venture.website", "https://example-app-1.example.test"),
  fact("product.signed_up", "2026-08-12T09:00:00.000Z"),
  fact("pricing.month", 29, "EUR"),
];

/* ------------------------------------------------------------- the validator */

test("a body carrying only what the facts carry is clean", () => {
  const allowed = allowedFrom(PACKET);
  assert.equal(
    ungrounded(
      "Hello. You signed up on 2026-08-12 and have written 145 times. example-app-1.example.test is still there. It is €29 a month. mary@example.com is the address I have.",
      allowed,
    ),
    null,
  );
});

test("an invented number is refused and named", () => {
  const bad = ungrounded("It is 4000 words long.", allowedFrom(PACKET));
  assert.ok(bad && bad.includes("4000"), bad ?? "expected a refusal");
});

test("an invented address is refused before its digits are read as a price", () => {
  const bad = ungrounded("Write to sales7@other.com.", allowedFrom(PACKET));
  assert.ok(bad && bad.includes("sales7@other.com"), bad ?? "expected a refusal");
  /* And the address that IS in the packet passes, digits and all. */
  assert.equal(ungrounded("Write to mary@example.com.", allowedFrom([fact("a", "mary@example.com")])), null);
});

test("a link is checked by host: a new path on a known host passes, a new host does not", () => {
  const allowed = allowedFrom(PACKET);
  assert.equal(ungrounded("See https://example-app-1.example.test/pricing for more.", allowed), null);
  const bad = ungrounded("See https://example-app-1.co/pricing for more.", allowed);
  assert.ok(bad && bad.includes("example-app-1.co"), bad ?? "expected a refusal");
});

test("the currency has to match, not just the amount", () => {
  const allowed = allowedFrom(PACKET);
  assert.equal(ungrounded("It is €29 a month.", allowed), null);
  const bad = ungrounded("It is $29 a month.", allowed);
  assert.ok(bad && bad.includes("$29"), bad ?? "expected a refusal");
});

test("a unit that is a currency code turns a bare number into an allowed amount", () => {
  /* This is what lets a gatherer write { value: 29, unit: "EUR" } without
     having to put the symbol into the value itself. */
  const allowed = allowedFrom([fact("price", 29, "EUR")]);
  assert.equal(ungrounded("Twenty-nine euro is €29.", allowed), null);
  assert.ok(ungrounded("It is £29.", allowed));
});

test("a date the packet does not carry is refused in both the ISO and the spelled form", () => {
  const allowed = allowedFrom(PACKET);
  assert.equal(ungrounded("You signed up on 2026-08-12.", allowed), null);
  assert.equal(ungrounded("You signed up on 12 August.", allowed), null);
  /* A date is the one fact a letter can invent that somebody will act on. */
  const iso = ungrounded("Let us speak on 2026-10-01.", allowed);
  assert.ok(iso && iso.includes("2026-10-01"), iso ?? "expected a refusal");
  const spelled = ungrounded("Let us speak on 1 October.", allowed);
  assert.ok(spelled && spelled.includes("October"), spelled ?? "expected a refusal");
});

test("a fact's observed_at licenses nothing", () => {
  /* The day this box happened to run a collector is not news the letter may
     quote, so it is deliberately not walked into the allowed set. */
  const allowed = allowedFrom([
    { key: "k", value: "no numbers here", unit: null, source: "s", observed_at: "2026-01-02T00:00:00.000Z" },
  ]);
  assert.ok(ungrounded("We looked on 2026-01-02.", allowed));
});

test("a count written as a digit is refused, which is the trade being made", () => {
  const bad = ungrounded("I have three questions, or 3 if you prefer.", allowedFrom(PACKET));
  assert.ok(bad && bad.includes("counts belong spelled as words"), bad ?? "expected a refusal");
  assert.equal(ungrounded("I have three questions.", allowedFrom(PACKET)), null);
});

test("an unparseable link is refused outright rather than allowed through", () => {
  assert.ok(ungrounded("http://[not a url", allowedFrom(PACKET)) !== null);
});

/* --------------------------------------------------------------- style rules */

test("a style rule may not carry a fact wearing a rule's clothes", () => {
  assert.equal(notAStyleRule("keep the greeting to one word"), null);
  assert.ok(notAStyleRule("keep it under 4 sentences")!.includes("digit"));
  assert.ok(notAStyleRule("sign off with hello@example-app-1.example.test")!.includes("email address"));
  assert.ok(notAStyleRule("link to https://example-app-1.example.test")!.includes("link"));
  assert.ok(notAStyleRule("mention example-app-1.example.test early")!.includes("domain"));
  assert.ok(notAStyleRule("greet people the way you greet Mary")!.includes("name"));
  assert.ok(notAStyleRule("short")!.includes("too short"));
});

test("the first person survives, because a rule about how he writes is written in it", () => {
  assert.equal(notAStyleRule("open with what I want, never with a pleasantry"), null);
});

test("a rule's wrapping quotes come off and a trailing quoted phrase survives", () => {
  assert.deepEqual(parseRules('- "keep it short"\n- never write "i hope this finds you well"'), [
    "keep it short",
    'never write "i hope this finds you well"',
  ]);
});

/* ------------------------------------------------------------ the due step */

const STEPS: SequenceStep[] = [
  { dayOffset: 0, purpose: "welcome" },
  { dayOffset: 3, purpose: "check in" },
  { dayOffset: 10, purpose: "last note" },
];

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T09:00:00.000Z");

test("the first step is due at enrolment and the second is not", () => {
  const now = T0 + 60_000;
  const first = dueStep({ step: 0, enrolledAtMs: T0 }, STEPS, now);
  assert.deepEqual(first, { index: 0, dueAtMs: T0 });
  const second = dueStep({ step: 1, enrolledAtMs: T0 }, STEPS, now);
  assert.ok("skip" in second && second.skip.includes("2026-09-04"), JSON.stringify(second));
});

test("offsets are measured from ENROLMENT, not from the previous step", () => {
  /* Step three is dayOffset 10, so it is due ten days after enrolment however
     late step two was actually drafted. A cumulative reading would put it at
     thirteen and quietly stretch every sequence. */
  assert.deepEqual(dueStep({ step: 2, enrolledAtMs: T0 }, STEPS, T0 + 10 * DAY), {
    index: 2,
    dueAtMs: T0 + 10 * DAY,
  });
  assert.ok("skip" in dueStep({ step: 2, enrolledAtMs: T0 }, STEPS, T0 + 9 * DAY));
});

test("past the last step is done, and done is not a skip with a reason", () => {
  const out = dueStep({ step: 3, enrolledAtMs: T0 }, STEPS, T0 + 90 * DAY);
  assert.ok("skip" in out && out.done === true, JSON.stringify(out));
});

test("a step with an unusable offset is never due, rather than immediately due", () => {
  const broken: SequenceStep[] = [{ dayOffset: Number.NaN, purpose: "x" }];
  const out = dueStep({ step: 0, enrolledAtMs: T0 }, broken, T0 + 90 * DAY);
  assert.ok("skip" in out && !out.done && out.skip.includes("dayOffset"), JSON.stringify(out));
});

test("a sequence with no steps is due nothing and is not 'done'", () => {
  const out = dueStep({ step: 0, enrolledAtMs: T0 }, [], T0);
  assert.ok("skip" in out && out.done === undefined, JSON.stringify(out));
});

/* ------------------------------------------------------ the stop conditions */

const observed = (over: Partial<Observed> = {}): Observed => ({
  repliedAt: null,
  paying: null,
  dismissedDraft: false,
  optedOut: false,
  unreachable: null,
  ...over,
});

const ALL = ["replied", "purchased", "dismissed", "unsubscribed"];

test("a reply stops a sequence that subscribes to it, and not one that does not", () => {
  const r = verdict(observed({ repliedAt: "2026-09-05T12:00:00.000Z" }), ALL);
  assert.ok("stop" in r && r.stop === "replied" && r.why.includes("2026-09-05"), JSON.stringify(r));
  assert.deepEqual(verdict(observed({ repliedAt: "2026-09-05T12:00:00.000Z" }), ["purchased"]), { go: true });
});

test("a purchase stops it, and 'the product did not say' does not", () => {
  assert.ok("stop" in verdict(observed({ paying: true }), ALL));
  /* null is "asked and not told". Reading it as false would keep writing to
     somebody who has already bought; reading it as true would stop everybody. */
  assert.deepEqual(verdict(observed({ paying: null }), ALL), { go: true });
  assert.deepEqual(verdict(observed({ paying: false }), ALL), { go: true });
});

test("an opt-out stops it whatever the sequence subscribes to", () => {
  const r = verdict(observed({ optedOut: true }), []);
  assert.ok("stop" in r && r.stop === "unsubscribed", JSON.stringify(r));
});

test("a check that could not be made HOLDS — it never reads as 'no'", () => {
  const r = verdict(observed({ unreachable: "cannot check for a reply — Gmail answered 403" }), ALL);
  assert.ok("hold" in r && r.hold.includes("403"), JSON.stringify(r));
  /* And a hold is not a stop: the person stays enrolled and simply gets
     nothing written today. */
  assert.ok(!("stop" in r));
});

test("a stop that is already known does not wait on an unreachable check", () => {
  const r = verdict(observed({ optedOut: true, unreachable: "Gmail is down" }), ALL);
  assert.ok("stop" in r, JSON.stringify(r));
});

/* ------------------------------------------------------------- the plumbing */

test("a model answer parses only when it carries both a subject and a body", () => {
  assert.deepEqual(parseReply("SUBJECT: Hello there\nBODY:\nThe message."), {
    subject: "Hello there",
    body: "The message.",
  });
  assert.deepEqual(parseReply("```\nSUBJECT: A\nBODY:\nB\n```"), { subject: "A", body: "B" });
  /* A subject invented by this parser is a subject nobody wrote, so a
     malformed answer is a refusal rather than a repair. */
  assert.equal(parseReply("Sure! Here is your email: Hi there."), null);
  assert.equal(parseReply("SUBJECT: only a subject"), null);
});

test("a Message-ID header is bracketed, and a Gmail message id is not one", () => {
  assert.equal(messageIdHeader("abc@mail.example.com"), "<abc@mail.example.com>");
  assert.equal(messageIdHeader("<abc@mail.example.com>"), "<abc@mail.example.com>");
  /* A Gmail message id has no @ in it. A wrong In-Reply-To threads worse than
     none, so it comes back null rather than bracketed and hoped for. */
  assert.equal(messageIdHeader("19936f0a1b2c3d4e"), null);
  assert.equal(messageIdHeader(null), null);
  assert.equal(messageIdHeader("a@b\r\nBcc: victim@x.com"), null);
});
