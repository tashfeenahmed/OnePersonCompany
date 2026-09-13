import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../db.ts";
import { detectAnomaly, projectPace, classifyDormancy, INSIGHT_DEFAULTS, type MetricSeries } from "../../../../shared/insights.ts";
import { shiftDay } from "../../../../shared/workJournal.ts";
import { insightRoutes, validateSeries } from "./routes.ts";
import { evaluateSeriesAnomalies } from "./anomalies.ts";
import { events, rules, ackEvent, openEvents } from "../proactive/store.ts";

const today = new Date().toISOString().slice(0, 10);
const make = (patch: Partial<MetricSeries> = {}): MetricSeries => ({ id: "test:series", label: "Example app", metric: "users", source: "insights", ventureId: null, unit: "users", observedAt: new Date().toISOString(), completeThrough: shiftDay(today, -1), points: Array.from({ length: 28 }, (_, i) => ({ day: shiftDay(today, i - 28), value: 100 + i * 2 })), ...patch });

test("pace uses elapsed calendar days and projects from the last measured level", () => {
  const p = projectPace(make(), today);
  assert.equal(p.projected, 214); assert.equal(p.perWeek, 14); assert.equal(p.samples, 28);
  assert.equal(projectPace(make({ points: make().points.slice(-3) }), today).projected, null);
});
test("missing, stale, duplicate and partial days cannot fabricate a projection", () => {
  assert.equal(projectPace(make({ observedAt: shiftDay(today, -9) }), today).projected, null);
  const repeated = make(); repeated.points = Array.from({ length: 30 }, () => ({ day: shiftDay(today, -1), value: 50 }));
  assert.equal(projectPace(repeated, today).projected, null);
  const partial = make(); partial.points.push({ day: today, value: 99999 });
  assert.equal(projectPace(partial, today).projected, 214);
  const sparse = make({ points: make().points.filter((_, i) => i % 2 === 0) });
  assert.equal(projectPace(sparse, today).projected, null);
  const missing = make(); missing.points.at(-1)!.value = null;
  assert.equal(projectPace(missing, today).projected, null);
  assert.equal(detectAnomaly(missing, INSIGHT_DEFAULTS, today).state, "unavailable");
  missing.points.pop();
  assert.equal(detectAnomaly(missing, INSIGHT_DEFAULTS, today).state, "unavailable");
});
test("a reversal suppresses an otherwise plausible trend", () => {
  const s = make(); s.points = s.points.map((p, i) => ({ ...p, value: i < 21 ? 100 + i * 5 : 200 - (i - 21) * 10 }));
  assert.match(projectPace(s, today).reason!, /reversed/);
});
test("anomaly baseline excludes the current day and handles flat counts and zeros", () => {
  const s = make({ metric: "pageviews", points: make().points.map(p => ({ ...p, value: 100 })) });
  s.points.at(-1)!.value = 250;
  const result = detectAnomaly(s, INSIGHT_DEFAULTS, today);
  assert.equal(result.state, "anomaly"); assert.equal(result.baseline?.center, 100);
  assert.equal(result.baseline?.samples, 27);
  assert.equal(detectAnomaly(make({ points: [] }), INSIGHT_DEFAULTS, today).state, "unavailable");
  const zero = make({ points: make().points.map(p => ({ ...p, value: 0 })) });
  assert.equal(detectAnomaly(zero, INSIGHT_DEFAULTS, today).state, "normal");
  zero.points.at(-1)!.value = 1;
  assert.equal(detectAnomaly(zero, INSIGHT_DEFAULTS, today).state, "normal");
});
test("dormancy requires coverage, preserves growing ventures, and never combines currencies", () => {
  const input = { id: "v", name: "V", recentWork: 0, series: [make({ metric: "pageviews", points: make().points.map(p => ({ ...p, value: 1 })) })], revenue: [], revenueUnknown: false, costs: [{ currency: "EUR", amount: 10 }, { currency: "USD", amount: 20 }], costsComplete: true };
  const d = classifyDormancy(input, INSIGHT_DEFAULTS, today); assert.equal(d.status, "dormant"); assert.equal(d.costs.length, 2);
  assert.equal(classifyDormancy({ ...input, series: [] }, INSIGHT_DEFAULTS, today).status, "unknown");
  assert.equal(classifyDormancy({ ...input, revenueUnknown: true }, INSIGHT_DEFAULTS, today).status, "unknown");
  assert.equal(classifyDormancy({ ...input, recentWork: 1 }, INSIGHT_DEFAULTS, today).status, "active");
  assert.equal(classifyDormancy({ ...input, revenue: [5] }, INSIGHT_DEFAULTS, today).status, "active");
});
test("series import validates identity, currency, dates and missing values", async () => {
  const s = make({ id: "portable", metric: "mrr", unit: "EUR" });
  s.points[0]!.value = null;
  assert.equal(validateSeries(s), null);
  const request = (body: unknown) => insightRoutes.request("/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await request(s)).status, 201);
  assert.equal((await request(s)).status, 201);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM insight_points WHERE source_id = 'import:portable'").get() as { n: number }).n, 28);
  assert.equal((await request({ ...s, unit: "USD" })).status, 409);
  assert.equal((await request({ ...s, points: [...s.points, s.points[0]] })).status, 400);
  assert.equal((await request({ ...s, completeThrough: "2026-02-30" })).status, 400);
});
test("automatic anomalies deduplicate per source, survive acknowledgement, and retain recovery history", () => {
  const s = make({ id: "incident-test", metric: "pageviews", completeThrough: shiftDay(today, -3), points: Array.from({ length: 28 }, (_, i) => ({ day: shiftDay(today, i - 30), value: i === 27 ? 300 : 100 })) });
  assert.equal(evaluateSeriesAnomalies([s]).raised, 1);
  const r = rules().find(r => r.managed_source === s.id)!;
  const original = events({ ruleId: r.id })[0]!;
  ackEvent(original.id);
  assert.equal(evaluateSeriesAnomalies([s]).raised, 0);
  s.points.push({ day: shiftDay(today, -2), value: 350 }); s.completeThrough = shiftDay(today, -2);
  assert.equal(evaluateSeriesAnomalies([s]).raised, 0);
  assert.equal(events({ ruleId: r.id }).length, 1);
  s.completeThrough = shiftDay(today, -1);
  s.points.push({ day: shiftDay(today, -1), value: null });
  assert.equal(evaluateSeriesAnomalies([s]).cleared, 0);
  assert.equal(events({ ruleId: r.id, status: "active" }).length, 1);
  s.points.pop();
  s.points.push({ day: shiftDay(today, -1), value: 100 }); s.completeThrough = shiftDay(today, -1);
  assert.equal(evaluateSeriesAnomalies([s]).cleared, 1);
  assert.ok(events({ ruleId: r.id })[0]!.cleared_at); assert.equal(openEvents({ ruleId: r.id }).length, 0);
  assert.equal(events({ ruleId: r.id, status: "recovered" }).length, 1);
  assert.equal(events({ ruleId: r.id, status: "active" }).length, 0);
});
