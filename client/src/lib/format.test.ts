/**
 * THE FORMATTERS, WHICH ARE WHERE THE SILENT WRONG ANSWERS WERE.
 *
 * Every case below is a bug that shipped, not a hypothetical. The copies these
 * functions replace disagreed with each other and nothing failed: no type
 * error, no console warning, just a different number on two pages. Pure
 * functions with no DOM, so they can be checked exactly — which is the whole
 * argument for having moved them out of the components.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  splitMoney,
  DASH,
  ago,
  bytes,
  compact,
  count,
  day,
  duration,
  durationS,
  inDays,
  money,
  pct,
  when,
} from "./format.ts";

/* ------------------------------------------------------------- the dash */

test("nothing renders a missing figure as a zero", () => {
  for (const rendered of [
    pct(null),
    pct(undefined),
    pct(Number.NaN),
    duration(null),
    durationS(null),
    inDays(null),
    money(null, "EUR"),
    bytes(null),
    count(null),
    compact(null),
    when(null),
    count(Number.NaN),
    bytes(Number.POSITIVE_INFINITY),
  ])
    assert.equal(rendered, DASH);
});

test("a caller whose absence has a meaning says the word itself", () => {
  assert.equal(duration(null, { nullText: "still going" }), "still going");
  assert.equal(when(null, { nullText: "never" }), "never");
  assert.equal(money(null, "USD", { nullText: "not priced" }), "not priced");
});

/* -------------------------------------------------------------- percent */

test("pct takes a 0-1 fraction and only a fraction", () => {
  /* The bug: three exports named pct, two input conventions, so 0.4 rendered
     as "0.4%" where "40%" was meant. */
  assert.equal(pct(0.4), "40%");
  assert.equal(pct(1), "100%");
  assert.equal(pct(0.0314), "3.1%");
  assert.equal(pct(0), "0%");
  assert.equal(pct(-0.125), "-12.5%");
  /* A caller holding a server percent divides at the call site, visibly. */
  assert.equal(pct(40 / 100), "40%");
});

test("pct drops a trailing zero and honours a digit count", () => {
  assert.equal(pct(0.5), "50%");
  assert.equal(pct(0.12345, { digits: 2 }), "12.35%");
  assert.equal(pct(0.12345, { digits: 0 }), "12%");
});

/* ------------------------------------------------------------- duration */

test("duration reads milliseconds and durationS reads seconds", () => {
  /* The bug: two exports named duration a factor of 1000 apart, so a
     four-second run rendered as "1h 6m" through the wrong import. */
  assert.equal(duration(4000), "4.0s");
  assert.equal(durationS(4), "4s");
  assert.equal(duration(240), "240ms");
  assert.equal(duration(95_000), "1m 35s");
  assert.equal(duration(3_599_600), "1h 0m", "the seconds round up into the hour rather than rendering 59m 60s");
  assert.equal(duration(3_598_600), "59m 59s");
  assert.equal(duration(3_960_000), "1h 6m");
  assert.equal(durationS(3960), "1h");
  assert.equal(duration(-1), DASH, "a negative elapsed time is a clock problem, not a duration");
});

test("durationS keeps hours until two days, where a span is still read in hours", () => {
  assert.equal(durationS(36 * 3600), "36h");
  assert.equal(durationS(72 * 3600), "3d");
});

/* ------------------------------------------------------------------ ago */

test("ago switches to days at 24 hours, not 48", () => {
  /* The bug: one copy switched at 48h, so the same reading was "36h ago" on
     one panel and "2d ago" on the next. */
  const back = (ms: number) => new Date(Date.now() - ms).toISOString();
  assert.equal(ago(back(10_000)), "just now");
  assert.equal(ago(back(5 * 60_000)), "5m ago");
  assert.equal(ago(back(6 * 3_600_000)), "6h ago");
  assert.equal(ago(back(36 * 3_600_000)), "2d ago");
  assert.equal(ago(back(23 * 3_600_000)), "23h ago");
});

test("ago takes epoch milliseconds as well as an ISO string", () => {
  assert.equal(ago(Date.now() - 5 * 60_000), "5m ago");
});

test("ago says never for a missing stamp and a dash for one that will not parse", () => {
  assert.equal(ago(null), "never");
  assert.equal(ago(""), "never");
  assert.equal(ago("not a date"), DASH);
  assert.equal(ago(null, { nullText: "not collected" }), "not collected");
});

/* ----------------------------------------------------------------- when */

test("when echoes a malformed stamp rather than drawing Invalid Date", () => {
  /* The bug: one of the nine copies had no NaN guard. */
  assert.equal(when("2026-13-45"), "2026-13-45");
  assert.equal(when("whenever"), "whenever");
});

test("when draws a real date", () => {
  const rendered = when("2026-09-06T14:02:00Z");
  assert.notEqual(rendered, DASH);
  assert.ok(!rendered.includes("Invalid"));
});

/* ------------------------------------------------------------------ day */

test("a bare YYYY-MM-DD is read in UTC, so the day drawn is the day stored", () => {
  /* The bug: `Date.parse("2026-09-05")` is midnight UTC, so every zone west of
     Greenwich drew a card due on the 5th as due on the 4th. This case holds in
     every zone — run the suite under TZ=Pacific/Midway and TZ=Pacific/Kiritimati
     and it is the same day both times, which is the point. */
  const rendered = day("2026-09-05");
  assert.ok(rendered.includes("5"), rendered);
  assert.ok(!rendered.includes("4"), rendered);
});

test("day carries no clock, which is the whole reason it is not when", () => {
  const rendered = day("2026-09-05T23:30:00Z");
  assert.ok(!rendered.includes(":"), rendered);
});

test("day takes the year in either width, and omits it unasked", () => {
  assert.ok(!day("2026-09-05").includes("26"));
  assert.ok(day("2026-09-05", { year: true }).includes("2026"));
  assert.ok(day("2026-09-05", { year: "2-digit" }).includes("26"));
});

test("day is absent as the dash and echoes what will not parse", () => {
  assert.equal(day(null), DASH);
  assert.equal(day(null, { nullText: "no deadline" }), "no deadline");
  assert.equal(day("whenever"), "whenever");
});

/* --------------------------------------------------------------- inDays */

test("inDays says the distance in words, with the tail units", () => {
  assert.equal(inDays(0), "today");
  assert.equal(inDays(41), "in 41d");
  assert.equal(inDays(-12), "12d ago");
  assert.equal(inDays(200), "in 7mo");
  assert.equal(inDays(500), "in 1.4y");
  /* A year of months is a year: the old cut at 400 days printed "in 13mo". */
  assert.equal(inDays(370), "in 1.0y");
  assert.equal(inDays(334), "in 11mo");
});

/* ---------------------------------------------------------------- money */

test("money keeps the currency it was earned in and never converts", () => {
  /* The bug: the same amount read "12.00 EUR", "EUR 12.00" and "€12.00" on
     three screens. A$11.58 and $11.58 are different amounts of money. */
  assert.equal(money(12, "EUR"), "€12.00");
  assert.equal(money(12, "AUD"), "A$12.00");
  assert.equal(money(12, "usd"), "US$12.00");
});

test("money keeps the cents above a thousand unless the caller drops them", () => {
  assert.equal(money(1240.37, "EUR"), "€1,240.37");
  assert.equal(money(1240.37, "EUR", { digits: 0 }), "€1,240");
});

test("an unknown currency code still renders, beside the number", () => {
  /* Intl throws a RangeError on a code that is not three letters, and a code
     it merely does not know is still a real currency somebody was paid in. */
  assert.equal(money(12, "BITS"), "12.00 BITS");
  assert.ok(money(9.5, "XBT").includes("XBT"));
});

/* ---------------------------------------------------------------- bytes */

test("bytes counts in 1024s by default, like every tool these figures come from", () => {
  /* The bug: the same disk read 5.0 GB on four surfaces and 5.4 GB on four
     others, and the casing was the only clue which base had been used. */
  assert.equal(bytes(5_368_709_120), "5 GB");
  assert.equal(bytes(1024), "1 KB");
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(bytes(999), "999 B");
});

test("base 1000 is available and says so in its casing", () => {
  assert.equal(bytes(5_368_709_120, { base: 1000 }), "5.4 GB");
  assert.equal(bytes(1000, { base: 1000 }), "1 kB");
  assert.equal(bytes(1024, { base: 1024 }), "1 KB");
});

/* --------------------------------------------------------------- counts */

test("count is whole and grouped, never a decimal", () => {
  assert.equal(count(1_500_000), "1,500,000");
  assert.equal(count(9479), "9,479");
  assert.equal(count(155_722.4), "155,722");
});

test("compact uses one casing for one magnitude", () => {
  /* The bug: 1500000 rendered as "1.5M", "1.5m" and "1,500,000". */
  assert.equal(compact(1_500_000), "1.5M");
  assert.equal(compact(1_000_000), "1M");
  assert.equal(compact(2_100_000_000), "2.1B");
  assert.equal(compact(820_000), "820k");
  assert.equal(compact(9512), "9,512", "below ten thousand the digits still fit");
  assert.equal(compact(-1_500_000), "-1.5M");
  /* The rounding carries into the next unit: 999,500 rounds to a thousand
     thousand, which is a million and no longer fits a "k". */
  assert.equal(compact(999_499), "999k");
  assert.equal(compact(999_500), "1M");
  assert.equal(compact(-999_500), "-1M");
  assert.equal(compact(999_949_999), "999.9M");
  assert.equal(compact(999_499_999), "999.5M");
  assert.equal(compact(999_950_000), "1B", "and the same carry at the top");
});

test("splitMoney parts a currency string at the cents and nothing else", () => {
  assert.deepEqual(splitMoney("US$95.93"), { whole: "US$95", cents: ".93" });
  assert.deepEqual(splitMoney("€63.47"), { whole: "€63", cents: ".47" });
  assert.deepEqual(splitMoney("≈US$1,015.36"), { whole: "≈US$1,015", cents: ".36" });
  assert.deepEqual(splitMoney("-US$5.00"), { whole: "-US$5", cents: ".00" });
  assert.equal(splitMoney("$212"), null);
  assert.equal(splitMoney("8h 35m"), null);
  assert.equal(splitMoney("12.5%"), null);
  assert.equal(splitMoney("279"), null);
  assert.equal(splitMoney("—"), null);
});
