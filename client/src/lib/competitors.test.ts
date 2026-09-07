import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_FRESH_DAYS,
  COMPETITOR_STALE_DAYS,
  isStale,
  recentChange,
  stripCompetitorsFence,
  verifiedLabel,
  type ChangeLike,
} from "./competitors.ts";

/**
 * The competitor table's own rules, checked where they can be checked.
 *
 * Each of these decides WHAT A ROW MEANS rather than what it looks like, and
 * each fails as a plausible wrong answer: a staleness threshold that never
 * fires makes a two-month-old price read as today's; a badge window that never
 * closes puts a permanent "changed" on every rival that ever moved; a fence
 * stripper that is too greedy eats the report it was meant to tidy.
 */

const NOW = new Date("2026-09-07T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const change = (over: Partial<ChangeLike>): ChangeLike => ({
  at: daysAgo(2),
  field: "pricing",
  from: "$14",
  to: "$19",
  note: "price moved, $14 → $19",
  ...over,
});

test("staleness fires past six weeks, and never on a date that could not be read", () => {
  assert.equal(isStale(0), false);
  assert.equal(isStale(COMPETITOR_STALE_DAYS), false, "the threshold itself is not yet stale");
  assert.equal(isStale(COMPETITOR_STALE_DAYS + 1), true);
  /* Unknown is not a warning. Colouring it as one would invent a claim about
     a row this box knows nothing about. */
  assert.equal(isStale(null), false);
});

test("verifiedLabel words the server's count and never does its own arithmetic", () => {
  assert.equal(verifiedLabel(0), "verified today");
  assert.equal(verifiedLabel(1), "verified yesterday");
  assert.equal(verifiedLabel(34), "verified 34 days ago");
  assert.equal(verifiedLabel(null), "never verified");
});

test("recentChange badges the newest movement, and only inside the window", () => {
  const inside = change({ at: daysAgo(3), note: "price moved, $14 → $19" });
  const older = change({ at: daysAgo(10), note: "positioning rewritten — 71% of its words are different" });
  assert.equal(recentChange([older, inside], NOW)?.note, inside.note, "newest wins");

  /* News expires. A move from before the window is history and lives in the
     disclosure, not on a badge. */
  const stale = change({ at: daysAgo(CHANGE_FRESH_DAYS + 1) });
  assert.equal(recentChange([stale], NOW), null);
  assert.equal(recentChange([change({ at: daysAgo(CHANGE_FRESH_DAYS - 1) })], NOW)?.note, stale.note);

  assert.equal(recentChange([], NOW), null);
  assert.equal(recentChange(undefined, NOW), null);
  /* A hand-edited row with a broken timestamp must not badge forever. */
  assert.equal(recentChange([change({ at: "not a date" })], NOW), null);
});

test("stripCompetitorsFence takes out the old sweep's block and nothing else", () => {
  const report = [
    "## Findings",
    "Klap is cheaper than Opus Clip.",
    "",
    "```json competitors",
    '[{"name": "Klap", "pricing": "$14/mo"}]',
    "```",
    "",
    "## Recommendations",
    "Match the free tier.",
  ].join("\n");
  const out = stripCompetitorsFence(report);
  assert.ok(!out.includes("json competitors"));
  assert.ok(!out.includes('"name": "Klap"'));
  assert.ok(out.includes("## Findings"));
  assert.ok(out.includes("## Recommendations"), "everything after the block survives");

  /* The looser label models actually wrote. */
  assert.ok(!stripCompetitorsFence("```competitors\n[]\n```").includes("competitors"));

  /* A report with no such block is returned as it was. */
  const plain = "## Findings\nNothing to see.";
  assert.equal(stripCompetitorsFence(plain), plain);

  /* AND THE CARDS BLOCK IS NOT ITS BUSINESS. `readCards` owns that one, and a
     stripper that took both would leave the panel with nothing to draw. */
  const cards = '## Findings\nA finding.\n\n```json cards\n[{"title": "Do a thing"}]\n```';
  assert.ok(stripCompetitorsFence(cards).includes("json cards"));

  /* A half-written block on a report that is still streaming has no closing
     fence, matches nothing, and stays as the unterminated fence it is. */
  const streaming = "## Findings\n\n```json competitors\n[{\"name\": \"Kla";
  assert.equal(stripCompetitorsFence(streaming), streaming);
});
