/**
 * Closing rows a killed process left open.
 *
 * Against real tables, because the whole helper is one UPDATE and the thing
 * that can be wrong about it is the SQL: which rows it matches, what it writes,
 * and — the one that matters most — what it leaves alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { INTERRUPTED, NOW, settleAll, settleOpenRows } from "./settle.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS settle_runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settle_rounds (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, note TEXT
  );
`);

const run = (id: string, status: string) =>
  db.prepare("INSERT INTO settle_runs (id, status) VALUES (?, ?)").run(id, status);
const runRow = (id: string) =>
  db.prepare("SELECT * FROM settle_runs WHERE id = ?").get(id) as
    | { status: string; error: string | null; finished_at: string | null }
    | undefined;

test("an open row is closed, and a finished one is not touched", () => {
  db.exec("DELETE FROM settle_runs");
  run("a", "running");
  run("b", "done");
  db.prepare("UPDATE settle_runs SET finished_at = ? WHERE id = 'b'").run("2026-01-01T00:00:00.000Z");

  const closed = settleOpenRows({
    table: "settle_runs",
    openWhen: "status = 'running'",
    set: { status: "failed", error: "interrupted by a restart", finished_at: NOW },
  });

  assert.equal(closed, 1);
  assert.equal(runRow("a")?.status, "failed");
  assert.equal(runRow("a")?.error, "interrupted by a restart");
  assert.ok(runRow("a")?.finished_at, "NOW is stamped");
  assert.equal(runRow("b")?.status, "done", "a row that finished is left exactly as it was");
  assert.equal(runRow("b")?.finished_at, "2026-01-01T00:00:00.000Z");
});

test("the predicate is the caller's, so a queued row can be settled too", () => {
  /* One area's ledger calls the in-between state `running`, another's covers
     `queued` as well. Copying the pattern is how the two got written; passing
     the predicate is how one helper serves both. */
  db.exec("DELETE FROM settle_runs");
  run("a", "queued");
  run("b", "running");
  const closed = settleOpenRows({
    table: "settle_runs",
    openWhen: "status IN ('queued','running')",
    set: { status: "failed", finished_at: NOW },
  });
  assert.equal(closed, 2);
});

test("a note is written where there is not one already — never over the evidence", () => {
  /* A row that already carries a note carries a BETTER one: the process wrote
     it about the actual failure before it died. */
  db.exec("DELETE FROM settle_rounds");
  db.prepare("INSERT INTO settle_rounds (id, started_at) VALUES ('a', '2026-01-01T00:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO settle_rounds (id, started_at, note) VALUES ('b', '2026-01-01T00:00:00.000Z', 'the model refused')",
  ).run();

  const closed = settleOpenRows({
    table: "settle_rounds",
    openWhen: "finished_at IS NULL",
    set: { finished_at: NOW },
    note: { column: "note", text: INTERRUPTED },
  });

  assert.equal(closed, 2);
  const rows = db.prepare("SELECT id, note, finished_at FROM settle_rounds ORDER BY id").all() as {
    id: string;
    note: string | null;
    finished_at: string | null;
  }[];
  assert.equal(rows[0]?.note, INTERRUPTED);
  assert.equal(rows[1]?.note, "the model refused", "the row's own account of itself survives");
  assert.ok(rows[0]?.finished_at && rows[1]?.finished_at, "both are closed either way");
});

test("the row is closed and never deleted — an interrupted round still happened", () => {
  db.exec("DELETE FROM settle_rounds");
  db.prepare("INSERT INTO settle_rounds (id, started_at) VALUES ('a', '2026-01-01T00:00:00.000Z')").run();
  settleOpenRows({
    table: "settle_rounds",
    openWhen: "finished_at IS NULL",
    set: { finished_at: NOW },
  });
  const count = db.prepare("SELECT COUNT(*) AS n FROM settle_rounds").get() as { n: number };
  assert.equal(count.n, 1);
});

test("a table that is not there settles nothing rather than stopping the boot", () => {
  assert.equal(
    settleOpenRows({ table: "no_such_table", openWhen: "1 = 1", set: { finished_at: NOW } }),
    0,
  );
  /* A name that is not an identifier is a programming error, and it is refused
     the same way rather than escaped — nothing on this box passes one. */
  assert.equal(
    settleOpenRows({ table: "settle_runs; DROP TABLE settle_runs", openWhen: "1 = 1", set: {} }),
    0,
  );
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM settle_runs").get(), "the table is still there");
});

test("settleAll names each table in its answer, which is what a boot report prints", () => {
  db.exec("DELETE FROM settle_runs");
  db.exec("DELETE FROM settle_rounds");
  run("a", "running");
  const out = settleAll([
    { table: "settle_runs", openWhen: "status = 'running'", set: { status: "failed" } },
    { table: "settle_rounds", openWhen: "finished_at IS NULL", set: { finished_at: NOW } },
  ]);
  assert.deepEqual(out, [
    { table: "settle_runs", closed: 1 },
    { table: "settle_rounds", closed: 0 },
  ]);
});
