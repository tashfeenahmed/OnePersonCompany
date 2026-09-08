import test from "node:test";
import assert from "node:assert/strict";
import { drift, failRate, planSplit, rateOverLast, splitLeaving, sumMonthly, worthALook, type AttemptDay } from "./payments.ts";

const day = (i: number, succeeded: number, failed: number): AttemptDay => ({
  day: `2026-08-${String(i + 1).padStart(2, "0")}`,
  succeeded,
  failed,
  blocked: 0,
  declined: failed,
});

test("nothing attempted is not a rate", () => {
  assert.equal(failRate(0, 0), null);
  assert.equal(failRate(3, 1), 25);
  assert.equal(failRate(386, 254), 39.7);
});

test("the drift compares a fixed seven days against a fixed thirty, or says nothing", () => {
  // Twenty-nine days is not thirty: no verdict, rather than one over a shorter span.
  const short = Array.from({ length: 29 }, (_, i) => day(i, 10, 2));
  assert.equal(drift(short), null);

  // A quiet month whose last week turned bad.
  const worse = Array.from({ length: 30 }, (_, i) => day(i, 10, i >= 23 ? 8 : 1));
  const d = drift(worse)!;
  assert.equal(d.short, 44.4);
  assert.equal(d.verdict, "getting worse");

  // The same month with a flat week is "holding", inside the two-point band.
  const flat = Array.from({ length: 30 }, (_, i) => day(i, 10, 2));
  assert.equal(drift(flat)!.verdict, "holding");

  // The tail is the LAST seven days, whatever the series length.
  const ninety = Array.from({ length: 90 }, (_, i) => day(i % 28, 10, i >= 83 ? 0 : 5));
  assert.equal(rateOverLast(ninety, 7), 0);
  assert.equal(drift(ninety)!.verdict, "recovering");
});

test("the alerts fire on their own thresholds and read as sentences", () => {
  const quiet = worthALook({
    days: 30, succeeded: 9, failed: 1, blocked: 0, declined: 1, pastDue: 0,
    disputesNeedingResponse: 0, disputesAtStake: 0, nextEvidenceDueBy: null, failingInvoices: 0,
    fmtMoney: (n) => `$${n}`,
  });
  assert.deepEqual(quiet, []);

  // A 25% fail rate over nine attempts is noise; over ten it is worth a look.
  const few = worthALook({
    days: 30, succeeded: 6, failed: 3, blocked: 1, declined: 2, pastDue: 0,
    disputesNeedingResponse: 0, disputesAtStake: 0, nextEvidenceDueBy: null, failingInvoices: 0,
    fmtMoney: (n) => `$${n}`,
  });
  assert.deepEqual(few, []);

  const loud = worthALook({
    days: 30, succeeded: 386, failed: 254, blocked: 119, declined: 132, pastDue: 2,
    disputesNeedingResponse: 1, disputesAtStake: 57, nextEvidenceDueBy: "12 Sep", failingInvoices: 45,
    fmtMoney: (n) => `$${n}`,
  });
  assert.equal(loud.length, 4);
  assert.match(loud[0]!.text, /^40% of payment attempts failed — 254 of 640 in the last 30 days\. 119 were blocked/);
  assert.equal(loud[1]!.text, "1 dispute worth $57 needs a response; the first evidence deadline is 12 Sep.");
  assert.equal(loud[2]!.text, "2 subscriptions are past due — billing and failing, and not in MRR.");
  assert.equal(loud[3]!.text, "45 failing invoices sit in the recovery queue waiting for a follow-up.");
  // Money at risk is said loudly; a follow-up to write is a warning.
  assert.deepEqual(loud.map((a) => a.tone), ["bad", "bad", "warn", "warn"]);
});

test("the plan split keeps the biggest four and counts the rest, ignoring plans that bill nothing", () => {
  const plans = [
    { name: "a", mrr: 5 }, { name: "b", mrr: 50 }, { name: "c", mrr: 0 },
    { name: "d", mrr: 20 }, { name: "e", mrr: 10 }, { name: "f", mrr: 1 },
  ];
  const s = planSplit(plans);
  assert.deepEqual(s.top.map((p) => p.name), ["b", "d", "e", "a"]);
  assert.equal(s.more, 1);
});

test("leaving subscriptions split at sixty days, soonest first, undated last", () => {
  const cases = [
    { id: "late", daysLeft: 200, amount: 10 },
    { id: "gone", daysLeft: null, amount: null },
    { id: "soon", daysLeft: 12, amount: 4 },
    { id: "edge", daysLeft: 60, amount: 6 },
  ];
  const s = splitLeaving(cases);
  assert.deepEqual(s.soon.map((c) => c.id), ["soon", "edge"]);
  assert.deepEqual(s.later.map((c) => c.id), ["late"]);
  assert.deepEqual(s.undated.map((c) => c.id), ["gone"]);
  // A case with no amount makes the total a floor, and says so by count.
  assert.deepEqual(sumMonthly(cases), { total: 20, unpriced: 1 });
});
