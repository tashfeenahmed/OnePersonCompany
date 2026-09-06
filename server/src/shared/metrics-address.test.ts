/**
 * The address of a figure, read on a schedule.
 *
 * Two areas wrote this twice and the two had already drifted, so what is
 * tested here is mostly the drift: a `@count(...)` path that one resolver
 * understood and the other did not, a view sentinel that produced two
 * different URLs from one stored address, and a parameter type one accepted
 * and one dropped.
 *
 * The universal rule gets its own tests too, because it is the rule the whole
 * idea turns on: a figure that cannot be read is null with a sentence, and it
 * is NEVER a zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPath,
  fromDoc,
  paramsOf,
  parsePath,
  resolvePath,
  takeReading,
  urlFor,
} from "./metrics-address.ts";

const DOC = {
  window: { days: 1 },
  charges: [{ currency: "usd", failed: 27, blocked: 17 }],
  summary: { down: 0, expiring30: 2, note: "text" },
  hosts: [{ host: "a.example", current: { ok: true, status: 200 } }],
  domains: [{ name: "a" }, { name: "b" }, { name: "c" }],
  nothing: null,
  asString: { count: "42", formatted: "1,204" },
};

/* ---------------------------------------------------------------- the path */

test("@count is the length of a list — the path one of the two copies could not read", () => {
  /* A path copied from a working alert rule read as "nothing at that path" in
     an outcome, which is a null reading that looks exactly like a finding. */
  assert.deepEqual(parsePath("@count(domains)"), { path: "domains", count: true });
  assert.deepEqual(resolvePath(DOC, "@count(domains)"), { ok: true, value: 3 });
  assert.deepEqual(parsePath("charges[0].failed"), { path: "charges[0].failed", count: false });
});

test("@count on something that is not a list says so rather than counting characters", () => {
  const got = resolvePath(DOC, "@count(summary.note)");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /nothing to count/);
});

test("a dot path with an array index reads the number", () => {
  assert.deepEqual(resolvePath(DOC, "charges[0].failed"), { ok: true, value: 27 });
});

test("a boolean reads as 1 or 0, because false really was measured", () => {
  assert.deepEqual(resolvePath(DOC, "hosts[0].current.ok"), { ok: true, value: 1 });
});

test("a numeric string is accepted, formatted or not", () => {
  assert.deepEqual(resolvePath(DOC, "asString.count"), { ok: true, value: 42 });
  assert.deepEqual(resolvePath(DOC, "asString.formatted"), { ok: true, value: 1204 });
});

test("a missing key names what is actually there — and is never a zero", () => {
  const got = resolvePath(DOC, "summary.missing");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /has no “missing”/);
  assert.match(got.ok === false ? got.why : "", /down/);
});

test("the document's own null is a different finding from a wrong address", () => {
  const missing = resolvePath(DOC, "summary.missing");
  const isNull = resolvePath(DOC, "nothing");
  assert.equal(missing.ok, false);
  assert.equal(isNull.ok, false);
  assert.match(isNull.ok === false ? isNull.why : "", /asked and not told/);
  assert.notEqual(
    missing.ok === false ? missing.why : "",
    isNull.ok === false ? isNull.why : "",
    "two different facts about the world, only one of them good news",
  );
});

test("a path onto a list suggests the counting form rather than failing blankly", () => {
  const got = resolvePath(DOC, "domains");
  assert.equal(got.ok, false);
  assert.match(got.ok === false ? got.why : "", /Did you mean @count\(domains\)/);
});

test("a real zero is a reading", () => {
  assert.deepEqual(resolvePath(DOC, "summary.down"), { ok: true, value: 0 });
});

test("checkPath refuses nonsense where it was typed", () => {
  assert.equal(checkPath("charges[0].failed"), null);
  assert.equal(checkPath("@count(domains)"), null);
  assert.match(checkPath("") ?? "", /needs a path/);
  assert.match(checkPath("a b c") ?? "", /not a JSON path/);
});

/* -------------------------------------------------------------- the params */

test("params come out of a JSON column or an object, and any scalar survives", () => {
  /* One copy kept strings and numbers only, so a boolean parameter was
     silently dropped and one stored address produced two query strings. */
  assert.deepEqual(paramsOf('{"days":30,"venture":"v1","live":true}'), {
    days: "30",
    venture: "v1",
    live: "true",
  });
  assert.deepEqual(paramsOf({ days: 7 }), { days: "7" });
  assert.deepEqual(paramsOf('{"nested":{"a":1},"ok":1}'), { ok: "1" }, "a query string has nowhere to put an object");
});

test("an unparseable column is no parameters, not an exception", () => {
  assert.deepEqual(paramsOf("{not json"), {});
  assert.deepEqual(paramsOf(""), {});
  assert.deepEqual(paramsOf(null), {});
  assert.deepEqual(paramsOf("[1,2]"), {});
});

/* ----------------------------------------------------------------- the URL */

test("the view sentinel is omitted, which is the case the two builders disagreed on", () => {
  /* `default` is what both features store for "the entry's own first view",
     and an absent view resolves to exactly that. Sending it literally 404s on
     any skill whose first view is called something else. */
  const base = "http://127.0.0.1:8787";
  assert.equal(
    urlFor({ skill: "stripe", view: "default", path: "x" }, base),
    `${base}/api/skills/stripe`,
  );
  assert.equal(urlFor({ skill: "stripe", view: "", path: "x" }, base), `${base}/api/skills/stripe`);
  assert.equal(urlFor({ skill: "stripe", path: "x" }, base), `${base}/api/skills/stripe`);
  assert.equal(
    urlFor({ skill: "stripe", view: "charges", path: "x" }, base),
    `${base}/api/skills/stripe?view=charges`,
  );
});

test("parameters ride the query string, and the skill id is escaped", () => {
  const base = "http://127.0.0.1:8787";
  assert.equal(
    urlFor({ skill: "umami", view: "site", params: '{"days":30}', path: "x" }, base),
    `${base}/api/skills/umami?view=site&days=30`,
  );
  assert.match(urlFor({ skill: "a/b", path: "x" }, base), /skills\/a%2Fb/);
});

/* ------------------------------------------------------------- the reading */

test("a reading out of a document in hand takes the same path by the same rules", () => {
  const got = fromDoc({ skill: "stripe", path: "@count(domains)" }, DOC);
  assert.equal(got.value, 3);
  assert.equal(got.error, null);

  const bad = fromDoc({ skill: "stripe", path: "summary.note" }, DOC);
  assert.equal(bad.value, null, "text at the path is null with a reason, never zero");
  assert.match(bad.error ?? "", /not a number/);
});

test("the skill's own refusal is carried through verbatim", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Stripe has no data here: no credential." }), {
      status: 409,
    })) as typeof fetch;
  try {
    const got = await takeReading({ skill: "stripe", path: "charges[0].failed" });
    assert.equal(got.value, null);
    assert.equal(got.error, "Stripe has no data here: no credential.");
    assert.match(got.url, /\/api\/skills\/stripe$/);
  } finally {
    globalThis.fetch = real;
  }
});

test("an answer that is not JSON is its own sentence", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>502</html>", { status: 200 })) as typeof fetch;
  try {
    const got = await takeReading({ skill: "stripe", path: "x" });
    assert.equal(got.value, null);
    assert.match(got.error ?? "", /not JSON/);
    assert.equal(got.raw, "<html>502</html>");
  } finally {
    globalThis.fetch = real;
  }
});

test("two addresses into one document are one request", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(DOC));
  }) as typeof fetch;
  try {
    const docs = new Map<string, unknown>();
    const a = await takeReading({ skill: "stripe", path: "charges[0].failed" }, { docs });
    const b = await takeReading({ skill: "stripe", path: "charges[0].blocked" }, { docs });
    assert.equal(a.value, 27);
    assert.equal(b.value, 17);
    assert.equal(calls, 1, "one document, two paths");
  } finally {
    globalThis.fetch = real;
  }
});

test("a route that could not be reached is null with the reason, not a zero", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  try {
    const got = await takeReading({ skill: "stripe", path: "charges[0].failed" });
    assert.equal(got.value, null);
    assert.match(got.error ?? "", /ECONNREFUSED/);
  } finally {
    globalThis.fetch = real;
  }
});
