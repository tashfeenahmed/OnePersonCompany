/**
 * The path resolver and the movement diff, which are the two pieces of this
 * area that are pure enough to test without a database or a server.
 *
 * WHY THESE TWO AND NOT THE ENGINE. Everything else in `proactive` is either a
 * loopback HTTP read (which is the thing being tested by making the read) or a
 * SQLite write. These two are where a wrong answer would be SILENT: a path
 * that resolves to the wrong number, or a diff that reports a movement that
 * did not happen, produces an alert that looks exactly like a real one. So
 * they get the tests.
 *
 * `judge` is here too, for the case the whole area exists to get right: a
 * document that could not be read must not come out as a figure of zero.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkPath, flattenNumbers, movements, parsePath, resolvePath } from "./path.ts";
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

test("a dot path with an array index reads the number", () => {
  const got = resolvePath(DOC, "charges[0].failed");
  assert.deepEqual(got, { ok: true, value: 27 });
});

test("@count is the length of a list", () => {
  assert.deepEqual(parsePath("@count(domains)"), { path: "domains", count: true });
  assert.deepEqual(resolvePath(DOC, "@count(domains)"), { ok: true, value: 3 });
});

test("a boolean reads as 1 or 0, because false really was measured", () => {
  assert.deepEqual(resolvePath(DOC, "hosts[0].current.ok"), { ok: true, value: 1 });
});

test("a numeric string is accepted", () => {
  assert.deepEqual(resolvePath(DOC, "asString.count"), { ok: true, value: 42 });
});

test("a missing key is a failure that names what is there — never a zero", () => {
  const got = resolvePath(DOC, "summary.missing");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /has no “missing”/);
  assert.match(got.ok === false ? got.why : "", /down/);
});

test("a path onto text is a failure, not a zero", () => {
  const got = resolvePath(DOC, "summary.note");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /not a number/);
});

test("@count of something that is not a list says so", () => {
  const got = resolvePath(DOC, "@count(summary)");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /nothing to count/);
});

test("an index past the end says how many there are", () => {
  const got = resolvePath(DOC, "charges[3].failed");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /1 item\(s\)/);
});

test("a real zero is a reading and not a failure", () => {
  assert.deepEqual(resolvePath(DOC, "summary.down"), { ok: true, value: 0 });
});

test("checkPath refuses what is not a path and accepts what is", () => {
  assert.equal(checkPath("charges[0].failed"), null);
  assert.equal(checkPath("@count(domains)"), null);
  assert.notEqual(checkPath(""), null);
  assert.notEqual(checkPath("charges[0]/failed"), null);
});

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
