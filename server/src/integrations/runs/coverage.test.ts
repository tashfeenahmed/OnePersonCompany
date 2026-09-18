import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, now } from "../../db.ts";
import { runRoutes } from "./routes.ts";

function run(id: string, kind: string, ventureId: string | null, status: string, queuedAt: string) {
  db.prepare(
    "INSERT INTO agent_runs(id,kind,venture_id,title,input,status,queued_at,output,output_chars) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(id, kind, ventureId, `${kind} — ${ventureId ?? "none"}`, "{}", status, queuedAt, "", 0);
}

beforeEach(() => {
  db.exec("DELETE FROM agent_runs;");
});

test("coverage tallies one kind per venture over the whole ledger, newest venture first, with the unfiled runs apart", async () => {
  run("r-cov1", "seo", "v-a", "done", "2026-09-01T10:00:00Z");
  run("r-cov2", "seo", "v-a", "failed", "2026-09-02T10:00:00Z");
  run("r-cov3", "seo", "v-b", "running", "2026-09-03T10:00:00Z");
  run("r-cov4", "seo", null, "done", "2026-09-04T10:00:00Z");
  run("r-cov5", "demand", "v-a", "done", "2026-09-05T10:00:00Z");
  run("r-cov6", "seo", "v-a", "cancelled", "2026-08-01T10:00:00Z");

  const res = await runRoutes.request("/coverage?kind=seo");
  assert.equal(res.status, 200);
  const doc = await res.json() as {
    kind: string; needsVenture: boolean;
    ventures: { ventureId: string; count: number; done: number; failed: number; running: number; queued: number; lastAt: string; lastStatus: string }[];
    none: { count: number; lastAt: string } | null;
  };
  assert.equal(doc.kind, "seo");
  assert.equal(doc.needsVenture, true);
  /* v-b's run is newer, so it leads. */
  assert.deepEqual(doc.ventures.map((v) => v.ventureId), ["v-b", "v-a"]);
  const a = doc.ventures[1]!;
  /* Cancelled counts in `count` — it is a row in the ledger — and in no outcome. */
  assert.equal(a.count, 3);
  assert.equal(a.done, 1);
  assert.equal(a.failed, 1);
  assert.equal(a.lastAt, "2026-09-02T10:00:00Z");
  assert.equal(a.lastStatus, "failed");
  assert.equal(doc.ventures[0]!.running, 1);
  assert.equal(doc.none?.count, 1);
  /* The other kind's run did not leak in. */
  assert.equal(doc.ventures.reduce((n, v) => n + v.count, 0) + (doc.none?.count ?? 0), 5);
});

test("coverage refuses a kind this box does not run, and is empty rather than wrong for one it has never run", async () => {
  assert.equal((await runRoutes.request("/coverage?kind=nonsense")).status, 404);
  const doc = await (await runRoutes.request("/coverage?kind=serp")).json() as { ventures: unknown[]; none: unknown };
  assert.deepEqual(doc.ventures, []);
  assert.equal(doc.none, null);
});
