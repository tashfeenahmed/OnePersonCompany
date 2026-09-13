import { test } from "node:test";
import assert from "node:assert/strict";
import { signalGeometry } from "./signalGeometry.ts";
import { emptyJourney, journeyTasks, journeyReadiness } from "../../../../../shared/ventureJourney.ts";
test("chart keeps extremes inside its plot, handles zero/negative/flat series and breaks missing days", () => {
  for (const values of [[0, 0, 0], [-200, 500, -10], [20, 20, 20], [.001, .00001, .1]]) {
    const plot = signalGeometry(values.map((value, i) => ({ day: `2026-09-${10 + i}`, value })))!;
    assert.ok(plot.points.every(p => p.y > 12 && p.y < 137 && p.x >= 48 && p.x <= 418));
    assert.ok(plot.ticks.every(t => Number.isFinite(t.value))); assert.equal(plot.segments.length, 1);
  }
  const gaps = signalGeometry([{ day: "2026-09-01", value: 4 }, { day: "2026-09-02", value: 3 }, { day: "2026-09-05", value: 8 }])!;
  assert.equal(gaps.segments.length, 2); assert.equal(gaps.points[1]?.x, 140.5);
  assert.equal(signalGeometry([{ day: "2026-09-01", value: 4 }]), null);
});
test("readiness separates completed, skipped with a reason, optional and required open work", () => {
  const state = emptyJourney(), tasks = journeyTasks(state, "idea", "mobile");
  state.tasks["idea:common:customer"] = { status: "done", evidence: "interviews", updatedAt: "2026-09-13" };
  state.tasks["idea:common:problem"] = { status: "skipped", evidence: "Existing product, documented in knowledge", updatedAt: "2026-09-13" };
  const r = journeyReadiness(tasks, state.tasks);
  assert.equal(r.done, 1); assert.equal(r.skipped, 1); assert.equal(r.open.length, tasks.length - 2);
  assert.ok(!r.requiredOpen.some(t => t.key === "idea:common:problem")); assert.equal(r.percent, Math.round(100 / tasks.length));
});
