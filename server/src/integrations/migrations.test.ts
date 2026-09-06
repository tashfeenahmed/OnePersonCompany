/**
 * THE MIGRATION LIST ITSELF, AND THE MERGES THAT MOVE ROWS BETWEEN TABLES.
 *
 * Every other test on this box runs against a database that has already had
 * every migration applied, which can only ever show that a step RAN. A merge
 * has to be checked the other way round: rows written before it, the same rows
 * readable after it, and the count preserved. So these build a scratch
 * database, stop at the 400s, write the rows a running box would have, and
 * then apply the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../db.ts";
import { INTEGRATION_MIGRATIONS } from "./migrations.ts";

/* The 400+ steps. Everything before them is "the box as it was". */
const isNew = (m: { name: string }) => m.name >= "400";

/** A database with every migration below 400, and a `migrations` table
 *  recording them — which one of the steps reads, to tell a first run apart
 *  from a box that has been going for months. */
function boxAsItWas(appliedAt = "2026-01-01T00:00:00.000Z"): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const record = db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (isNew(m)) continue;
    db.exec(m.sql);
    record.run(m.name, appliedAt);
  }
  return db;
}

function applyThisPass(db: DatabaseSync) {
  for (const m of MIGRATIONS) if (isNew(m)) db.exec(m.sql);
}

/** A connected plugin account, because every collected table hangs off one. */
function account(db: DatabaseSync, pluginId: string): number {
  db.prepare("INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES (?, 1, ?)")
    .run(pluginId, "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(pluginId, `${pluginId} login`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return Number(
    (db.prepare("SELECT id FROM plugin_accounts WHERE plugin_id = ?").get(pluginId) as { id: number })
      .id,
  );
}

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const count = (db: DatabaseSync, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/* --------------------------------------------------------------- the list */

test("the integration migrations are sorted by name, so the prefix is the order", () => {
  const names = INTEGRATION_MIGRATIONS.map((m) => m.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("the whole list is sorted, core steps included", () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("no two migrations share a name — the second would silently never run", () => {
  /* `migrations` is keyed on the name, so a duplicate is not a conflict the
     loop notices: the first one applies, the second finds a row and is
     skipped. Whatever it was going to do never happens, on every box. */
  const seen = new Set<string>();
  const clashes: string[] = [];
  for (const m of MIGRATIONS) {
    if (seen.has(m.name)) clashes.push(m.name);
    seen.add(m.name);
  }
  assert.deepEqual(clashes, []);
});

test("a migration name carries a numeric prefix and a word", () => {
  for (const m of MIGRATIONS) assert.match(m.name, /^\d{3}_[a-z0-9_]+$/, m.name);
});

/* ----------------------------------------- 400: domains <- cloudflare_registrar */

test("400 carries every Cloudflare-registered name into the portfolio", () => {
  const db = boxAsItWas();
  const cf = account(db, "cloudflare");
  const dyn = account(db, "dynadot");

  db.prepare(
    `INSERT INTO domains
       (name, source, account_id, account_label, registrar, expires_at, registered_on,
        auto_renew, locked, status, privacy, nameservers, seen_at)
     VALUES ('held.example','dynadot',?, 'dynadot login','Dynadot','2027-03-01','2019-03-01',
             1, 1, 'active', 'full', '["ns1.example"]', '2026-09-01T00:00:00.000Z')`,
  ).run(dyn);

  const ins = db.prepare(
    `INSERT INTO cloudflare_registrar
       (account_id, name, account_label, expires_at, auto_renew, locked, registrar, status, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  ins.run(cf, "one.example", "cf login", "2027-01-05", 1, 1, "Cloudflare, Inc.", "active", "2026-09-05T00:00:00.000Z");
  /* The row that proves the NOT NULL column is handled: Cloudflare did not say
     who the registrar of record is, and a portfolio row cannot be filed under
     a blank. */
  ins.run(cf, "two.example", "cf login", null, null, null, null, null, "2026-09-05T00:00:00.000Z");

  assert.equal(count(db, "cloudflare_registrar"), 2);
  assert.equal(count(db, "domains"), 1);

  applyThisPass(db);

  /* The count is preserved: one registrar name plus two Cloudflare ones. */
  assert.equal(count(db, "domains"), 3);
  const carried = rows(db, "SELECT * FROM domains WHERE source = 'cloudflare' ORDER BY name");
  assert.deepEqual(carried.map((r) => r.name), ["one.example", "two.example"]);
  assert.equal(carried[0]!.registrar, "Cloudflare, Inc.");
  assert.equal(carried[0]!.expires_at, "2027-01-05");
  assert.equal(carried[0]!.auto_renew, 1);
  assert.equal(carried[0]!.locked, 1);
  assert.equal(carried[0]!.status, "active");
  assert.equal(carried[0]!.account_id, cf);
  assert.equal(carried[0]!.account_label, "cf login");
  assert.equal(carried[0]!.seen_at, "2026-09-05T00:00:00.000Z");
  /* Asked and not told stays null; it is never "no". */
  assert.equal(carried[0]!.registered_on, null);
  assert.equal(carried[0]!.privacy, null);
  assert.equal(carried[0]!.nameservers, null);
  assert.equal(carried[1]!.registrar, "Cloudflare Registrar");
  assert.equal(carried[1]!.auto_renew, null);

  /* The registrar plugin's own row is untouched. */
  const held = rows(db, "SELECT * FROM domains WHERE source = 'dynadot'");
  assert.equal(held.length, 1);
  assert.equal(held[0]!.nameservers, '["ns1.example"]');

  /* And the table it came from is gone, not left behind half-read. */
  assert.equal(
    count(db, "sqlite_master WHERE type = 'table' AND name = 'cloudflare_registrar'"),
    0,
  );
  db.close();
});

/* --------------------------------------------- 401: site_windows <- two tables */

test("401 carries both window tables across, the traffic collector winning a tie", () => {
  const db = boxAsItWas();
  const acct = account(db, "umami");

  db.prepare(
    `INSERT INTO umami_windows
       (account_id, website_id, window_days, start_day, end_day,
        pageviews, visitors, visits, bounces, totaltime,
        prev_pageviews, prev_visitors, prev_visits, prev_bounces, prev_totaltime, seen_at)
     VALUES (?, 'site-a', 30, '2026-08-07', '2026-09-05',
             900, 500, 600, 100, 12000, 800, 450, 550, 90, 11000, '2026-09-06T06:00:00.000Z')`,
  ).run(acct);

  const web = db.prepare(
    `INSERT INTO web_site_windows
       (account_id, website_id, window_days, offset_days, start_day, end_day,
        pageviews, visitors, visits, bounces, totaltime, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  /* The contested key: the same site, the same 30 days, read a day earlier by
     the rotation. This is the disagreement the merge exists to end. */
  web.run(acct, "site-a", 30, 0, "2026-08-07", "2026-09-05", 111, 222, 333, 44, 555, "2026-09-05T06:00:00.000Z");
  /* The windows only this collector asks for. */
  web.run(acct, "site-a", 7, 0, "2026-08-30", "2026-09-05", 200, 120, 140, 20, 3000, "2026-09-05T06:00:00.000Z");
  web.run(acct, "site-a", 7, 7, "2026-08-23", "2026-08-29", 180, 110, 130, 18, 2800, "2026-09-05T06:00:00.000Z");
  web.run(acct, "site-b", 7, 0, "2026-08-30", "2026-09-05", 40, 30, 35, 5, 700, "2026-09-05T06:00:00.000Z");

  applyThisPass(db);

  /* One row per (account, website, window, offset) — the union of the two
     tables, which is four keys and not the five rows that went in. */
  assert.equal(count(db, "site_windows"), 4);

  const contested = db
    .prepare("SELECT * FROM site_windows WHERE website_id = 'site-a' AND window_days = 30 AND offset_days = 0")
    .get() as Record<string, unknown>;
  assert.equal(contested.source, "umami_windows");
  assert.equal(contested.visitors, 500);
  /* The previous-window figures only that collector fetches come with it. */
  assert.equal(contested.prev_visitors, 450);

  const sevens = rows(
    db,
    "SELECT * FROM site_windows WHERE window_days = 7 ORDER BY website_id, offset_days",
  );
  assert.deepEqual(sevens.map((r) => [r.website_id, r.offset_days, r.visitors]), [
    ["site-a", 0, 120],
    ["site-a", 7, 110],
    ["site-b", 0, 30],
  ]);
  /* The rotation never asks for a previous window, and null says exactly that
     rather than zero. */
  assert.equal(sevens[0]!.prev_visitors, null);
  assert.equal(sevens[0]!.source, "web_site_windows");

  /* NOTHING WAS DROPPED. The two writers still name these tables, so the rows
     stay where they are until the writers move. */
  assert.equal(count(db, "umami_windows"), 1);
  assert.equal(count(db, "web_site_windows"), 4);
  db.close();
});

/* ------------------------------------------- 402: the seeded ventures go away */

test("402 leaves a running box's ventures completely alone", () => {
  /* The owner's box: 021 ran months ago, the seeds have been used, and more
     ventures have been typed since. Nothing here may be deleted. */
  const db = boxAsItWas();
  db.prepare("UPDATE ventures SET brand = '{\"favicon\":\"x\"}' WHERE id = 'v-example-support'").run();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color,
                           color_source, position, brand, created_at, updated_at)
     VALUES ('v-mine','mine','Mine','','','','idea','#111','owner',4,'{}',
             '2026-02-02T00:00:00.000Z','2026-02-02T00:00:00.000Z')`,
  ).run();
  const before = rows(db, "SELECT id FROM ventures ORDER BY id").map((r) => r.id);
  assert.equal(before.length, 5);

  applyThisPass(db);

  assert.deepEqual(rows(db, "SELECT id FROM ventures ORDER BY id").map((r) => r.id), before);
  db.close();
});

test("402 leaves them alone even when they are untouched, if the box is not new", () => {
  /* The case that matters most: four pristine seeds, but 021 was applied long
     ago — so this is somebody who simply has not edited them yet, not a fresh
     clone. Doing nothing is the only safe answer. */
  const db = boxAsItWas();
  applyThisPass(db);
  assert.equal(count(db, "ventures"), 4);
  db.close();
});

test("402 empties the box on a first run, so a stranger gets no one else's businesses", () => {
  /* A fresh clone: every migration applied seconds ago, in one startup. */
  const db = boxAsItWas(new Date().toISOString());
  assert.equal(count(db, "ventures"), 4);
  applyThisPass(db);
  assert.equal(count(db, "ventures"), 0);
  db.close();
});

test("402 keeps the seeds when anything has been linked to one", () => {
  /* Freshly applied, untouched rows — but something already points at a
     venture, so the box is in use and the cascade would take that with it. */
  const db = boxAsItWas(new Date().toISOString());
  db.prepare(
    `INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at)
     VALUES ('v-example-content', 'dynadot', 'example.ie', NULL, 'owner', '2026-09-06T00:00:00.000Z')`,
  ).run();
  applyThisPass(db);
  assert.equal(count(db, "ventures"), 4);
  db.close();
});

/* ------------------------------- 403 / 404: the two additive columns */

test("403 and 404 add a column each without touching a row", () => {
  const db = boxAsItWas();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color,
                           color_source, position, brand, created_at, updated_at)
     VALUES ('v-mine','mine','Mine','','','','idea','#111','owner',4,'{}',
             '2026-02-02T00:00:00.000Z','2026-02-02T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO publish_items (id, venture_id, source_kind, caption, status,
                                approved_at, approved_by, idempotency_key, created_at, updated_at)
     VALUES ('pi-1','v-mine','manual','A caption somebody approved','approved',
             '2026-08-01T00:00:00.000Z','owner','k1',
             '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at)
     VALUES ('v-mine','dynadot','acme.ie',NULL,'owner','2026-08-01T00:00:00.000Z')`,
  ).run();

  applyThisPass(db);

  const item = db.prepare("SELECT * FROM publish_items").get() as Record<string, unknown>;
  assert.equal(item.caption, "A caption somebody approved");
  assert.equal(item.approved_by, "owner");
  /* Null, not a snapshot reconstructed from the row as it stands now — that
     would be a picture of today dressed as a record of the press. */
  assert.equal(item.approved_content, null);

  const link = db.prepare("SELECT * FROM venture_links").get() as Record<string, unknown>;
  assert.equal(link.entity, "acme.ie");
  assert.equal(link.evidence, null);
  db.close();
});
