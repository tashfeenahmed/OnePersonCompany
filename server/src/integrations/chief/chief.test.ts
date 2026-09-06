/**
 * The rules of the chief-of-staff area whose breach is a wrong answer rather
 * than a crash: the two gates on the memory, and the ISO week the weekly pass
 * is idempotent on.
 *
 * The JSON path walker moved to `shared/metrics-address.ts` and is tested
 * there, against the superset both areas now read through.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { db, now } from "../../db.ts";
import { isoWeek, looksLikeAMeasurement, remember } from "./memory.ts";

test("the numbers gate refuses a metrics snapshot", () => {
  assert.equal(looksLikeAMeasurement("MRR is €412 and there are 14 subscriptions"), true);
  assert.equal(looksLikeAMeasurement("Traffic was 1,204 visits, up 32%"), true);
});

test("the numbers gate lets a dated decision through", () => {
  assert.equal(
    looksLikeAMeasurement("In March 2026 he decided against paid acquisition for every venture."),
    false,
  );
  assert.equal(looksLikeAMeasurement("Acme's churn is mostly trials that never activated."), false);
  /* A single figure in a sentence about a decision is not a snapshot — "one
     run slot" and "two founders" are facts that do not move. */
  assert.equal(looksLikeAMeasurement("He works on this 2 days a week."), false);
});

test("isoWeek follows the Thursday rule", () => {
  /* 2027-01-01 is a Friday, so it belongs to the last week of 2026 — the case
     a naive "week of the year" gets wrong and the reason this is eight lines
     rather than a division. */
  assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(isoWeek(new Date(2026, 8, 5)), "2026-W36");
  /* A Monday and the Sunday after it are the same week and the Sunday before
     it is not — which is what makes "one pass a week" mean one pass. */
  assert.equal(isoWeek(new Date(2026, 8, 7)), isoWeek(new Date(2026, 8, 13)));
  assert.notEqual(isoWeek(new Date(2026, 8, 6)), isoWeek(new Date(2026, 8, 7)));
});

/* --------------------------------------------------------- the venture gate */

/* A venture-scoped note lands in the system turn of every later conversation
   about that business. So an AGENT cannot write one — a claim about a product
   goes to the fact store, where it waits for confirmation — and the OWNER can,
   because the owner IS that confirmation. */
function aVenture(): string {
  const ts = now();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES ('v-gate','gate','Gate','A test','https://gate.invalid','gate.invalid','launched','#123456','default',0,'{}',?,?)`,
  ).run(ts, ts);
  return "v-gate";
}

test("an agent cannot scope a note to a venture, and the owner can", () => {
  const id = aVenture();
  const claim = "The billing page explains the annual discount clearly.";

  const byAgent = remember({ text: claim, scope: "venture", ventureId: id, source: "agent" });
  assert.equal(byAgent.ok, false);
  assert.equal(byAgent.ok === false && byAgent.status, 422);
  assert.match(byAgent.ok === false ? byAgent.error : "", /propose_fact/);

  const byOwner = remember({ text: claim, scope: "venture", ventureId: id, source: "owner" });
  assert.equal(byOwner.ok, true);
  assert.equal(byOwner.ok === true && byOwner.note.scope, "venture");
  assert.equal(byOwner.ok === true && byOwner.note.ventureId, id);

  /* The agent is refused the VENTURE and not the note. The same sentence
     global is the thing it was supposed to write instead. */
  const global = remember({ text: "The owner will not run paid acquisition.", source: "agent" });
  assert.equal(global.ok, true);
  assert.equal(global.ok === true && global.note.scope, "global");
});
