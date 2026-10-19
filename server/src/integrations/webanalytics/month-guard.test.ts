/**
 * THE MONTH GUARD ON /campaigns/:ventureKey.
 *
 * The blended revenue beside a campaign table is a `BETWEEN month||'-01' AND
 * month||'-32'` string range over the charge rows, so a month that is not
 * `YYYY-MM` does not throw — it silently matches nothing, and the route
 * answers 200 with a zero revenue next to a real spend. A wrong number the
 * dashboard cannot tell from a true one. `/revenue` rejects the same input;
 * this route must too.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db, now } from "../../db.ts";
import { webAnalyticsRoutes } from "./routes.ts";

function venture(id: string): number {
  const info = db
    .prepare(
      "INSERT INTO ventures (id, slug, name, stage, color, color_source, created_at, updated_at, position) VALUES (?, ?, ?, 'launched', '#334455', 'owner', ?, ?, 0)",
    )
    .run(id, id, id, now(), now());
  return Number(info.lastInsertRowid);
}

test("?month= that is not YYYY-MM is a 400, not a confident zero", async () => {
  venture("wa-guard");
  // Note `2026-10-05` is deliberately absent: the route pre-normalises with
  // `.slice(0, 7)`, so a full date arrives as a valid month by design.
  for (const bad of ["2026-1", "2026-13", "202610", "all"]) {
    const res = await webAnalyticsRoutes.request(`/campaigns/wa-guard?month=${bad}`);
    assert.equal(res.status, 400, `month=${bad} must be rejected`);
  }
});

test("a well-formed ?month= passes the guard (reaches the data path)", async () => {
  const res = await webAnalyticsRoutes.request("/campaigns/wa-guard?month=2026-10");
  assert.notEqual(res.status, 400);
});
