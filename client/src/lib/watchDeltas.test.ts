/**
 * These three functions exist to keep ONE distinction alive on the screen: the
 * difference between a figure that was measured and a figure nobody has ever
 * had two readings of. Every test below is a version of that, because every
 * way of getting it wrong renders as a perfectly plausible dashboard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deltaLabel, deltaTone, sweepLine } from "./watchDeltas.ts";

test("a measured zero is drawn and an absent reading is not", () => {
  /* The whole bug this module exists for: `deltas.ghFollowers ?? 0` inside a
     component turns "nobody knows" into "no change", which is a claim. */
  assert.equal(deltaLabel(0), "0");
  assert.equal(deltaLabel(undefined), null);
  assert.equal(deltaLabel(null), null);
  assert.equal(deltaLabel(Number.NaN), null);
});

test("a movement carries its sign and the separators the tiles use", () => {
  assert.equal(deltaLabel(40), "+40");
  assert.equal(deltaLabel(4120), "+4,120");
  /* One minus sign, not two: `count` already carries it. */
  assert.equal(deltaLabel(-4000), "-4,000");
});

test("a flat week and an unknown week are different answers", () => {
  assert.equal(deltaTone(0), "flat");
  assert.equal(deltaTone(undefined), null);
  assert.equal(deltaTone(12), "up");
  /* Down is a direction and not a verdict — this list is about noticing. */
  assert.equal(deltaTone(-12), "down");
});

const at = Date.parse("2026-09-07T12:00:00.000Z");
const ago = (h: number) => new Date(at - h * 3_600_000).toISOString();
const ahead = (h: number) => new Date(at + h * 3_600_000).toISOString();

test("the sweep line quotes the moment EVERYBODY had been read", () => {
  assert.equal(
    sweepLine({ lastAt: ago(3), nextDueAt: ahead(17), everyonePulled: true }, at),
    "Pulled for everyone 3h ago · next in 17h",
  );
});

test("with one person never pulled it refuses to say “for everyone”", () => {
  /* The server sends lastAt: null in this case precisely so that nothing here
     can quote the oldest of the rest as if it covered the whole list. */
  assert.equal(
    sweepLine({ lastAt: null, nextDueAt: null, everyonePulled: false }, at),
    "Not everyone has been pulled yet",
  );
});

test("a null next is “due now”, never a negative countdown", () => {
  assert.equal(
    sweepLine({ lastAt: ago(22), nextDueAt: null, everyonePulled: true }, at),
    "Pulled for everyone 22h ago · due now",
  );
  /* And a stamp that has already passed is treated the same way rather than
     rendered as "in -4h". */
  assert.equal(
    sweepLine({ lastAt: ago(24), nextDueAt: ago(4), everyonePulled: true }, at),
    "Pulled for everyone 1d ago · due now",
  );
});

test("no document yet is an empty line rather than a guess", () => {
  assert.equal(sweepLine(null, at), "");
  assert.equal(sweepLine(undefined, at), "");
});
