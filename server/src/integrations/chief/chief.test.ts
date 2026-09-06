/**
 * The pure logic of the chief-of-staff area, which is the half that can be
 * tested without a database or a model: the JSON path walker every outcome
 * reading goes through, the numbers gate that keeps measurements out of the
 * memory, and the ISO week the weekly pass is idempotent on.
 *
 * NOTHING HERE TOUCHES THE DATABASE. The rest of the area is SQL and HTTP and
 * is verified against the running server, where a test with its own schema
 * would be testing a copy.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isoWeek, looksLikeAMeasurement } from "./memory.ts";
import { walk } from "./outcomes.ts";

test("walk finds a nested field", () => {
  const doc = { portfolio: { window: { visits: 89_621 } } };
  assert.deepEqual(walk(doc, "portfolio.window.visits"), { found: true, value: 89_621 });
});

test("walk indexes arrays", () => {
  const doc = { sites: [{ views: 1 }, { views: 2 }] };
  assert.deepEqual(walk(doc, "sites[1].views"), { found: true, value: 2 });
  assert.equal(walk(doc, "sites[9].views").found, false);
});

test("walk tells a missing field from a null one", () => {
  const doc = { a: { b: null } };
  /* The distinction the whole readings table is built on: `found` with a null
     value is "asked and not told"; not found is "this address is wrong". */
  assert.deepEqual(walk(doc, "a.b"), { found: true, value: null });
  assert.equal(walk(doc, "a.c").found, false);
  assert.equal(walk(doc, "a.b.c").found, false);
});

test("the numbers gate refuses a metrics snapshot", () => {
  assert.equal(looksLikeAMeasurement("MRR is €412 and there are 14 subscriptions"), true);
  assert.equal(looksLikeAMeasurement("Traffic was 1,204 visits, up 32%"), true);
});

test("the numbers gate lets a dated decision through", () => {
  assert.equal(
    looksLikeAMeasurement("In March 2026 he decided against paid acquisition for every venture."),
    false,
  );
  assert.equal(looksLikeAMeasurement("Example Support's churn is mostly trials that never activated."), false);
  /* A single figure in a sentence about a decision is not a snapshot — "one
     run slot" and "two founders" are facts that do not move. */
  assert.equal(looksLikeAMeasurement("He works on this 2 days a week."), false);
});

test("isoWeek follows the Thursday rule", () => {
  /* 2027-01-01 is a Friday, so it belongs to the last week of 2026 — the case
     a naive "week of the year" gets wrong and the reason this is eight lines
     rather than a division. */
  assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(isoWeek(new Date(2026, 8, 5)), "2026-W36");
  /* A Monday and the Sunday after it are the same week and the Sunday before
     it is not — which is what makes "one pass a week" mean one pass. */
  assert.equal(isoWeek(new Date(2026, 8, 7)), isoWeek(new Date(2026, 8, 13)));
  assert.notEqual(isoWeek(new Date(2026, 8, 6)), isoWeek(new Date(2026, 8, 7)));
});
