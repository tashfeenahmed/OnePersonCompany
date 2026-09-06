/**
 * The contract validator, which is the one piece of this area that is pure
 * logic and the one whose failure mode is silent: a document that is accepted
 * when it should not be produces a chart of nothing, and a document that is
 * refused when it should not be produces a page that says the product is down.
 *
 * `validate` is imported alone rather than through the manifest, so this file
 * touches no database — importing users.ts pulls in db.ts, which opens the real
 * database at import time, so the test runs against the owner's own file and
 * must therefore only READ. It does not: nothing below calls a function that
 * writes, and validate() takes a plain object and returns a plain object.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "./users.ts";

test("a users document with the required fields is accepted", () => {
  const got = validate({
    users: [{ id: "u_1", createdAt: "2026-08-01T09:00:00Z" }],
    total: 42,
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.parsed.shape, "users");
  assert.deepEqual(got.problems, []);
  if (got.parsed.shape !== "users") return;
  assert.equal(got.parsed.total, 42);
  assert.equal(got.parsed.users.length, 1);
  /* Every optional field absent means null, never a default: "the product did
     not say" is a different fact from "false" or "the free plan". */
  assert.equal(got.parsed.users[0]!.paid, null);
  assert.equal(got.parsed.users[0]!.plan, null);
});

test("an empty users array is a product saying nobody signed up, and is valid", () => {
  const got = validate({ users: [] });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "users") return;
  assert.equal(got.parsed.users.length, 0);
  /* And it is NOT the counts form: total stays null rather than becoming 0,
     because the document published no total. */
  assert.equal(got.parsed.total, null);
});

test("the counts form is accepted and is not an empty user list", () => {
  const got = validate({ counts: { total: 158, new: { days: 7, n: 12 } } });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "counts") return;
  assert.equal(got.parsed.total, 158);
  assert.deepEqual(got.parsed.fresh, { days: 7, n: 12 });
});

test("counts with no total is refused — that is the one field the form exists for", () => {
  const got = validate({ counts: { new: { days: 7, n: 1 } } });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.problems.join(" "), /counts\.total is missing/);
});

test("a bad createdAt names the field, the index and the value", () => {
  const got = validate({ users: [{ id: "u_1", createdAt: "yesterday" }] });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.problems[0]!, /^users\[0\]\.createdAt is "yesterday"/);
  assert.match(got.problems[0]!, /ISO 8601/);
});

test("one bad row among good ones is skipped, not fatal", () => {
  const got = validate({
    users: [
      { id: "a", createdAt: "2026-01-01" },
      { id: "b", createdAt: "not a date" },
      { id: "c", createdAt: "2026-01-03" },
    ],
  });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "users") return;
  assert.equal(got.parsed.users.length, 2);
  assert.equal(got.problems.length, 1);
  assert.match(got.problems[0]!, /users\[1\]/);
});

test("every row bad is a refusal rather than an empty import", () => {
  /* The difference matters: "0 users read" would keep the previous rows and
     never say why, which is exactly the silent failure this validator exists
     to prevent. */
  const got = validate({ users: [{ id: "a" }, { id: "b" }] });
  assert.equal(got.ok, false);
});

test("paid must be a boolean, and absent is not false", () => {
  const bad = validate({ users: [{ id: "a", createdAt: "2026-01-01", paid: "yes" }] });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.problems[0]!, /paid is "yes"/);

  const absent = validate({ users: [{ id: "a", createdAt: "2026-01-01" }] });
  assert.equal(absent.ok, true);
  if (!absent.ok || absent.parsed.shape !== "users") return;
  assert.equal(absent.parsed.users[0]!.paid, null);
});

test("a duplicated id is reported rather than silently collapsed", () => {
  const got = validate({
    users: [
      { id: "a", createdAt: "2026-01-01" },
      { id: "a", createdAt: "2026-02-01" },
    ],
  });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "users") return;
  assert.equal(got.parsed.users.length, 1);
  assert.match(got.problems.join(" "), /appears more than once/);
});

test("a numeric id is accepted and a missing one is not", () => {
  const numeric = validate({ users: [{ id: 7, createdAt: "2026-01-01" }] });
  assert.equal(numeric.ok, true);
  if (!numeric.ok || numeric.parsed.shape !== "users") return;
  assert.equal(numeric.parsed.users[0]!.id, "7");

  const missing = validate({ users: [{ createdAt: "2026-01-01" }] });
  assert.equal(missing.ok, false);
});

test("a document with neither key lists the keys it does have", () => {
  const got = validate({ people: [], meta: {} });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.problems[0]!, /neither "users" nor "counts"/);
  assert.match(got.problems[0]!, /people, meta/);
});

test("an array or a string at the top level is refused with what it is", () => {
  assert.equal(validate([]).ok, false);
  assert.equal(validate("hello").ok, false);
  assert.equal(validate(null).ok, false);
});

test("a bad total on a users document is a problem, not a refusal", () => {
  /* The rows are still good. Losing four thousand of them over a stray string
     in a field the contract calls optional would be the wrong trade. */
  const got = validate({ users: [{ id: "a", createdAt: "2026-01-01" }], total: "lots" });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "users") return;
  assert.equal(got.parsed.total, null);
  assert.match(got.problems.join(" "), /total is "lots"/);
});

test("a date-only createdAt is accepted and normalised", () => {
  const got = validate({ users: [{ id: "a", createdAt: "2026-08-01" }] });
  assert.equal(got.ok, true);
  if (!got.ok || got.parsed.shape !== "users") return;
  assert.match(got.parsed.users[0]!.createdAt, /^2026-08-01T/);
});

test("a bare year is not a timestamp, whatever Date.parse thinks of it", () => {
  assert.equal(validate({ users: [{ id: "a", createdAt: "2026" }] }).ok, false);
  assert.equal(validate({ users: [{ id: "a", createdAt: "Sep 5" }] }).ok, false);
});
