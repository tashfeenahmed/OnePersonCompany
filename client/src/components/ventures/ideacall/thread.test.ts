import { test } from "node:test";
import assert from "node:assert/strict";
import { K, O, scaleFor, opacityFor, splitSay, sentence, threadLayout, updatedCaption } from "./thread.ts";

test("the focused turn lands on the anchor line and its neighbours fall away", () => {
  const heights = [200, 200, 200, 200, 200, 200];
  const last = threadLayout(heights, 5, 600);
  assert.equal(last.focus, 5);
  assert.equal(last.behind, false);
  assert.equal(last.scales[5], 1);
  assert.equal(last.opacities[5], 1);
  /* Nothing after the focus, so the anchor is the bottom inset itself and the
     focused turn's foot sits exactly there. */
  const focusFoot = last.y + heights.slice(0, 5).reduce((t, h, i) => {
    const s = scaleFor(5 - i);
    return t + h * s + 2 + 10 + 24 * s;
  }, 0) + 200 + 2;
  assert.ok(Math.abs(focusFoot - (600 - 14)) <= 0.5, `foot ${focusFoot} is on the anchor line`);

  /* Distance drives both tables, clamped four away. */
  assert.deepEqual(last.scales.slice(0, 2), [K[4], K[4]]);
  assert.deepEqual(last.opacities.slice(0, 2), [O[4], O[4]]);
  assert.equal(scaleFor(99), K[4]);
  assert.equal(opacityFor(99), O[4]);
});

test("stepping back lifts the column but never by more than the tail cap", () => {
  const heights = [300, 300, 300, 300, 300, 300, 300, 300];
  const near = threadLayout(heights, 6, 600);
  const far = threadLayout(heights, 1, 600);
  assert.equal(near.behind, true);
  assert.equal(far.behind, true);
  /* Looking back slides the column DOWN, because the older turn has to travel
     to the anchor line. */
  assert.equal(far.scales[1], 1);
  assert.ok(far.y > near.y, "an earlier focus pushes the column down the screen");

  /* With seven turns below it, the tail is capped at a third of the viewport,
     so the anchor stops climbing and the first turn sits just below the top. */
  const capped = threadLayout(heights, 0, 600);
  assert.equal(capped.y, Math.round(600 - 14 - 600 * 0.34 - (300 + 2)));
});

test("layout clamps a stale focus and survives an empty column", () => {
  assert.equal(threadLayout([100, 100], 7, 500).focus, 1);
  assert.equal(threadLayout([100, 100], -3, 500).focus, 0);
  const empty = threadLayout([], 4, 500);
  assert.deepEqual(empty, { focus: 0, scales: [], opacities: [], y: 0, behind: false });
});

test("a reply is cut into sayable paragraphs on sentence boundaries", () => {
  const long =
    "Plenty of itinerary apps exist already. Nothing closes the loop from a vote to a booking, and that gap is still open. " +
    "Who ends up doing the deciding in your group? The answer usually names the person you should build for first, " +
    "because they are the one carrying the coordination and the one who would miss this if it vanished tomorrow.";
  const parts = splitSay(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 220), "no paragraph exceeds the budget");
  assert.equal(parts.join(" "), long.replace(/\s+/g, " ").trim(), "no word is lost or duplicated");
  assert.ok(parts.every((p) => p === p.trim() && p.length > 0));

  /* A single sentence with no full stop in sight is broken on spaces, not mid-word. */
  const runOn = `${"word ".repeat(120).trim()}`;
  const broken = splitSay(runOn, 60);
  assert.ok(broken.every((p) => p.length <= 60));
  assert.equal(broken.join(" "), runOn);

  assert.deepEqual(splitSay("   \n  "), []);
  assert.deepEqual(splitSay("Short one."), ["Short one."]);
});

test("a turn is normalised into a sentence, and an update names what moved", () => {
  assert.equal(sentence("  it's like a   shared notebook "), "It's like a shared notebook.");
  assert.equal(sentence("does it work?"), "Does it work?");
  assert.equal(sentence("one moment…"), "One moment…");
  assert.equal(sentence(""), "");

  assert.equal(
    updatedCaption({ fields: ["Problem", "First customer"], competitors: [], names: [] }),
    "Updated · Problem, First customer",
  );
  assert.equal(updatedCaption({ fields: [], competitors: ["a", "b", "c"], names: [] }), "Saved 3 competitors");
  assert.equal(updatedCaption({ fields: [], competitors: ["a"], names: ["n", "m"] }), "Saved 1 competitor · Shortlisted 2 names");
  assert.equal(updatedCaption({ fields: [], competitors: [], names: [] }), null);
});
