import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceIncident, persistence } from "./lifecycle.ts";
import { insertRule, insertEvent, rule, openEvents, events, ackEvent } from "./store.ts";
import { judge } from "./engine.ts";

test("persistence requires both elapsed time and consecutive checks, and breaks on gaps", () => {
  const config = { minutes: 30, checks: 2, maxGapMinutes: 75 };
  const a = persistence({ since: null, hits: 0, checkedAt: null }, true, "2026-09-01T10:00:00Z", config);
  assert.equal(a.ready, false);
  const b = persistence(a, true, "2026-09-01T10:10:00Z", config); assert.equal(b.ready, false);
  assert.equal(persistence(b, true, "2026-09-01T10:30:00Z", config).ready, true);
  assert.equal(persistence(b, true, "2026-09-01T12:30:00Z", config).hits, 1);
  assert.equal(persistence(b, null, "2026-09-01T10:20:00Z", config).hits, 0);
  assert.equal(persistence(b, false, "2026-09-01T10:20:00Z", config).since, null);
});
test("active incidents only clear after a readable passing verdict, even if acknowledged", () => {
  const r = insertRule({ name: "CPU high", skill: "fleet", view: "default", params: {}, path: "cpu", op: ">", threshold: 90, windowMinutes: null, enabled: true, ventureId: null, cooldownMinutes: 60, forMinutes: 30, consecutive: 2 });
  const trip = insertEvent({ ruleId: r.id, kind: "trip", observed: 99, previous: 90, message: "CPU high" });
  const unreadable = insertEvent({ ruleId: r.id, kind: "unreadable", observed: null, previous: 99, message: "Missing" });
  advanceIncident(r, null, "2026-09-01T10:00:00Z");
  assert.equal(openEvents({ ruleId: r.id }).length, 2);
  const pass = judge(r, 50, { previous: 99, windowStart: null });
  ackEvent(trip.id);
  assert.equal(advanceIncident(rule(r.id)!, pass, "2026-09-01T10:30:00Z").cleared, 2);
  const history = events({ ruleId: r.id });
  assert.equal(history.length, 2); assert.ok(history.find(e => e.id === trip.id)?.acknowledged_at);
  assert.ok(history.find(e => e.id === unreadable.id)?.cleared_at); assert.equal(openEvents({ ruleId: r.id }).length, 0);
});
test("waiting state is persisted across evaluations and undecidable windows do not claim recovery", () => {
  const r = insertRule({ name: "Disk", skill: "fleet", view: "default", params: {}, path: "disk", op: ">", threshold: 85, windowMinutes: null, enabled: true, ventureId: null, cooldownMinutes: 0, forMinutes: 10, consecutive: 2 });
  const fail = judge(r, 90, { previous: 80, windowStart: null });
  assert.equal(advanceIncident(r, fail, "2026-09-01T10:00:00Z").ready, false);
  assert.equal(rule(r.id)?.pending_hits, 1);
  assert.equal(advanceIncident(rule(r.id)!, fail, "2026-09-01T10:15:00Z").ready, true);
  insertEvent({ ruleId: r.id, kind: "trip", observed: 90, previous: 85, message: "Disk" });
  advanceIncident(rule(r.id)!, { ...fail, tripped: false, undecidable: "no history" }, "2026-09-01T10:30:00Z");
  assert.equal(openEvents({ ruleId: r.id }).length, 1);
});
