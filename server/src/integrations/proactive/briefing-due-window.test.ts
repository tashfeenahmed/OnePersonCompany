/**
 * The due-soon window of the morning briefing, as a pure boundary.
 *
 * WHY THIS GETS A TEST. The old code computed the far bound as
 * `new Date(Date.now() + 3 days).toISOString().slice(0, 10)` while comparing
 * it against the briefing's ZONED `day`. East of UTC that silently shrinks
 * the window (an IST midnight briefing got a 2-day span, so genuinely-due
 * cards were dropped from the morning briefing); west of UTC it grows. A
 * briefing that quietly omits an overdue-due card is invisible failure —
 * nothing errors, the card is just never mentioned. So the boundary is a
 * function of the day alone, and the day alone is what this pins.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dueSoonBound, DUE_SOON_DAYS } from "./briefing.ts";

test("the bound is exactly DUE_SOON_DAYS after the day it is given", () => {
  assert.equal(dueSoonBound("2026-10-21"), "2026-10-24");
  assert.equal(dueSoonBound("2026-10-19"), "2026-10-22");
});

test("it crosses month and year boundaries by DATE, not by 86400s", () => {
  assert.equal(dueSoonBound("2026-10-30"), "2026-11-02");
  assert.equal(dueSoonBound("2026-12-30"), "2027-01-02");
  // A leap day exists; a UTC-ms window would not care, a date window must.
  assert.equal(dueSoonBound("2028-02-27"), "2028-03-01");
});

test("the window a card is judged in: overdue < day <= soon, both inclusive at the ends it should be", () => {
  const day = "2026-10-21";
  const soon = dueSoonBound(day);
  // (card.due < day) => overdue; (card.due <= soon) => due soon; else neither.
  const bucket = (due: string) => (due < day ? "overdue" : due <= soon ? "soon" : "none");
  assert.equal(bucket("2026-10-20"), "overdue");
  assert.equal(bucket("2026-10-21"), "soon"); // due TODAY is soon, not overdue
  assert.equal(bucket(soon), "soon"); // exactly 3 days out is inside the window
  assert.equal(bucket("2026-10-25"), "none");
  // The regression: at 00:30 IST the old UTC-based bound was `day + 2`,
  // which dropped day+3 from the briefing entirely.
  assert.equal(bucket("2026-10-24"), "soon");
});

test("DUE_SOON_DAYS is what the copy promises (three days)", () => {
  assert.equal(DUE_SOON_DAYS, 3);
});
