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
import { gate, normalise, readActions, type Proposal, type ProposalVerdict } from "./synthesis.ts";
import { phoneSummary, staleDeps, summarise, unsatisfied } from "./nightly.ts";
import { dueNight } from "./routes.ts";
import { readBool, refuseDry } from "./params.ts";
import { dueDay } from "../../shared/time.ts";

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

/* Every cadence test names its zone. Passing null means "this machine's own",
   which is right in the product and useless in a test: the answer would depend
   on where the laptop running the suite happens to be. */
test("a stage that has never completed is always due", () => {
  assert.equal(dueByCadence("daily", null, "2026-09-06", "UTC"), true);
  assert.equal(dueByCadence("monthly", null, "2026-09-06", "UTC"), true);
  assert.equal(dueByCadence("weekly", "not a date", "2026-09-06", "UTC"), true);
});

test("daily means not already today", () => {
  assert.equal(dueByCadence("daily", "2026-09-06T02:10:00.000Z", "2026-09-06", "UTC"), false);
  assert.equal(dueByCadence("daily", "2026-09-05T23:59:00.000Z", "2026-09-06", "UTC"), true);
});

test("weekly and monthly count clear days", () => {
  assert.equal(dueByCadence("weekly", "2026-09-01T02:00:00.000Z", "2026-09-06", "UTC"), false);
  assert.equal(dueByCadence("weekly", "2026-08-30T02:00:00.000Z", "2026-09-06", "UTC"), true);
  assert.equal(dueByCadence("monthly", "2026-08-20T02:00:00.000Z", "2026-09-06", "UTC"), false);
  assert.equal(dueByCadence("monthly", "2026-08-01T02:00:00.000Z", "2026-09-06", "UTC"), true);
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

test("the phone version groups failures by a cause it can name and keeps each stage's own note", () => {
  const stage = (stageId: string, outcome: string, p: { error?: string; note?: string } = {}) => ({
    stageId, area: "x", startedAt: "", finishedAt: null, outcome: outcome as "completed", reason: null,
    error: p.error ?? null, note: p.note ?? null, ms: 1, usd: null, counts: {},
  });
  const dell = "Could not reach Local · Dell 5820 (Dell 5820) at http://192.168.1.50:11434/v1/chat/completions (TypeError).";
  const text = phoneSummary({
    counts: { completed: 2, skipped: 1, failed: 3, "over-budget": 0 },
    usd: null,
    titles: new Map([["collect", "Refresh connected data"], ["mail", "Review incoming mail"], ["brief", "Morning brief"], ["seo", "SEO analyst"], ["alerts", "Check alerts"]]),
    stages: [
      stage("collect", "completed", { note: "21 sources refreshed; 0 failed." }),
      stage("alerts", "completed"),
      stage("mail", "failed", { error: `tash@example.com: The scorer failed part-way: ${dell}` }),
      stage("brief", "failed", { error: `The briefing was assembled but not written up: ${dell}` }),
      stage("seo", "failed", { error: "2 analysis jobs failed. Open their reports for details." }),
    ],
  });
  assert.equal(
    text,
    [
      "🌙 Overnight run: 2 done, 3 failed, 1 skipped",
      "",
      "❌ Couldn't reach the Dell, it looks switched off, so these 2 failed:",
      "• Review incoming mail, Morning brief",
      "",
      "❌ Also failed:",
      "• SEO analyst: 2 analysis jobs failed.",
      "",
      "✅ Done:",
      "• Refresh connected data: 21 sources refreshed; 0 failed",
      "• Check alerts",
    ].join("\n"),
  );
  assert.ok(!text.includes("192.168"), "no model URL on a phone");
});

/* ------------------------------------------------------------ synthesis gate */

/* The evidence LINE is a parameter because one finding buys one card: two
   proposals quoting the same sentence are the same finding twice, and the gate
   refuses the second. Fixtures that mean two different actions have to quote
   two different findings, exactly as a real pass would. */
const proposal = (title: string, evidence = "traffic", evidenceLine = "pageviews fell 40%"): Proposal => ({
  title,
  why: "because",
  evidence,
  evidenceLine,
});

/* The judge — a model since 2026-09-21 — is stubbed permissive so that the
   deterministic refusals below are tested on their own. `judged()` is for the
   tests that are about a verdict being applied. */
const gateInput = (over: Partial<Parameters<typeof gate>[0]> = {}) => {
  const proposals = over.proposals ?? [];
  return {
    proposals,
    measured: ["traffic", "tasks"],
    openCardTitles: [],
    recentProposalTitles: [],
    judgements: new Map(
      proposals.map((_, i) => [String(i), { verdict: "file" as ProposalVerdict, why: "a real action" }]),
    ),
    perVenture: 3,
    remainingTonight: 6,
    now: Date.parse("2026-09-06T00:00:00.000Z"),
    ...over,
  };
};

const judged = (...verdicts: (ProposalVerdict | "unjudged")[]) =>
  new Map(verdicts.map((verdict, i) => [String(i), { verdict, why: "the judge's reason" }]));

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

test("a proposal the judge calls a duplicate is refused as one", () => {
  /* Which proposals ARE duplicates is the model's call, and it is shown the open
     board to make it — see `judgeProposals`. This asserts only that the verdict
     is applied and named. */
  const [v] = gate(
    gateInput({
      proposals: [proposal("Rewrite the pricing page copy")],
      openCardTitles: ["Rewrite pricing page copy for clarity"],
      judgements: judged("duplicate"),
    }),
  );
  assert.equal(v!.accept, false);
  assert.match((v as { reason: string }).reason, /already proposed or on the board/);
});

test("figures and stopwords are stripped from a finding's identity key", () => {
  /* `normalise` survived the move to a model judge because what is left of it is
     an identity key for one finding — equality, not a similarity threshold. */
  assert.equal(normalise("Reply to 12 outstanding reviews"), "reply outstanding reviews");
  assert.equal(normalise("Reply to 40 outstanding reviews"), "reply outstanding reviews");
});

test("the recent proposals are handed to the judge rather than compared here", () => {
  /* The gate no longer decides "proposed four days ago" itself; the titles and
     their dates go into the judge's context (`judgeProposals`). A permissive
     verdict therefore files it, which is the honest behaviour for a pure
     function that was told the proposal is fine. */
  const [v] = gate(
    gateInput({
      proposals: [proposal("Add a pricing FAQ to the landing page")],
      recentProposalTitles: [
        { title: "Add pricing FAQ to landing page", at: "2026-09-02T00:00:00.000Z", verdict: "dropped" },
      ],
    }),
  );
  assert.equal(v!.accept, true);
});

test("a twin inside one answer is refused when the judge names it", () => {
  /* One model call sees the whole batch, which is how the twin is caught at all
     — a per-proposal call could not see its sibling. */
  const verdicts = gate(
    gateInput({
      proposals: [
        proposal("Publish a comparison page against the main competitor"),
        proposal("Publish comparison page against main competitor"),
      ],
      judgements: judged("file", "duplicate"),
    }),
  );
  assert.equal(verdicts[0]!.accept, true);
  assert.equal(verdicts[1]!.accept, false);
  assert.match((verdicts[1] as { reason: string }).reason, /already proposed or on the board/);
});

test("the per-venture cap refuses the fourth good action", () => {
  const verdicts = gate(
    gateInput({
      perVenture: 2,
      proposals: [
        proposal("Publish a comparison page against the main competitor", "traffic", "pageviews fell 40%"),
        proposal("Instrument the checkout funnel with events", "traffic", "the checkout page had 12 views and no conversions"),
        proposal("Write onboarding email for trial signups", "traffic", "the trial signup page was the second most visited"),
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

/*
  P1 #6 — THE REGRESSION THAT COULD STOP THE ESTATE.

  `rounds` depends on `collect`, `collect` is self-scheduled, and a box with the
  collector switched off, nothing connected, or a day's outage has no recent
  `collect` row. The freshness test used to BLOCK on that — while
  `pipelineOwnsRounds()` had already stood the rounds' own timer down — so the
  estate silently stopped being walked, for ever. A self-scheduled dependency is
  now advisory, always, whatever its reading.
*/
test("a self-scheduled dependency never blocks, however stale", () => {
  registerStage({
    ...stage("dep-self-fresh"),
    run: undefined,
    lastRun: () => new Date(Date.now() - 3_600_000).toISOString(),
  });
  registerStage({
    ...stage("dep-self-stale"),
    run: undefined,
    lastRun: () => new Date(Date.now() - 400 * 3_600_000).toISOString(),
  });
  registerStage({ ...stage("dep-self-never"), run: undefined, lastRun: () => null });
  assert.equal(unsatisfied("dep-self-fresh", outcomes()), null);
  assert.equal(unsatisfied("dep-self-stale", outcomes()), null);
  assert.equal(unsatisfied("dep-self-never", outcomes()), null);
});

test("a stale self-scheduled dependency is reported as a note instead", () => {
  registerStage({
    ...stage("dep-self-stale2"),
    run: undefined,
    lastRun: () => new Date(Date.now() - 400 * 3_600_000).toISOString(),
  });
  registerStage({ ...stage("dep-self-never2"), run: undefined, lastRun: () => null });
  const dependent = stage("depends-on-both", ["dep-self-stale2", "dep-self-never2", "nothing-registered"]);
  const notes = staleDeps(dependent);
  assert.equal(notes.length, 2);
  assert.match(notes.join(" "), /dep-self-stale2 last ran .* more than 24 hours ago/);
  assert.match(notes.join(" "), /dep-self-never2 has never run/);
});

test("a stale reader that throws is not a reason to stop the stage", () => {
  registerStage({
    ...stage("dep-self-throws"),
    run: undefined,
    lastRun: () => {
      throw new Error("that area has no table here");
    },
  });
  assert.equal(unsatisfied("dep-self-throws", outcomes()), null);
  assert.deepEqual(staleDeps(stage("x", ["dep-self-throws"])), ["dep-self-throws has never run"]);
});

/* -------------------------------------------- P0/P1: booleans off the wire */

/*
  THE SKILLS PROXY SENDS EVERY PARAMETER AS A STRING. A route testing
  `body.dry === true` reads `"true"` as FALSE, which once published a real
  Facebook post while an agent believed it was rehearsing, and which in this
  area meant `opc pipeline run_stage --dry true` walked a real night. These
  are the tests that stop it coming back.
*/
test("readBool takes every spelling a proxy, a CLI or a JSON client sends", () => {
  for (const yes of [true, 1, "true", "TRUE", " True ", "yes", "on", "1"])
    assert.deepEqual(readBool(yes, "f"), { ok: true, value: true }, `for ${JSON.stringify(yes)}`);
  for (const no of [false, 0, "false", "FALSE", "no", "off", "0"])
    assert.deepEqual(readBool(no, "f"), { ok: true, value: false }, `for ${JSON.stringify(no)}`);
});

test("readBool REFUSES what it cannot parse rather than defaulting to false", () => {
  for (const bad of ["maybe", "t", "", 2, {}, []]) {
    const out = readBool(bad, "dry");
    assert.equal(out.ok, false, `for ${JSON.stringify(bad)}`);
    assert.match((out as { error: string }).error, /`dry`/);
  }
});

test("readBool treats null as a third answer only where a caller allowed one", () => {
  assert.deepEqual(readBool(null, "enabled", { allowNull: true }), { ok: true, value: null });
  assert.deepEqual(readBool("null", "enabled", { allowNull: true }), { ok: true, value: null });
  assert.deepEqual(readBool(undefined, "enabled", { allowNull: true }), { ok: true, value: null });
  assert.equal(readBool(null, "cancel").ok, false);
  assert.equal(readBool("null", "cancel").ok, false);
});

test("a real route refuses the word dry whatever is in it, and names the rehearsal", () => {
  for (const body of [{ dry: true }, { dry: "true" }, { dry: false }, { dry: "nonsense" }, { dry: null }]) {
    const out = refuseDry(body, "POST /api/pipeline/plan");
    assert.ok(out, `for ${JSON.stringify(body)}`);
    assert.match(out!, /POST \/api\/pipeline\/plan/);
  }
  assert.equal(refuseDry({ stage: "rounds" }, "POST /api/pipeline/plan"), null);
  assert.equal(refuseDry(null, "POST /api/pipeline/plan"), null);
});

/* ------------------------------------------- P1 #4: which night is tonight */

/*
  A night that starts at 02:00 belongs to TOMORROW's date. "Skip tonight" pressed
  at nine in the evening used to store today's, so the timer at two in the
  morning asked about a different day and the night ran — after a page that had
  said all evening that it would not.
*/
test("skip-tonight stores the night's own day, not today's", () => {
  // 21:00 with a 02:00 start: the coming night is tomorrow's.
  assert.equal(dueNight("2026-09-06", 21, 2), "2026-09-07");
  // 00:30, still before the start hour: the coming night is still today's.
  assert.equal(dueNight("2026-09-07", 0, 2), "2026-09-07");
  // 02:30, the night has started: the NEXT one is tomorrow's.
  assert.equal(dueNight("2026-09-07", 2, 2), "2026-09-08");
  // It agrees with dueDay, which is what the timer actually asks.
  assert.equal(dueNight("2026-09-07", 3, 2), "2026-09-08");
  assert.equal(dueDay("2026-09-07", 3, 2, null), "2026-09-07");
  assert.equal(dueNight("2026-09-06", 23, 2), dueDay("2026-09-07", 3, 2, null));
});

test("skip-tonight crosses a month and a year end", () => {
  assert.equal(dueNight("2026-09-30", 22, 2), "2026-10-01");
  assert.equal(dueNight("2026-12-31", 22, 2), "2027-01-01");
});

/* --------------------------- P1 #5: the cadence day is the owner's day too */

/*
  `lastAt` used to be turned into a UTC date and compared with a zone-local
  `today`. In a negative-offset zone with a late start hour the run lands on the
  NEXT UTC date, so the following night read "already today" and every daily
  stage was reported not due — the pipeline would have run the estate every
  second night, for ever. Europe/Dublin at 02:00, this box's setting, is
  unaffected, which is why live testing never showed it.
*/
test("a daily stage run at 22:00 New York is due again the next night", () => {
  // 2026-09-06 22:30 America/New_York is 2026-09-07T02:30Z — a different UTC day.
  const lastAt = "2026-09-07T02:30:00.000Z";
  assert.equal(dueByCadence("daily", lastAt, "2026-09-06", "America/New_York"), false);
  assert.equal(dueByCadence("daily", lastAt, "2026-09-07", "America/New_York"), true);
  // The bug, reproduced by asking in UTC: the 7th looks like "already today".
  assert.equal(dueByCadence("daily", lastAt, "2026-09-07", "UTC"), false);
});

test("a positive-offset zone is handled in the same direction", () => {
  // 2026-09-07 01:30 Asia/Tokyo is 2026-09-06T16:30Z — the previous UTC day.
  const lastAt = "2026-09-06T16:30:00.000Z";
  assert.equal(dueByCadence("daily", lastAt, "2026-09-07", "Asia/Tokyo"), false);
  assert.equal(dueByCadence("daily", lastAt, "2026-09-08", "Asia/Tokyo"), true);
});

test("weekly and monthly are measured in the owner's days as well", () => {
  const lastAt = "2026-09-07T02:30:00.000Z"; // the 6th, in New York
  assert.equal(dueByCadence("weekly", lastAt, "2026-09-12", "America/New_York"), false);
  assert.equal(dueByCadence("weekly", lastAt, "2026-09-13", "America/New_York"), true);
});
