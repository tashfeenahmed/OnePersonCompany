import test from "node:test";
import assert from "node:assert/strict";
import { attention, humaniseText, humanWhen, phaseOf, relative, runHeadline, runTone, took } from "./explain.ts";

const now = new Date(2026, 8, 29, 11, 30); // Tue 29 Sep 2026, 11:30 local

test("moments read as a person says them, in local time", () => {
  assert.equal(humanWhen(new Date(2026, 8, 29, 2, 0), now), "today 02:00");
  assert.equal(humanWhen(new Date(2026, 8, 28, 2, 0), now), "yesterday 02:00");
  assert.equal(humanWhen(new Date(2026, 8, 30, 2, 0), now), "tomorrow 02:00");
  assert.equal(humanWhen(new Date(2026, 8, 26, 2, 0), now), "Sat 02:00");
  assert.equal(humanWhen(new Date(2026, 8, 10, 14, 5), now), "10 Sep 14:05");
  assert.equal(humanWhen(null, now), "never");
  assert.equal(humanWhen("not a date", now), "—");
});

test("distances say in/ago in words", () => {
  assert.equal(relative(new Date(2026, 8, 29, 14, 30), now), "in 3 hours");
  assert.equal(relative(new Date(2026, 8, 29, 11, 5), now), "25 minutes ago");
  assert.equal(relative(new Date(2026, 8, 26, 11, 30), now), "3 days ago");
  assert.equal(took(7_077_027), "1h 58m");
  assert.equal(took(873), "under a second");
});

test("raw timestamps inside server sentences are rewritten", () => {
  const iso = new Date(2026, 8, 23, 2, 25).toISOString();
  assert.equal(humaniseText(`not due — last completed ${iso}`, now), "not due — last completed Wed 02:25");
  assert.equal(humaniseText("the night of 2026-09-28 is due", now), "the night of yesterday is due");
});

test("steps fall into four readable phases", () => {
  assert.equal(phaseOf("collect"), "gather");
  assert.equal(phaseOf("agent"), "analyse");
  assert.equal(phaseOf(null, "subagents"), "analyse");
  assert.equal(phaseOf("briefing"), "report");
  assert.equal(phaseOf("mystery"), "other");
});

test("a run's colour and headline follow its worst outcome", () => {
  const base = { finishedAt: "x", planned: 15, completed: 2, skipped: 1, failed: 5, overBudget: 7, note: null, dry: false, trigger: "schedule" };
  assert.equal(runTone(base), "fail");
  assert.equal(runHeadline(base), "2 of 15 done · 5 failed · 7 ran out of time");
  assert.equal(runTone({ ...base, failed: 0 }), "warn");
  assert.equal(runTone({ ...base, failed: 0, overBudget: 0 }), "ok");
  assert.equal(runHeadline({ ...base, completed: 14, failed: 0, overBudget: 0 }), "Every due step finished");
  assert.equal(runTone({ ...base, finishedAt: null }), "running");
});

test("attention explains a starved specialist and the steps squeezed out", () => {
  const items = attention({
    scheduleOn: true, running: false, skipNight: null, catchUpDay: null, maxMinutes: 120, queued: 40,
    last: { startedAt: "", steps: [
      { title: "SEO analyst", kind: "agent", outcome: "failed", error: "Block stopped before all reports finished. Its unfinished job was cancelled." },
      { title: "Review incoming mail", kind: "triage", outcome: "failed", error: "unscored" },
      { title: "Morning brief", kind: "briefing", outcome: "over-budget", error: null },
    ] },
    stages: [
      { title: "Morning brief", enabled: true, cadence: "daily", lastRun: new Date(2026, 8, 17, 2).toISOString() },
      { title: "Consolidate memory", enabled: true, cadence: "weekly", lastRun: new Date(2026, 8, 23, 2).toISOString() },
    ],
  }, now);
  assert.deepEqual(items.map((i) => i.title), [
    "1 specialist never got to start",
    "1 step failed in the last run",
    "1 step never ran — the night ran out of time",
  ]);
  assert.match(items[0]!.detail, /40 other sub-agent jobs/);
  assert.match(items[2]!.detail, /Morning brief/);
  assert.deepEqual(attention({ scheduleOn: true, running: false, skipNight: null, catchUpDay: null, maxMinutes: null, queued: 0, last: null, stages: [] }, now), []);
});
