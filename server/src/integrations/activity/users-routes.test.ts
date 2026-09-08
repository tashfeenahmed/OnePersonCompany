/**
 * THE THREE-VALUED FIGURES ON THE USERS ROLL-UP, which is the one part of this
 * route that goes wrong silently.
 *
 * Every column here has a state that is NOT a number, and each of them means
 * something different from zero: a product that has never been collected has
 * said nothing about who pays, a product that lists its users and publishes no
 * `lastSeenAt` has declined to say who came back, and a counts-only product
 * has a user total and no windows at all. A route that answered 0 to any of
 * those would draw a card that reads "nobody" for a product nobody has asked.
 *
 * These run against the suite's temp database (test/setup.mjs) and write rows,
 * so every table they touch is emptied first.
 */
import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { db, now } from "../../db.ts";
import { userRoutes } from "./users-routes.ts";

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function account(label: string): number {
  db.prepare("INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES ('users', 1, ?)").run(now());
  const info = db
    .prepare(
      "INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at) VALUES ('users', ?, 1, ?, ?)",
    )
    .run(label, now(), now());
  return Number(info.lastInsertRowid);
}

function doc(id: number, shape: string | null, total: number | null, error: string | null = null) {
  db.prepare(
    `INSERT INTO activity_user_docs (account_id, ts, ok, status, ms, shape, url, doc, users, total, generated_at, error, problems)
     VALUES (?, ?, ?, 200, 10, ?, 'https://app.example.com/users.json', '{}', NULL, ?, NULL, ?, '[]')`,
  ).run(id, now(), error ? 0 : 1, shape, total, error);
}

function user(
  id: number,
  userId: string,
  fields: { created: number; lastSeen?: number | null; paid?: number | null; domain?: string | null },
) {
  db.prepare(
    `INSERT INTO activity_users
       (account_id, product, user_id, email_hash, email_domain, created_at, plan, paid, last_seen, country, seen_at, population, contact_permitted)
     VALUES (?, 'P', ?, ?, ?, ?, 'pro', ?, ?, 'IE', ?, 'customer', 1)`,
  ).run(
    id,
    userId,
    fields.domain ? `hash-${userId}` : null,
    fields.domain ?? null,
    iso(fields.created),
    fields.paid ?? null,
    fields.lastSeen === undefined || fields.lastSeen === null ? null : iso(fields.lastSeen),
    now(),
  );
  db.prepare(
    `INSERT OR REPLACE INTO activity_user_days (account_id, day, signups, total, source, seen_at)
     SELECT account_id, substr(created_at, 1, 10), COUNT(*), NULL, 'rows', ?
       FROM activity_users WHERE account_id = ? GROUP BY substr(created_at, 1, 10)`,
  ).run(now(), id);
}

async function report(days = 30) {
  const res = await userRoutes.request(`/?days=${days}`);
  return (await res.json()) as {
    products: Record<string, unknown>[];
    recentSignups: Record<string, unknown>[];
    summary: Record<string, number | null>;
  };
}

beforeEach(() => {
  db.exec("DELETE FROM activity_users; DELETE FROM activity_user_days; DELETE FROM activity_user_docs;");
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'users'").run();
});

test("a product nobody has collected answers null, never zero", async () => {
  account("Never asked");
  const got = await report();
  const p = got.products[0]!;
  /* EVERY ONE OF THESE WOULD BE A CLAIM ABOUT A PRODUCT NOBODY HAS READ. */
  for (const field of ["new7d", "new30d", "paid", "free", "paidUnknown", "withEmail", "contactPermitted", "active", "returned", "populations"])
    assert.equal(p[field], null, `${field} should be null for a product with no shape`);
  assert.equal(p.reachable, null, "never collected is not the same as failing");
  assert.equal(got.summary.windowsMissing, 1);
});

test("a product that lists users and publishes no lastSeenAt cannot answer active", async () => {
  const id = account("No lastSeenAt");
  doc(id, "users", 2);
  user(id, "u1", { created: 5 * DAY, paid: 1, domain: "example.com" });
  user(id, "u2", { created: 3 * DAY, paid: 0, domain: null });
  const got = await report();
  const p = got.products[0]!;
  assert.equal(p.active, null, "silence about lastSeenAt is not zero active users");
  assert.equal(p.returned, null, "and it cannot say whether anybody came back either");
  /* The columns it CAN answer are real numbers, including a real zero. */
  assert.equal(p.new30d, 2);
  assert.equal(p.paid, 1);
  assert.equal(p.free, 1);
  assert.equal(p.withEmail, 1, "one of the two rows carried an address");
  assert.equal(got.summary.activeMissing, 1);
});

test("came back means seen a day or more after joining, not merely seen", async () => {
  const id = account("Seen");
  doc(id, "users", 3);
  // Joined 5 days ago, seen again yesterday — came back.
  user(id, "back", { created: 5 * DAY, lastSeen: 1 * DAY });
  // Joined 5 days ago and last seen an hour later — the signup session itself.
  user(id, "same", { created: 5 * DAY, lastSeen: 5 * DAY - 3_600_000 });
  // Joined 5 days ago, never seen since — no lastSeenAt on this row.
  user(id, "none", { created: 5 * DAY, lastSeen: null });
  const got = await report();
  const p = got.products[0]!;
  assert.equal(p.returned, 1, "only the row seen a day later counts as having come back");
  assert.equal(p.active, 2, "the two rows with a lastSeenAt inside the window");
  assert.equal(p.lastSeenUnknown, 1, "and the third is absent from that rather than inactive");
});

test("a counts-only product has a total and no windows, and is in neither", async () => {
  const id = account("Counts only");
  doc(id, "counts", 1284);
  db.prepare(
    "INSERT INTO activity_user_days (account_id, day, signups, total, source, seen_at) VALUES (?, ?, NULL, 1284, 'counts', ?)",
  ).run(id, now().slice(0, 10), now());
  const listing = account("Listing");
  doc(listing, "users", 1);
  user(listing, "u1", { created: 2 * DAY });
  const got = await report();
  const counts = got.products.find((p) => p.product === "Counts only")!;
  assert.equal(counts.total, 1284);
  assert.equal(counts.new7d, null);
  assert.equal(counts.new30d, null);
  assert.equal(got.summary.totalUsers, 1285, "its total is in the base");
  assert.equal(got.summary.new30d, 1, "and its absence is not a zero in the window");
});

test("the recent list carries a mail domain and never an address", async () => {
  const id = account("P");
  doc(id, "users", 1);
  user(id, "u1", { created: 1 * DAY, domain: "example.com" });
  const got = await report();
  const row = got.recentSignups[0]!;
  assert.equal(row.emailDomain, "example.com");
  assert.equal("email" in row, false, "there is no address field on this document");
  assert.equal(JSON.stringify(got).includes("hash-u1"), false, "and the hash is not published either");
});
