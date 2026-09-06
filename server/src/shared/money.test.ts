/**
 * The money rules, on the cases the nine copies disagreed about.
 *
 * The precision assertions are the point of the file: the same figure rounded
 * at two places on one route and four on another is why two documents about
 * one month never tied out, and the test below is what stops it happening
 * again silently.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_SPEND_DP,
  MONEY_DP,
  compactMonth,
  currencyCode,
  daysInMonth,
  fromMinorUnits,
  isCompactMonth,
  isMonth,
  isoMonth,
  money,
  monthOf,
} from "./money.ts";

test("one precision by default, and it is four places", () => {
  assert.equal(MONEY_DP, 4);
  assert.equal(money(1 / 3), 0.3333);
  assert.equal(money(10.005), 10.005);
  assert.equal(money(0), 0);
  assert.equal(money(-1.23456789), -1.2346);
});

test("a twelfth of a yearly bill keeps its tail, which two places lost", () => {
  const yearly = 100;
  const monthly = yearly / 12;
  /* A thousand of them, summed at full precision and rounded once. */
  const atFour = money(monthly * 1000);
  assert.equal(atFour, 8333.3333);
  /* The same thousand rounded per row at two places, which is what the copies
     did — off by more than a pound on one bill. */
  const perRowAtTwo = money(1000 * Number(monthly.toFixed(2)), 2);
  assert.notEqual(perRowAtTwo, Number(atFour.toFixed(2)));
});

test("sub-cent model spend has a named precision rather than a second money()", () => {
  assert.equal(MODEL_SPEND_DP, 6);
  assert.equal(money(0.0000125, MODEL_SPEND_DP), 0.000013);
  /* At the default it would round away entirely, which is the reason the
     exception exists. */
  assert.equal(money(0.0000125), 0);
});

test("minor units become major ones in one place", () => {
  assert.equal(fromMinorUnits(1999), 19.99);
  assert.equal(fromMinorUnits(1), 0.01);
  assert.equal(fromMinorUnits(0), 0);
  assert.equal(fromMinorUnits(-2500), -25);
});

test("a currency is one key however the provider spelled it", () => {
  assert.equal(currencyCode("usd"), "USD");
  assert.equal(currencyCode("USD"), "USD");
  assert.equal(currencyCode("  eur  "), "EUR");
  assert.equal(currencyCode("Gbp"), "GBP");
  assert.equal(currencyCode(null), "");
  /* The case that made a per-currency map hold one currency twice. */
  const totals: Record<string, number> = {};
  for (const [code, amount] of [["usd", 10], ["USD", 5]] as [string, number][])
    totals[currencyCode(code)] = (totals[currencyCode(code)] ?? 0) + amount;
  assert.deepEqual(totals, { USD: 15 });
});

test("a month is YYYY-MM, and a compact month is YYYYMM", () => {
  assert.equal(isMonth("2026-09"), true);
  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("2026-00"), false);
  assert.equal(isMonth("202609"), false);
  assert.equal(isMonth(null), false);
  assert.equal(isCompactMonth("202609"), true);
  assert.equal(isCompactMonth("202613"), false);
  assert.equal(isCompactMonth("2026-09"), false);
});

test("the two month spellings round-trip, and leave anything else alone", () => {
  for (const month of ["2026-01", "2026-09", "2026-12", "1999-06"]) {
    assert.equal(isoMonth(compactMonth(month)), month);
    assert.equal(compactMonth(month), month.replace("-", ""));
  }
  for (const compact of ["202601", "202609", "202612"])
    assert.equal(compactMonth(isoMonth(compact)), compact);
  /* Already in the target spelling, or not a month at all: unchanged, because
     a mangled key matches no row and returns a silent zero. */
  assert.equal(compactMonth("202609"), "202609");
  assert.equal(isoMonth("2026-09"), "2026-09");
  assert.equal(compactMonth("2026-9"), "2026-9");
  assert.equal(isoMonth("20269"), "20269");
  assert.equal(isoMonth(""), "");
});

test("a month knows its own length, including February in a leap year", () => {
  assert.equal(daysInMonth("2026-01"), 31);
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29);
  assert.equal(daysInMonth("2026-04"), 30);
  assert.equal(daysInMonth("2026-12"), 31);
});

test("the month of a day or an instant", () => {
  assert.equal(monthOf("2026-09-06"), "2026-09");
  assert.equal(monthOf("2026-09-06T13:04:00.000Z"), "2026-09");
});
