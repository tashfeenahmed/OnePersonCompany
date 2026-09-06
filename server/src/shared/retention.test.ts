/**
 * The retention registry.
 *
 * The point of the registry is that the list `/api/health` reports and the
 * list `prune()` walks are THE SAME LIST, so a health endpoint cannot name a
 * window nothing governs. That is what most of this checks — plus the two
 * details that were wrong in the copies it replaces: a day-grained column
 * compared against a full instant keeps an extra day, and a table with no
 * entry is a table nothing prunes, which must be visible rather than silent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import {
  clearRetentions,
  pruneAll,
  registerRetention,
  retentionFor,
  retentions,
} from "./retention.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS retain_instants (id INTEGER PRIMARY KEY, ts TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS retain_days (id INTEGER PRIMARY KEY, day TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS retain_leases (
    id INTEGER PRIMARY KEY, released_at TEXT
  );
`);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function seed() {
  db.exec("DELETE FROM retain_instants; DELETE FROM retain_days; DELETE FROM retain_leases");
  for (const n of [1, 10, 40, 400])
    db.prepare("INSERT INTO retain_instants (ts) VALUES (?)").run(daysAgo(n));
  for (const n of [1, 10, 40, 400])
    db.prepare("INSERT INTO retain_days (day) VALUES (?)").run(daysAgo(n).slice(0, 10));
  db.prepare("INSERT INTO retain_leases (released_at) VALUES (?)").run(daysAgo(90));
  db.prepare("INSERT INTO retain_leases (released_at) VALUES (NULL)").run();
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("what the registry lists is exactly what the prune walks", () => {
  clearRetentions();
  seed();
  registerRetention({
    table: "retain_instants",
    column: "ts",
    days: 30,
    source: "setting",
    setting: "OPC_RETAIN_DAYS",
  });
  registerRetention({ table: "retain_days", column: "day", days: 30, source: "area", grain: "day" });

  const listed = retentions().map((r) => r.table);
  const pruned = pruneAll().map((p) => p.table);
  assert.deepEqual(listed, pruned, "the health endpoint and the sweep cannot disagree");
  assert.deepEqual(listed, ["retain_days", "retain_instants"]);
  assert.equal(count("retain_instants"), 2, "the 40- and 400-day rows go");
  assert.equal(count("retain_days"), 2);
});

test("a day-grained column is compared against a day, not an instant", () => {
  /* `2026-08-01` < `2026-08-01T00:00:00.000Z` is true as a string comparison,
     so an unsliced cutoff quietly keeps one extra day at every boundary. */
  clearRetentions();
  db.exec("DELETE FROM retain_days");
  const edge = daysAgo(30).slice(0, 10);
  db.prepare("INSERT INTO retain_days (day) VALUES (?)").run(edge);
  registerRetention({ table: "retain_days", column: "day", days: 30, source: "area", grain: "day" });
  pruneAll();
  assert.equal(count("retain_days"), 1, "the day exactly on the boundary is kept, not half-kept");
});

test("an extra predicate is honoured: an open lease is a claim, not history", () => {
  clearRetentions();
  seed();
  registerRetention({
    table: "retain_leases",
    column: "released_at",
    days: 60,
    source: "area",
    where: "released_at IS NOT NULL",
    note: "Sixty days answers what has been using the GPU this quarter.",
  });
  const [outcome] = pruneAll();
  assert.equal(outcome?.deleted, 1);
  assert.equal(count("retain_leases"), 1, "the unreleased row stays");
});

test("a window that follows a setting is resolved when it is read, not when it is registered", () => {
  clearRetentions();
  let configured = 30;
  registerRetention({
    table: "retain_instants",
    column: "ts",
    days: () => configured,
    source: "setting",
    setting: "OPC_RETAIN_DAYS",
  });
  assert.equal(retentionFor("retain_instants")?.days, 30);
  configured = 7;
  assert.equal(
    retentionFor("retain_instants")?.days,
    7,
    "/api/health must not report a number the prune has stopped using",
  );
});

test("a table nothing prunes has no entry, and that is visible rather than assumed", () => {
  /* Three tables had no prune anywhere — whole JSON documents, one per
     incident — and nothing said so, because there was no list to be missing
     from. */
  clearRetentions();
  registerRetention({ table: "retain_instants", column: "ts", days: 30, source: "area" });
  assert.equal(retentionFor("security_snapshots"), undefined);
  assert.deepEqual(retentions().map((r) => r.table), ["retain_instants"]);
});

test("registering a table twice is one window, not two competing ones", () => {
  clearRetentions();
  registerRetention({ table: "retain_instants", column: "ts", days: 400, source: "setting" });
  registerRetention({ table: "retain_instants", column: "ts", days: 30, source: "area" });
  assert.equal(retentions().length, 1);
  assert.equal(retentionFor("retain_instants")?.days, 30);
});

test("one table's failure is not the sweep's", () => {
  clearRetentions();
  seed();
  registerRetention({ table: "retain_gone", column: "ts", days: 1, source: "area" });
  registerRetention({ table: "retain_instants", column: "ts", days: 30, source: "area" });
  const out = pruneAll();
  assert.equal(out.length, 2);
  assert.ok(out.find((o) => o.table === "retain_gone")?.error, "reported, not swallowed");
  assert.equal(out.find((o) => o.table === "retain_instants")?.deleted, 2, "the sweep carried on");
});

test("a table name that is not an identifier is refused at registration", () => {
  clearRetentions();
  assert.throws(
    () => registerRetention({ table: "x; DROP TABLE y", column: "ts", days: 1, source: "area" }),
    /not a plain table or column name/,
  );
});
