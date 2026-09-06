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
import { DatabaseSync } from "node:sqlite";
import {
  allowedFrom,
  dueStep,
  notAStyleRule,
  purchaseUnreachable,
  truthy,
  ungrounded,
  verdict,
  type Fact,
  type Observed,
  type SequenceStep,
} from "./validate.ts";
import { MIGRATIONS } from "./migrations.ts";
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
  fact("venture.website", "https://acme.ie"),
  fact("product.signed_up", "2026-08-12T09:00:00.000Z"),
  fact("pricing.month", 29, "EUR"),
];

/* ------------------------------------------------------------- the validator */

test("a body carrying only what the facts carry is clean", () => {
  const allowed = allowedFrom(PACKET);
  assert.equal(
    ungrounded(
      "Hello. You signed up on 2026-08-12 and have written 145 times. acme.ie is still there. It is €29 a month. mary@example.com is the address I have.",
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
  assert.equal(ungrounded("See https://acme.ie/pricing for more.", allowed), null);
  const bad = ungrounded("See https://acme.co/pricing for more.", allowed);
  assert.ok(bad && bad.includes("acme.co"), bad ?? "expected a refusal");
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
  assert.ok(notAStyleRule("sign off with hello@acme.ie")!.includes("email address"));
  assert.ok(notAStyleRule("link to https://acme.ie")!.includes("link"));
  assert.ok(notAStyleRule("mention acme.ie early")!.includes("domain"));
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

/* ------------------------------------------ regressions from the review */

/**
 * P1-1. `MONEY_CODE_RE` used to match any `<number> <three letters>` and then
 * STRIP every match — currency or not — before the date and number checks. In
 * ordinary prose almost every number and every abbreviated date sits beside a
 * three-letter word, so the gate this file exists to be was largely
 * inoperative. These are the reviewer's own sentences, against an EMPTY packet:
 * every one of them must be refused, and none of them is about money.
 */
test("a number or a date beside a three-letter word is still checked", () => {
  const empty = allowedFrom([]);
  for (const [sentence, expect] of [
    ["We saved you 500 per month.", "500"],
    ["You have 300 new users waiting.", "300"],
    ["The trial ends 12 Sep.", "12 Sep"],
    ["Deadline 3 Oct, no later.", "3 Oct"],
  ] as const) {
    const bad = ungrounded(sentence, empty);
    assert.ok(bad?.includes(expect), `${sentence} → ${bad}`);
  }
});

test("a non-currency triple no longer eats the real amount after it", () => {
  /* `matchAll` continues from the end of each match, so "you 4000" used to be
     consumed and skipped and "4000 usd" never seen as money at all. With the
     packet carrying 4000 EUR, the dollar figure must still be refused. */
  const allowed = allowedFrom([{ key: "p", value: 4000, unit: "EUR", source: "t", observed_at: null }]);
  const bad = ungrounded("We refunded you 4000 usd already.", allowed);
  assert.ok(bad?.includes("4000 usd"), bad ?? "expected a currency refusal");
  assert.equal(ungrounded("We refunded you 4000 eur already.", allowed), null);
});

/**
 * P1-2. `URL_RE` requires a scheme, and nothing else read hosts out of a body —
 * so a bare domain, which is how a link usually appears in prose and which
 * every mail client autolinks, was never checked at all.
 */
test("a link with no scheme is checked like any other", () => {
  const empty = allowedFrom([]);
  const bad = ungrounded("Read more at competitor-phish.com/deal", empty);
  assert.ok(bad?.includes("competitor-phish.com"), bad ?? "expected a host refusal");
  assert.ok(ungrounded("Have a look at example.org", empty));
  /* A host the packet carries passes with or without a scheme, and an address
     is not read as a link — it has already been checked as an address. */
  const allowed = allowedFrom([
    { key: "w", value: "https://acme.ie", source: "t", observed_at: null },
    { key: "a", value: "mary@example.com", source: "t", observed_at: null },
  ]);
  assert.equal(ungrounded("See acme.ie and acme.ie/pricing.", allowed), null);
  assert.equal(ungrounded("Write to mary@example.com.", allowed), null);
});

/**
 * P1-3. `dryRun` was a `=== true` identity check on a parameter the skill
 * publishes as a string, and `routes/skills.ts` forwards arguments verbatim —
 * so an agent following the schema sent "true", the check never fired, and an
 * action documented as "file nothing" filed a real row that then held the
 * address down for the whole per-address floor.
 */
test("a flag arriving as a string is read as a flag", () => {
  for (const yes of [true, "true", "True", " yes ", "on", "1", 1]) assert.equal(truthy(yes), true, String(yes));
  for (const no of [false, "false", "no", "off", "0", "", undefined, null, {}, "maybe"])
    assert.equal(truthy(no), false, String(no));
});

/**
 * P1-4. The once-a-day row was written at the END of the pass, so the primary
 * key did not serialise anything: the timer fires every ten minutes, a pass can
 * take longer, and both runners saw no row for today. The claim is now an
 * INSERT OR IGNORE before any work, and this is that property — over the real
 * migration SQL, in memory, with no app database.
 */
test("the day row is a claim: the second writer loses the race", () => {
  const db = new DatabaseSync(":memory:");
  const sql = MIGRATIONS.find((m) => m.name === "282_nurture_enrollments")!.sql;
  db.exec(sql);
  const claim = (trigger: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO nurture_passes (day, ran_at, ok, enrolled, drafted, stopped, skipped, trigger, error)
         VALUES (?, ?, 1, 0, 0, 0, '[]', ?, NULL)`,
      )
      .run("2026-09-06", "2026-09-06T08:00:00.000Z", trigger).changes;
  assert.equal(Number(claim("timer")), 1);
  assert.equal(Number(claim("owner")), 0, "a second runner on the same day must claim nothing");
  assert.equal(Number(claim("agent")), 0);
  /* And the counters accumulate onto the claimed row rather than replacing it,
     so a forced second pass does not erase what the first one put in the
     queue. */
  db.prepare("UPDATE nurture_passes SET drafted = drafted + ? WHERE day = ?").run(3, "2026-09-06");
  db.prepare("UPDATE nurture_passes SET drafted = drafted + ? WHERE day = ?").run(2, "2026-09-06");
  assert.equal(
    (db.prepare("SELECT drafted FROM nurture_passes WHERE day = ?").get("2026-09-06") as { drafted: number }).drafted,
    5,
  );
  db.close();
});

/**
 * P1-5. `paying: null` meant both "this address is not in a connected product's
 * users document" and "no product here publishes one at all", and neither set
 * `unreachable` — so a sequence stopping on a purchase kept drafting when the
 * purchase question could not be asked, which is exactly what `verdict`'s
 * header says must never happen.
 */
test("a purchase question that cannot be asked holds the enrolment", () => {
  const cannot =
    "no product on this install publishes a users document (the `users` plugin is not connected), so nothing here knows who signed up or who is paying";
  const absent = "no connected product's users document carries this address";

  assert.ok(purchaseUnreachable(["purchased"], cannot)?.includes("cannot check whether they have bought"));
  /* A person simply not in the document is a FACT about them, not silence. */
  assert.equal(purchaseUnreachable(["purchased"], absent), null);
  /* And a sequence that does not stop on a purchase is not held by it. */
  assert.equal(purchaseUnreachable(["replied"], cannot), null);

  const held = verdict(observed({ paying: null, unreachable: purchaseUnreachable(["purchased"], cannot) }), [
    "purchased",
  ]);
  assert.ok("hold" in held, JSON.stringify(held));
  assert.deepEqual(verdict(observed({ paying: null }), ["purchased"]), { go: true });
});

/** P2-10. The name check only caught `Xxxx`, so a product name and two common
 *  shapes of a person's name reached the wording prompt. */
test("a style rule refuses every shape of a capitalised name", () => {
  assert.ok(notAStyleRule("sound more like AcmeTutor")!.includes("name"));
  assert.ok(notAStyleRule("greet them the way you greet Jane-Smith")!.includes("name"));
  assert.ok(notAStyleRule("write the way ACME writes")!.includes("name"));
  assert.equal(notAStyleRule("keep the greeting to one word"), null);
});
