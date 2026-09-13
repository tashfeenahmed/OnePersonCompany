/**
 * The translation from a probe row to a contract user, which is the one piece
 * of this door that is pure logic and the one whose failure mode is a figure
 * that looks right.
 *
 * Everything upstream of it is reviewed where it lives: the SQL is on the box,
 * in `users-probe`, written against each application's own schema; the ssh is
 * fleet.ts's, already covered by its own tests. What is NOT reviewed anywhere
 * else is the claim that Example App 2's `extra` is a plan and Example App 5's is a handle,
 * that a payment state this table has not been told about is unknown rather
 * than free, and that a WordPress author is not a customer. Get one of those
 * wrong and nothing breaks — a portfolio just quietly reports the wrong people.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { upsertPlugin } from "../../db.ts";
import {
  boxDocument,
  boxReader,
  parsePrefixes,
  sourceFor as lookupSource, EXAMPLE_SOURCES,
  stripeDocument,
  type ProbeApp,
  type ProbeRow,
} from "./users-boxes.ts";
import { kindOf, validate } from "./users.ts";

const AT = 1_788_000_000;

function app(over: Partial<ProbeApp> & { recent: ProbeRow[] }): ProbeApp {
  return {
    id: "x", app: "X", slug: "x.example", source: "pg", container: null,
    total: over.recent.length, deleted: 0, withEmail: 0,
    new: {}, capped: false, error: null, ...over,
  };
}

const row = (over: Partial<ProbeRow>): ProbeRow => ({
  created: AT, email: null, label: null, extra: null, ...over,
});

test("a probe row becomes a contract user the validator accepts", () => {
  const got = boxDocument(
    app({ recent: [row({ email: "mary@example.com", fields: { id: "u_1" } })] }),
    sourceFor("example-app-1"),
    AT,
  );
  assert.deepEqual(got.problems, []);
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  const user = check.parsed.users[0]!;
  assert.equal(user.id, "u_1");
  assert.equal(user.email, "mary@example.com");
  assert.equal(user.createdAt, new Date(AT * 1000).toISOString());
  /* Every field this source cannot answer is NULL and never a default: an
     application with no payment column has an unknown paid state, not a free
     one, and the route counts it as unknown. */
  assert.equal(user.paid, null);
  assert.equal(user.plan, null);
  assert.equal(user.country, null);
  assert.equal(user.lastSeenAt, null);
  assert.equal(user.contactPermitted, false);
});

test("a row carrying no id is skipped and the sentence names the field", () => {
  const got = boxDocument(app({ recent: [row({ fields: {} }), row({ fields: { id: "u_2" } })] }), sourceFor("example-app-1"), AT);
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.equal(check.parsed.users.length, 1);
  assert.match(got.problems.join(" "), /1 of 2 rows carry nothing at fields\.id/);
});

test("a row with no signup time is skipped rather than dated to the epoch", () => {
  const got = boxDocument(app({ recent: [row({ created: 0, fields: { id: "u_3" } })] }), sourceFor("example-app-1"), AT);
  assert.match(got.problems.join(" "), /no signup time/);
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.equal(check.parsed.users.length, 0);
});

test("a payment state in neither list is unknown, NOT free", () => {
  const src = sourceFor("example-app-12");
  const got = boxDocument(
    app({
      recent: [
        row({ fields: { id: "a", sub: "active" } }),
        row({ fields: { id: "b", sub: "inactive" } }),
        row({ fields: { id: "c", sub: "some_state_nobody_told_us_about" } }),
      ],
    }),
    src,
    AT,
  );
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.deepEqual(check.parsed.users.map((u) => u.paid), [true, false, null]);
});

test("Example App 3's two populations are split by the role the probe ships", () => {
  const got = boxDocument(
    app({
      recent: [
        row({ extra: "admin", fields: { id: "a", plan: "Free" } }),
        row({ extra: "participant", fields: { id: "b" } }),
        /* A role this table has never been told about. It falls to the
           contract's own default rather than being folded into `participant`,
           which is what makes an unnamed role visible instead of quietly
           joining whichever bucket it most resembled. */
        row({ extra: "reviewer", fields: { id: "c" } }),
      ],
    }),
    sourceFor("example-app-3"),
    AT,
  );
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.deepEqual(check.parsed.users.map((u) => u.population), ["customer", "participant", "customer"]);
  assert.equal(check.parsed.users[0]!.plan, "Free");
});

test("Example App 13's wp_users are the site's authors and are filed as admin", () => {
  const got = boxDocument(app({ recent: [row({ fields: { id: "7", login: "example-app-13" } })] }), sourceFor("example-app-13"), AT);
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.equal(check.parsed.users[0]!.population, "admin");
});

test("Example App 8 is the one source that can answer last-seen, and it is an epoch", () => {
  const got = boxDocument(
    app({ recent: [row({ fields: { id: "u", lastSeen: AT - 3600 } })] }),
    sourceFor("example-app-8"),
    AT,
  );
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.equal(check.parsed.users[0]!.lastSeenAt, new Date((AT - 3600) * 1000).toISOString());
});

test("an application with no mapping produces no rows and says so by name", () => {
  const got = boxDocument(app({ id: "brand-new-app", recent: [row({ fields: { id: "u" } })] }), undefined, AT);
  assert.match(got.problems.join(" "), /no mapping for/);
  const check = validate(got.doc);
  /* An empty list from a source that has rows is NOT silently "0 users": the
     document carries the probe's own total beside it, so the route reports
     "0 of 1 listed" rather than a product that emptied. */
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "users") return;
  assert.equal(check.parsed.users.length, 0);
  assert.equal(check.parsed.total, 1);
});

test("a capped probe says the list is shorter than the table", () => {
  const got = boxDocument(
    app({ recent: [row({ fields: { id: "u" } })], total: 9000, capped: true }),
    sourceFor("example-app-1"),
    AT,
  );
  assert.match(got.problems.join(" "), /capped at collection/);
});

/* ------------------------------------------------------------ the Stripe door */

test("live subscriptions are counted and expired checkouts are not", () => {
  upsertPlugin("stripe", true, null);
  const account = accounts.create("stripe", "Stripe test");
  const insert = db.prepare(
    `INSERT INTO stripe_subscriptions
       (id, account_id, account_label, status, currency, monthly_usd, listed_monthly_usd,
        product, created_at, ended_at, cancel_at_period_end, seen_at)
     VALUES (?,?,?,?,'usd',1,1,?,?,?,0,?)`,
  );
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  insert.run("s1", account.id, account.label, "active", "Widgetry Premium", iso(2), null, iso(0));
  insert.run("s2", account.id, account.label, "active", "Widgetry Team", iso(40), null, iso(0));
  /* Ended, so not a customer any more — and `canceled` alone is not the test:
     a subscription that has merely asked to cancel is still billing. */
  insert.run("s3", account.id, account.label, "canceled", "Widgetry Premium", iso(50), iso(1), iso(0));
  /* A checkout that never completed was never a customer at all. */
  insert.run("s4", account.id, account.label, "incomplete_expired", "Widgetry Premium", iso(3), null, iso(0));
  insert.run("s5", account.id, account.label, "active", "Something Else", iso(1), null, iso(0));

  const got = stripeDocument(["widgetry"]);
  assert.equal(got.error, null);
  assert.deepEqual(got.matched, ["Widgetry Premium", "Widgetry Team"]);
  const check = validate(got.doc);
  assert.equal(check.ok, true);
  if (!check.ok || check.parsed.shape !== "counts") return;
  assert.equal(check.parsed.total, 2);
  /* One of the two started inside the week. `new` is real here where the
     previous dashboard's fallback had to publish null, because a subscription
     carries the date it started. */
  assert.deepEqual(check.parsed.fresh, { days: 7, n: 1 });
});

test("a prefix that matches no Stripe product is refused with the ones there are", () => {
  const got = stripeDocument(["nothing-is-called-this"]);
  assert.equal(got.doc, null);
  assert.match(got.error ?? "", /No Stripe product name starts with/);
});

test("prefixes are typed one per line or comma separated, because both are natural", () => {
  assert.deepEqual(parsePrefixes("freellm, free llm\n Acme "), ["freellm", "free llm", "Acme"]);
});

/* ------------------------------------------------------------- the three kinds */

test("an account naming two kinds is refused rather than resolved by precedence", () => {
  const got = kindOf({ url: "https://a.example/u.json", box: "Apps box", product: "example-app-8" });
  assert.equal(got.kind, "none");
  if (got.kind !== "none") return;
  assert.match(got.why, /an endpoint and a box/);
});

test("a box with no product, and a product with no box, each say what is missing", () => {
  const noProduct = kindOf({ box: "Apps box" });
  assert.equal(noProduct.kind, "none");
  if (noProduct.kind === "none") assert.match(noProduct.why, /no product is/);
  const noBox = kindOf({ product: "example-app-8" });
  assert.equal(noBox.kind, "none");
  if (noBox.kind === "none") assert.match(noBox.why, /has no box/);
});

test("each kind is derived from the fields present and nothing else", () => {
  assert.equal(kindOf({ url: "https://a.example/u.json" }).kind, "endpoint");
  assert.equal(kindOf({ box: "Apps box", product: "example-app-8" }).kind, "box");
  assert.equal(kindOf({ stripe: "FreeLLMAPI" }).kind, "stripe");
  assert.equal(kindOf({}).kind, "none");
});

test("one box is probed once however many products are read off it", async () => {
  const reader = boxReader();
  /* The same promise, not merely the same answer: two accounts on one box must
     share one connection and one scan of the four databases on it. */
  const first = reader("Apps box");
  const second = reader("apps box");
  assert.equal(first, second);
  const got = await first;
  /* No fleet account exists in this test's database, so it fails — and the
     message names the fleet rather than sending the owner to a source file. */
  assert.equal(got.ok, false);
  assert.match(got.error ?? "", /no box called “Apps box” on the Fleet plugin/);
});

const sourceFor = (id: string) => lookupSource(id, EXAMPLE_SOURCES);
