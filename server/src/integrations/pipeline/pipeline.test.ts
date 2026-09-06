/**
 * The rules of the night, exercised without a night.
 *
 * Everything tested here is a pure function on purpose: dependency ordering,
 * blackout parsing and matching, the cadence check, the budget cutoff, and the
 * synthesis gate. Between them they decide what runs, what does not, and what
 * reaches the owner's board — and none of them can be observed by waiting until
 * two in the morning, which is why they were written to be callable with no
 * database, no clock and no model provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blackoutFor,
  depthOf,
  dueByCadence,
  orderStages,
  parseBlackouts,
  registerStage,
  spend,
  type StageOutcome as Outcome,
  type Stage,
} from "./registry.ts";
import { gate, normalise, similarity, readActions, type Proposal } from "./synthesis.ts";
import { summarise, unsatisfied } from "./nightly.ts";

/* ------------------------------------------------------------------ stages */

const stage = (id: string, deps: string[] = []): Stage => ({
  id,
  area: "test",
  title: id,
  about: "",
  deps,
  defaultEnabled: true,
  defaultCadence: "daily",
  defaultWindow: null,
  budget: {},
  run: async () => ({ outcome: "completed" }),
});

test("dependency order puts a stage after everything it declares", () => {
  const { order, cycle, missing } = orderStages([
    stage("briefing", ["collect", "rounds", "synthesis"]),
    stage("synthesis", ["collect", "rounds"]),
    stage("rounds", ["collect"]),
    stage("collect"),
  ]);
  const ids = order.map((s) => s.id);
  assert.deepEqual(ids, ["collect", "rounds", "synthesis", "briefing"]);
  assert.deepEqual(cycle, []);
  assert.deepEqual(missing, []);
});

test("independent stages keep registration order, so two nights are comparable", () => {
  const { order } = orderStages([stage("zebra"), stage("alpha"), stage("mango")]);
  assert.deepEqual(order.map((s) => s.id), ["zebra", "alpha", "mango"]);
});

test("a cycle is reported, not thrown, and the rest of the night still orders", () => {
  const { order, cycle } = orderStages([
    stage("collect"),
    stage("a", ["b"]),
    stage("b", ["a"]),
    stage("c", ["collect"]),
  ]);
  assert.deepEqual(order.map((s) => s.id), ["collect", "c"]);
  assert.deepEqual(cycle.sort(), ["a", "b"]);
});

test("a dependency on a stage that is not registered is dropped and named", () => {
  const { order, missing } = orderStages([stage("late", ["gone"]), stage("collect")]);
  assert.deepEqual(order.map((s) => s.id), ["late", "collect"]);
  assert.deepEqual(missing, [{ stage: "late", dep: "gone" }]);
});

test("depth is the longest dependency chain behind a stage", () => {
  const stages = [stage("collect"), stage("rounds", ["collect"]), stage("synthesis", ["collect", "rounds"])];
  assert.equal(depthOf("collect", stages), 0);
  assert.equal(depthOf("rounds", stages), 1);
  assert.equal(depthOf("synthesis", stages), 2);
});

test("depth survives a cycle rather than recursing for ever", () => {
  const stages = [stage("a", ["b"]), stage("b", ["a"])];
  assert.ok(Number.isFinite(depthOf("a", stages)));
});

/* --------------------------------------------------------------- blackouts */

test("a blackout window parses with its stages and days", () => {
  const { blackouts, errors } = parseBlackouts("22:00-23:30\n09:00-17:00 stages=synthesis days=1,2,3");
  assert.deepEqual(errors, []);
  assert.equal(blackouts.length, 2);
  assert.deepEqual(blackouts[0]!.stages, ["*"]);
  assert.equal(blackouts[0]!.days, null);
  assert.deepEqual(blackouts[1]!.stages, ["synthesis"]);
  assert.deepEqual(blackouts[1]!.days, [1, 2, 3]);
});

test("a malformed blackout is reported rather than silently dropped", () => {
  const { blackouts, errors } = parseBlackouts("nonsense\n25:00-26:00\n10:00-10:00\n08:00-09:00 what=ever");
  assert.deepEqual(blackouts, []);
  assert.equal(errors.length, 4);
});

test("a stage inside a blackout is caught; one outside it is not", () => {
  const { blackouts } = parseBlackouts("22:00-23:30");
  // 22:30 on a Wednesday.
  assert.ok(blackoutFor(blackouts, "synthesis", 22 * 60 + 30, 3));
  // 23:30 is the exclusive end.
  assert.equal(blackoutFor(blackouts, "synthesis", 23 * 60 + 30, 3), null);
  assert.equal(blackoutFor(blackouts, "synthesis", 2 * 60, 3), null);
});

test("a blackout wraps past midnight", () => {
  const { blackouts } = parseBlackouts("23:00-01:00");
  assert.ok(blackoutFor(blackouts, "anything", 23 * 60 + 30, 0));
  assert.ok(blackoutFor(blackouts, "anything", 30, 0));
  assert.equal(blackoutFor(blackouts, "anything", 2 * 60, 0), null);
});

test("a blackout naming one stage does not catch another, and days are honoured", () => {
  const { blackouts } = parseBlackouts("02:00-04:00 stages=synthesis days=1");
  assert.ok(blackoutFor(blackouts, "synthesis", 3 * 60, 1));
  assert.equal(blackoutFor(blackouts, "rounds", 3 * 60, 1), null);
  assert.equal(blackoutFor(blackouts, "synthesis", 3 * 60, 2), null);
});

/* ----------------------------------------------------------------- cadence */

test("a stage that has never completed is always due", () => {
  assert.equal(dueByCadence("daily", null, "2026-09-06"), true);
  assert.equal(dueByCadence("monthly", null, "2026-09-06"), true);
  assert.equal(dueByCadence("weekly", "not a date", "2026-09-06"), true);
});

test("daily means not already today", () => {
  assert.equal(dueByCadence("daily", "2026-09-06T02:10:00.000Z", "2026-09-06"), false);
  assert.equal(dueByCadence("daily", "2026-09-05T23:59:00.000Z", "2026-09-06"), true);
});

test("weekly and monthly count clear days", () => {
  assert.equal(dueByCadence("weekly", "2026-09-01T02:00:00.000Z", "2026-09-06"), false);
  assert.equal(dueByCadence("weekly", "2026-08-30T02:00:00.000Z", "2026-09-06"), true);
  assert.equal(dueByCadence("monthly", "2026-08-20T02:00:00.000Z", "2026-09-06"), false);
  assert.equal(dueByCadence("monthly", "2026-08-01T02:00:00.000Z", "2026-09-06"), true);
});

/* ------------------------------------------------------------------ budget */

test("the night's minute budget cuts a stage off before it starts", () => {
  const out = spend({ usd: null, minutes: 121 }, { maxUsd: null, maxMinutes: 120 }, { maxUsd: null, maxMinutes: null });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /120 minutes/);
});

test("a stage whose own minute budget would not fit is refused with both figures", () => {
  const out = spend({ usd: null, minutes: 105 }, { maxUsd: null, maxMinutes: 120 }, { maxUsd: null, maxMinutes: 20 });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /allowed 20 minutes/);
});

test("the dollar budget cuts off, and quotes what was spent", () => {
  const out = spend({ usd: 2.5, minutes: 5 }, { maxUsd: 2, maxMinutes: null }, { maxUsd: null, maxMinutes: null });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /\$2\.00.*\$2\.50/);
});

test("a night that cannot price its tokens is never blocked by a dollar budget", () => {
  const out = spend({ usd: null, minutes: 5 }, { maxUsd: 0.01, maxMinutes: null }, { maxUsd: null, maxMinutes: null });
  assert.equal(out.ok, true);
});

test("no caps means everything may start", () => {
  assert.equal(
    spend({ usd: 900, minutes: 900 }, { maxUsd: null, maxMinutes: null }, { maxUsd: null, maxMinutes: null }).ok,
    true,
  );
});

/* -------------------------------------------------------------- the summary */

test("the overnight summary separates skips from failures and says when cost is unknown", () => {
  const text = summarise({
    id: "pl-x",
    dry: false,
    trigger: "schedule",
    counts: { completed: 1, skipped: 2, failed: 1, "over-budget": 0 },
    usd: null,
    stages: [
      { stageId: "rounds", area: "chief", startedAt: "", finishedAt: null, outcome: "completed", reason: null, error: null, note: "3 runs dispatched", ms: 10, usd: null, counts: {} },
      { stageId: "synthesis", area: "pipeline", startedAt: "", finishedAt: null, outcome: "failed", reason: null, error: "no provider", note: null, ms: 1, usd: null, counts: {} },
      { stageId: "collect", area: "plugins", startedAt: "", finishedAt: null, outcome: "skipped", reason: "self-scheduled — keeps its own timer", error: null, note: null, ms: 0, usd: null, counts: {} },
      { stageId: "capture", area: "ventures", startedAt: "", finishedAt: null, outcome: "skipped", reason: "not due — the cadence is weekly", error: null, note: null, ms: 0, usd: null, counts: {} },
    ],
  });
  assert.match(text, /3 runs dispatched/);
  assert.match(text, /\*\*synthesis\*\* FAILED — no provider/);
  assert.match(text, /Skipped: capture \(not due/);
  assert.match(text, /1 stage keeps its own timer and was not started here: collect/);
  assert.match(text, /Cost is not measured/);
});

/* ------------------------------------------------------------ synthesis gate */

const proposal = (title: string, evidence = "traffic"): Proposal => ({
  title,
  why: "because",
  evidence,
  evidenceLine: "pageviews fell 40%",
});

const gateInput = (over: Partial<Parameters<typeof gate>[0]> = {}) => ({
  proposals: [],
  measured: ["traffic", "tasks"],
  openCardTitles: [],
  recentProposalTitles: [],
  perVenture: 3,
  remainingTonight: 6,
  now: Date.parse("2026-09-06T00:00:00.000Z"),
  ...over,
});

test("a one-word action is refused", () => {
  const [v] = gate(gateInput({ proposals: [proposal("Improve")] }));
  assert.equal(v!.accept, false);
  assert.match((v as { reason: string }).reason, /too short/);
});

test("a proposal resting on evidence this box does not measure is refused by name", () => {
  const [v] = gate(gateInput({ proposals: [proposal("Cut the failing subscription plan", "revenue")] }));
  assert.equal(v!.accept, false);
  assert.match((v as { reason: string }).reason, /"revenue".*not measured/s);
  assert.match((v as { reason: string }).reason, /traffic, tasks/);
});

test("a proposal that is already an open card is refused, quoting the card", () => {
  const [v] = gate(
    gateInput({
      proposals: [proposal("Rewrite the pricing page copy")],
      openCardTitles: ["Rewrite pricing page copy for clarity"],
    }),
  );
  assert.equal(v!.accept, false);
  assert.match((v as { reason: string }).reason, /already an open card/);
});

test("figures are stripped before comparison, so the same job with a new number still collides", () => {
  assert.ok(similarity("Reply to 12 outstanding reviews", "Reply to 40 outstanding reviews") >= 0.6);
  assert.equal(normalise("Reply to 12 outstanding reviews"), "reply outstanding reviews");
});

test("a proposal made recently is not repeated, and the reason says how long ago", () => {
  const [v] = gate(
    gateInput({
      proposals: [proposal("Add a pricing FAQ to the landing page")],
      recentProposalTitles: [
        { title: "Add pricing FAQ to landing page", at: "2026-09-02T00:00:00.000Z", verdict: "dropped" },
      ],
    }),
  );
  assert.equal(v!.accept, false);
  assert.match((v as { reason: string }).reason, /proposed 4 days ago and dropped/);
});

test("the same action twice in one answer is accepted once", () => {
  const verdicts = gate(
    gateInput({
      proposals: [proposal("Publish a comparison page against the main competitor"), proposal("Publish comparison page against main competitor")],
    }),
  );
  assert.equal(verdicts[0]!.accept, true);
  assert.equal(verdicts[1]!.accept, false);
  assert.match((verdicts[1] as { reason: string }).reason, /already accepted from this same answer/);
});

test("the per-venture cap refuses the fourth good action", () => {
  const verdicts = gate(
    gateInput({
      perVenture: 2,
      proposals: [
        proposal("Publish a comparison page against the main competitor"),
        proposal("Instrument the checkout funnel with events"),
        proposal("Write onboarding email for trial signups"),
      ],
    }),
  );
  assert.deepEqual(verdicts.map((v) => v.accept), [true, true, false]);
  assert.match((verdicts[2] as { reason: string }).reason, /cap of 2 proposals/);
});

test("the night's remaining budget refuses everything once it is spent", () => {
  const verdicts = gate(
    gateInput({ remainingTonight: 0, proposals: [proposal("Publish a comparison page against the competitor")] }),
  );
  assert.equal(verdicts[0]!.accept, false);
  assert.match((verdicts[0] as { reason: string }).reason, /night's proposal budget/);
});

test("a good, specific, evidence-backed action survives every rule", () => {
  const verdicts = gate(gateInput({ proposals: [proposal("Publish a comparison page against the main competitor")] }));
  assert.equal(verdicts[0]!.accept, true);
});

/* ----------------------------------------------------------- reading a model */

test("the model's JSON is read through a fence and through surrounding prose", () => {
  const out = readActions(
    'Sure. ```json\n{"actions":[{"title":"Fix the signup form","why":"it 404s","evidence":"alerts","evidenceLine":"uptime rule tripped"}]}\n``` Hope that helps.',
  );
  assert.equal(out?.length, 1);
  assert.equal(out![0]!.title, "Fix the signup form");
  assert.equal(out![0]!.evidence, "alerts");
});

test("an unreadable answer proposes nothing at all rather than something", () => {
  assert.equal(readActions("I could not do that."), null);
  assert.equal(readActions('{"nope": true}'), null);
  assert.deepEqual(readActions('{"actions":[]}'), []);
});

test("an action with no title is dropped on the way in", () => {
  const out = readActions('{"actions":[{"why":"no title here"},{"title":"Real one","evidence":"tasks"}]}');
  assert.equal(out?.length, 1);
  assert.equal(out![0]!.title, "Real one");
});

/* -------------------------------------------------- dependency satisfaction */

const outcomes = (o: Record<string, Outcome> = {}) => new Map(Object.entries(o));

test("an unknown dependency does not block — a typo must not take a working stage down", () => {
  assert.equal(unsatisfied("nothing-registered", outcomes()), null);
});

test("a dependency that completed tonight is satisfied", () => {
  registerStage(stage("dep-done"));
  assert.equal(unsatisfied("dep-done", outcomes({ "dep-done": "completed" })), null);
});

test("a dependency the schedule SKIPPED does not block — a switch must not cascade", () => {
  registerStage(stage("dep-skipped"));
  assert.equal(unsatisfied("dep-skipped", outcomes({ "dep-skipped": "skipped" })), null);
});

test("a dependency that FAILED blocks, because the stage behind it would read half-written output", () => {
  registerStage(stage("dep-failed"));
  assert.match(unsatisfied("dep-failed", outcomes({ "dep-failed": "failed" }))!, /which failed tonight/);
});

test("a dependency that ran out of budget blocks, and says which", () => {
  registerStage(stage("dep-broke"));
  assert.match(unsatisfied("dep-broke", outcomes({ "dep-broke": "over-budget" }))!, /ran out of budget/);
});

test("a pipeline-scheduled dependency that has not run at all blocks", () => {
  registerStage(stage("dep-pending"));
  assert.match(unsatisfied("dep-pending", outcomes())!, /has not run tonight/);
});

test("a self-scheduled dependency is satisfied by freshness, not by completing here", () => {
  registerStage({
    ...stage("dep-self"),
    run: undefined,
    lastRun: () => new Date(Date.now() - 3_600_000).toISOString(),
  });
  assert.equal(unsatisfied("dep-self", outcomes()), null);
});

test("a stale self-scheduled dependency blocks, quoting the reading and the window", () => {
  registerStage({
    ...stage("dep-stale"),
    run: undefined,
    lastRun: () => new Date(Date.now() - 48 * 3_600_000).toISOString(),
  });
  assert.match(unsatisfied("dep-stale", outcomes())!, /more than 24 hours ago/);
});

test("a self-scheduled dependency that has never run blocks with that exact reason", () => {
  registerStage({ ...stage("dep-never"), run: undefined, lastRun: () => null });
  assert.match(unsatisfied("dep-never", outcomes())!, /has never run/);
});
