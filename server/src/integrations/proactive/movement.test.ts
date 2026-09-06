/**
 * The movement diff and the verdict, which are the two pieces of this area
 * that are pure enough to test without a database or a server.
 *
 * WHY THESE AND NOT THE ENGINE. Everything else in `proactive` is either a
 * loopback HTTP read (which is the thing being tested by making the read) or a
 * SQLite write. These are where a wrong answer would be SILENT: a diff that
 * reports a movement that did not happen, or a comparison that trips on a
 * document nobody could read, produces an alert that looks exactly like a real
 * one. So they get the tests.
 *
 * THE DOT-PATH RESOLVER IS TESTED IN `shared/metrics-address.test.ts` now,
 * against the same examples — it moved there with the address itself, because
 * two areas were resolving one syntax with two implementations that had
 * already disagreed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { flattenNumbers, movements } from "./movement.ts";
import { judge } from "./engine.ts";

const DOC = {
  window: { days: 1 },
  charges: [{ currency: "usd", failed: 27, blocked: 17, gross: 680 }],
  summary: { down: 0, expiring30: 2, note: "text" },
  hosts: [{ host: "a.example", current: { ok: true, status: 200 } }],
  domains: [{ name: "a" }, { name: "b" }, { name: "c" }],
  nothing: null,
  asString: { count: "42" },
};

/* ------------------------------------------------------------- movements */

test("flattenNumbers finds numeric leaves by path and ignores text", () => {
  const flat = flattenNumbers(DOC);
  assert.equal(flat.get("charges[0].failed"), 27);
  assert.equal(flat.get("summary.down"), 0);
  assert.equal(flat.has("summary.note"), false);
});

test("movements reports only paths present in BOTH documents", () => {
  const before = new Map([["a", 10], ["gone", 5]]);
  const after = new Map([["a", 5], ["new", 9]]);
  const moved = movements(before, after);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.path, "a");
  assert.equal(moved[0]!.changePct, -50);
});

test("a movement from zero has a null percentage rather than an infinity", () => {
  const moved = movements(new Map([["a", 0]]), new Map([["a", 12]]));
  assert.equal(moved[0]!.changePct, null);
});

/* ------------------------------------------------------------------ judge */

const rule = (op: string, threshold: number | null, windowMinutes: number | null = null) =>
  ({ op, threshold, window_minutes: windowMinutes, path: "x", name: "r" }) as never;

test("a comparison trips exactly when it is true", () => {
  assert.equal(judge(rule(">", 0), 27, { previous: null, windowStart: null }).tripped, true);
  assert.equal(judge(rule(">", 0), 0, { previous: null, windowStart: null }).tripped, false);
  assert.equal(judge(rule("<=", 5), 5, { previous: null, windowStart: null }).tripped, true);
});

test("`changed` cannot trip on a first reading and says why", () => {
  const v = judge(rule("changed", null), 3, { previous: null, windowStart: null });
  assert.equal(v.tripped, false);
  assert.equal(v.undecidable, "no previous reading");
});

test("a windowed rule with no old enough reading does not trip", () => {
  const v = judge(rule("dropped_by_pct", 50, 10080), 10, { previous: 20, windowStart: null });
  assert.equal(v.tripped, false);
  assert.equal(v.undecidable, "no reading old enough");
});

test("dropped_by_pct trips on a fall of at least the percentage, and not on a rise", () => {
  const start = { ts: "2026-09-01T00:00:00Z", value: 100 };
  assert.equal(judge(rule("dropped_by_pct", 50, 60), 49, { previous: null, windowStart: start }).tripped, true);
  assert.equal(judge(rule("dropped_by_pct", 50, 60), 51, { previous: null, windowStart: start }).tripped, false);
  assert.equal(judge(rule("dropped_by_pct", 50, 60), 200, { previous: null, windowStart: start }).tripped, false);
  assert.equal(judge(rule("rose_by_pct", 50, 60), 200, { previous: null, windowStart: start }).tripped, true);
});

test("a percentage change from zero is refused rather than computed", () => {
  const v = judge(rule("dropped_by_pct", 50, 60), 5, {
    previous: null,
    windowStart: { ts: "2026-09-01T00:00:00Z", value: 0 },
  });
  assert.equal(v.tripped, false);
  assert.equal(v.undecidable, "the earlier figure was zero");
});
