/**
 * THE NIGHT.
 *
 * One walk over the stage registry, in dependency order, inside a window the
 * owner set, under a budget the owner set, producing ONE result he reads in
 * the morning instead of nine pages he has to visit.
 *
 * THE SHAPE OF THE FUNCTION IS THE ARGUMENT. Everything that can go wrong sits
 * inside a `try` per stage — a stage that throws is a `failed` row and the walk
 * continues — and the run row is closed in a `finally`, so there is no path on
 * which a crash leaves a night that started and, as far as the ledger can tell,
 * is still walking six weeks later. The one thing that is deliberately NOT
 * caught is a cancelled signal: an aborted night stops rather than grinding
 * through fourteen stages that will each fail on the same aborted signal.
 *
 * FOUR OUTCOMES AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   completed    it ran and said what it did.
 *   skipped      a DECISION — switched off, not due, inside a blackout, a
 *                dependency did not complete, or self-scheduled and therefore
 *                not ours to start. Never a fault, and never rendered as one.
 *   failed       a fault, with the error.
 *   over-budget  the night's clock or dollars ran out before this stage's turn.
 *                Its own outcome rather than a skip, because "you did not have
 *                time for this" and "you decided against this" want different
 *                fixes: one is a budget, the other is a switch.
 *
 * THE BUDGET IS SPENT BEFORE THE STAGE, NOT DURING IT. `spend()` in registry.ts
 * carries the argument; the short version is that a stage already running is
 * never killed by an accountant, because half-finished work with no owner is
 * worse than an overrun.
 *
 * COST IS MEASURED, NOT ESTIMATED. Each called stage runs inside its own
 * `runContext`, so every model call it makes lands in `budget_usage` against
 * `pipeline:<run>:<stage>` — the same ledger the run queue and the chat are
 * billed through. What that ledger cannot price is a box with no
 * `usdPerMillion` configured, and there the figure is NULL rather than 0.00:
 * an unpriced night spends real money it cannot count, and a zero would be the
 * one number on the page that is a lie.
 *
 * A DRY NIGHT PLANS AND SPENDS NOTHING. It walks the same graph, applies the
 * same enablement, cadence, blackout and dependency rules, and calls each
 * stage with `dry: true` so the stage itself says what it WOULD do. Its row is
 * filed beside the real ones with `dry = 1`, and — this is the part that
 * matters — a dry stage result never counts as that stage's last successful
 * pass, so planning a night at noon cannot make tonight's cadence think the
 * work was done.
 */
import { db, now } from "../../db.ts";
import { budgets, runContext, spentOnRun } from "../../runtime/budgets.ts";
import { RUNTIME_KEYS, readSetting, writeSetting } from "../../runtime/settings.ts";
import { INTERRUPTED, NOW, settleOpenRows } from "../../shared/settle.ts";
import { clip, plainCause } from "../../shared/phone.ts";
import { dueDay, wall } from "../../shared/time.ts";
import {
  allStages,
  blackoutFor,
  dueByCadence,
  orderStages,
  prefs,
  settings,
  settled,
  skipDay,
  spend,
  stage as stageById,
  type PipelineSettings,
  type SettledStage,
  type Stage,
  type StageOutcome,
  type StageResult,
} from "./registry.ts";

export type RunRow = {
  current_stage?: string | null;
  workflow_snapshot?: string | null;
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  dry: number;
  planned: number;
  completed: number;
  skipped: number;
  failed: number;
  over_budget: number;
  usd: number | null;
  ms: number | null;
  summary: string;
  note: string | null;
};

export type StageResultRow = {
  id: number;
  run_id: string;
  stage_id: string;
  area: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  reason: string | null;
  error: string | null;
  note: string | null;
  ms: number | null;
  usd: number | null;
  counts: string;
};

/* ------------------------------------------------------------------ reads */

export function runRows(limit = 20): RunRow[] {
  return db
    .prepare("SELECT * FROM pipeline_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as RunRow[];
}

export function runRow(id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function latestRealRun(): RunRow | undefined {
  return db.prepare("SELECT * FROM pipeline_runs WHERE dry=0 ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as RunRow | undefined;
}

export function stageResultRows(runId: string): StageResultRow[] {
  return db
    .prepare("SELECT * FROM pipeline_stage_results WHERE run_id = ? ORDER BY id")
    .all(runId) as unknown as StageResultRow[];
}

/**
 * The last time a stage COMPLETED in a real night — the input to the cadence
 * check. Dry rows are excluded by the join onto `pipeline_runs`, which is the
 * whole reason planning a night is free.
 */
export function lastCompleted(stageId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(r.finished_at) AS ts
         FROM pipeline_stage_results r
         JOIN pipeline_runs n ON n.id = r.run_id
        WHERE r.stage_id = ? AND r.outcome = 'completed' AND n.dry = 0`,
    )
    .get(stageId) as { ts: string | null };
  return row?.ts ?? null;
}

export function shapeRun(r: RunRow) {
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    dry: r.dry === 1,
    planned: r.planned,
    completed: r.completed,
    skipped: r.skipped,
    failed: r.failed,
    overBudget: r.over_budget,
    /** Null means this box prices no tokens, not that the night was free. */
    usd: r.usd,
    ms: r.ms,
    summary: r.summary,
    note: r.note,
    currentStage: r.finished_at ? null : r.current_stage ?? null,
  };
}

export function shapeStageResult(r: StageResultRow) {
  let counts: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(r.counts);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) counts = parsed as Record<string, number>;
  } catch {
    counts = {};
  }
  return {
    stageId: r.stage_id,
    area: r.area,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.outcome as StageOutcome,
    reason: r.reason,
    error: r.error,
    note: r.note,
    ms: r.ms,
    usd: r.usd,
    counts,
  };
}

/* ------------------------------------------------------------- the planner */

export type PlannedStage = {
  stage: Stage;
  settled: SettledStage;
  /** Null when the stage may start; the sentence to record when it may not. */
  refusal: { outcome: StageOutcome; reason: string } | null;
};

/**
 * WHAT TONIGHT WOULD DO, decided before a single stage is started.
 *
 * Separated from the walk so that the refusals which do not depend on time —
 * switched off, not due, self-scheduled, inside a blackout at the moment the
 * night begins — are all decided against ONE clock reading. Deciding them
 * one at a time as the walk reached them would let a night that started at
 * 01:58 apply one blackout to the first stage and not to the second, which is
 * a schedule nobody could reason about.
 *
 * The refusals that DO depend on how the night is going — the budget, and a
 * dependency that has not completed — are decided in the walk, because they
 * cannot be known in advance.
 */
export function plan(s: PipelineSettings, at = new Date()): { planned: PlannedStage[]; cycle: string[] } {
  const { order, cycle } = orderStages(allStages());
  const pref = prefs();
  const clock = wall(s.timezone, at);
  const planned: PlannedStage[] = [];

  for (const stage of order) {
    const conf = settled(stage, pref.get(stage.id));
    let refusal: PlannedStage["refusal"] = null;

    if (!stage.run) {
      refusal = {
        outcome: "skipped",
        reason:
          "self-scheduled — this work keeps its own timer in its own area and the " +
          "pipeline does not start it. Its last-run reading is on the schedule.",
      };
    } else if (!conf.enabled) {
      refusal = { outcome: "skipped", reason: "switched off on the schedule" };
    } else if (!dueByCadence(conf.cadence, lastCompleted(stage.id), clock.day, s.timezone)) {
      refusal = {
        outcome: "skipped",
        reason: `not due — the cadence is ${conf.cadence} and it last completed ${lastCompleted(stage.id)}`,
      };
    } else {
      const black = blackoutFor(s.blackouts, stage.id, clock.minutes, clock.weekday);
      if (black)
        refusal = {
          outcome: "skipped",
          reason: `inside the blackout window "${black.raw}"`,
        };
      else if (conf.window) {
        /* The stage's own preferred window, read with the same function as a
           blackout but inverted: outside it, the stage waits for another night
           rather than running at the wrong hour. */
        const inside = blackoutFor(
          [{ from: conf.window.slice(0, 5), to: conf.window.slice(6, 11), stages: ["*"], days: null, raw: conf.window }],
          stage.id,
          clock.minutes,
          clock.weekday,
        );
        if (!inside)
          refusal = {
            outcome: "skipped",
            reason: `outside this stage's own window ${conf.window}`,
          };
      }
    }

    planned.push({ stage, settled: conf, refusal });
  }

  for (const id of cycle) {
    const stage = stageById(id);
    if (!stage) continue;
    planned.push({
      stage,
      settled: settled(stage, pref.get(id)),
      refusal: {
        outcome: "skipped",
        reason:
          `its dependencies form a cycle with ${cycle.filter((c) => c !== id).join(", ") || "itself"}, ` +
          `so no order puts it after everything it declares. Fix the deps; the rest of the night ran.`,
      },
    });
  }

  return { planned, cycle };
}

/* ------------------------------------------------------------------ the walk */

/** One night at a time in this process. The unfinished row in the table
 *  catches a crash; this catches a second press of the button while the first
 *  is still walking, which the table cannot see. */
let walking = false;
let activeRunId: string | null = null;
let activeAbort: AbortController | null = null;
export function pipelineActivity() { return { running: walking, runId: activeRunId }; }
export function stopPipeline() { activeAbort?.abort(new Error("Stopped by the owner.")); return pipelineActivity(); }

export type NightResult = {
  ran: boolean;
  why: string | null;
  run: ReturnType<typeof shapeRun> | null;
  stages: ReturnType<typeof shapeStageResult>[];
  /** The same night worded for a phone (`phoneSummary`). Absent on a result
   *  that did not run. */
  phone?: string;
};

function mintRunId(): string {
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** How fresh a self-scheduled dependency's own work has to be before the walk
 *  stops remarking on it. A day, because every self-scheduled pass on this box
 *  runs at least daily and because the question a dependency asks is "is what I
 *  am about to read current". */
export const DEP_FRESH_HOURS = 24;

/**
 * IS A DEPENDENCY SATISFIED? Null if it is; the sentence to record if it is not.
 *
 * THREE RULES, AND EVERY ONE OF THEM WAS A BUG BEFORE IT WAS A RULE.
 *
 * A SELF-SCHEDULED DEPENDENCY NEVER BLOCKS. It cannot mean "it completed
 * tonight", because the pipeline never starts one — that was the first bug, and
 * the freshness test that replaced it was the second. `rounds` depends on
 * `collect`; `collect` is the half-hourly collector sweep; and on a box with
 * `OPC_COLLECT_MINUTES=0` (a documented setting), with nothing connected, or
 * after any outage longer than a day, `collect` has no recent row — so the
 * pipeline skipped the rounds AND their own timer had stood down for the
 * pipeline, and the estate silently stopped being walked, for ever, with only a
 * skip row a night to show for it. A dependency on work this area does not
 * control is INFORMATION, not a gate: `staleDeps` below reports it as a note on
 * the stage result, and the stage runs.
 *
 * A DEPENDENCY THAT WAS SKIPPED DOES NOT BLOCK EITHER. A skip is a DECISION —
 * switched off, not due, inside a blackout — and cascading a decision down the
 * graph turns one switch into a silent kill for everything behind it.
 *
 * A DEPENDENCY THAT FAILED OR RAN OUT OF BUDGET DOES BLOCK. That is a fault
 * rather than a decision, and the stage behind it would be reading output that
 * is missing or half-written. This is the only case left, and it is the case
 * the whole mechanism exists for.
 */
export function unsatisfied(depId: string, outcomes: Map<string, StageOutcome>): string | null {
  const dep = stageById(depId);
  /* A dependency naming a stage nothing registered. `orderStages` already
     dropped it from the ordering and published it as an unknown dep; blocking
     on it here as well would take a working stage down with a typo. */
  if (!dep) return null;
  /* Self-scheduled: advisory only. See the header. */
  if (!dep.run) return null;

  const outcome = outcomes.get(depId);
  if (outcome === "completed" || outcome === "skipped") return null;
  if (outcome === "failed") return `${depId}, which failed tonight`;
  if (outcome === "over-budget") return `${depId}, which ran out of budget before its turn tonight`;
  return `${depId}, which has not run tonight`;
}

/**
 * WHICH OF A STAGE'S SELF-SCHEDULED DEPENDENCIES LOOK STALE.
 *
 * The freshness reading that used to block, kept as a NOTE. "The rounds ran,
 * but the collectors have not since Tuesday" is worth a sentence in the
 * morning's summary; it is not worth stopping the only thing that walks the
 * estate. Never throws — a `lastRun` reader over a table another area may not
 * have migrated answers null, which reads as "never".
 */
export function staleDeps(stage: Stage, at = Date.now()): string[] {
  const out: string[] = [];
  for (const depId of stage.deps) {
    const dep = stageById(depId);
    if (!dep || dep.run) continue;
    let last: string | null = null;
    try {
      last = dep.lastRun?.() ?? null;
    } catch {
      last = null;
    }
    if (!last) {
      out.push(`${depId} has never run`);
      continue;
    }
    const ageHours = (at - Date.parse(last)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > DEP_FRESH_HOURS)
      out.push(`${depId} last ran ${last}, more than ${DEP_FRESH_HOURS} hours ago`);
  }
  return out;
}

/**
 * WALK THE NIGHT.
 *
 * `only` runs exactly one stage, dependencies and cadence included in the
 * decision but NOT walked for it: "run the synthesis now" means run it now, not
 * "run everything it depends on first", because the dependencies are the
 * night's ordering rule and not a build system.
 */
export async function runNight(
  opts: { trigger: "schedule" | "manual" | "stage"; dry?: boolean; only?: string | null; signal?: AbortSignal } = {
    trigger: "manual",
  },
): Promise<NightResult> {
  if (walking)
    return { ran: false, why: "A night is already walking. There is one walker.", run: null, stages: [] };

  const s = settings();
  const dry = opts.dry === true;
  const only = opts.only ?? null;
  if (only && !stageById(only))
    return { ran: false, why: `There is no stage called "${only}".`, run: null, stages: [] };

  const id = mintRunId();
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  /* THE ROW BEFORE THE FLAG, AND THE FLAG INSIDE THE `try`. `walking` used to
     be set before this INSERT and before the try below, so a throw in between —
     a busy database, a migration mid-flight — latched it true and every night
     afterwards answered "a night is already walking" until somebody restarted
     the server. Now nothing between here and the `finally` can leave it set. */
  try {
    db.prepare(
      "INSERT INTO pipeline_runs (id, started_at, trigger, dry, planned, completed, skipped, failed, over_budget, summary) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '')",
    ).run(id, startedIso, opts.trigger, Number(dry));
  } catch (err) {
    return {
      ran: false,
      why: `The night could not be opened in the ledger: ${err instanceof Error ? err.message : String(err)}`,
      run: null,
      stages: [],
    };
  }
  walking = true;
  activeRunId = id;
  activeAbort = new AbortController();

  const counts = { completed: 0, skipped: 0, failed: 0, "over-budget": 0 } as Record<StageOutcome, number>;
  /* What each stage DID tonight, which is what `unsatisfied` reads: a skip and
     a failure are different answers to "may the stage behind this one run". */
  const outcomes = new Map<string, StageOutcome>();
  let usdTotal: number | null = budgets().usdPerMillion ? 0 : null;

  const signal = AbortSignal.any([activeAbort.signal, ...(opts.signal ? [opts.signal] : []),
    ...(s.maxMinutes === null ? [] : [AbortSignal.timeout(s.maxMinutes * 60_000)])]);

  const file = (
    st: Stage,
    startedAtIso: string,
    ms: number | null,
    result: StageResult,
    usd: number | null,
  ) => {
    counts[result.outcome] += 1;
    outcomes.set(st.id, result.outcome);
    if (usd !== null && usdTotal !== null) usdTotal += usd;
    db.prepare(
      `INSERT INTO pipeline_stage_results
         (run_id, stage_id, area, started_at, finished_at, outcome, reason, error, note, ms, usd, counts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      st.id,
      st.area,
      startedAtIso,
      now(),
      result.outcome,
      result.reason ?? null,
      result.error ?? null,
      result.note ?? null,
      ms,
      usd,
      JSON.stringify(result.counts ?? {}),
    );
    db.prepare("UPDATE pipeline_runs SET completed=?,skipped=?,failed=?,over_budget=? WHERE id=?")
      .run(counts.completed,counts.skipped,counts.failed,counts["over-budget"],id);
  };

  try {
    const { planned } = plan(s, startedAt);
    const list = only ? planned.filter((p) => p.stage.id === only) : planned;
    db.prepare("UPDATE pipeline_runs SET planned=?,workflow_snapshot=? WHERE id=?")
      .run(list.length, JSON.stringify(list.map(p => ({ id:p.stage.id,title:p.stage.title,about:p.stage.about,deps:p.stage.deps,definition:p.stage.definition }))), id);

    for (const p of list) {
      const at = now();
      if (signal.aborted) { file(p.stage,at,0,{ outcome:"skipped",reason:"The workflow was stopped or reached its time limit." },null); continue; }

      if (p.refusal) {
        file(p.stage, at, 0, { outcome: p.refusal.outcome, reason: p.refusal.reason }, null);
        continue;
      }

      /* A DEPENDENCY THAT IS NOT SATISFIED. Not checked when one stage is run
         on its own: `only` is the owner asking for this stage now, and
         refusing because the collector has not run today would be the schedule
         overruling a button press. */
      if (!only && p.stage.requireSuccess !== false) {
        const short = p.stage.deps.map((d) => p.stage.requireSuccess === true
          ? outcomes.get(d) === "completed" ? null : `${d}, which did not complete successfully in this run`
          : unsatisfied(d, outcomes)).filter((x): x is string => x !== null);
        if (short.length) {
          file(p.stage, at, 0, { outcome: "skipped", reason: `it depends on ${short.join("; and on ")}` }, null);
          continue;
        }
      }

      const elapsedMinutes = (Date.now() - startedAt.getTime()) / 60_000;
      const gate = spend(
        { usd: usdTotal, minutes: elapsedMinutes },
        { maxUsd: s.maxUsd, maxMinutes: only ? null : s.maxMinutes },
        { maxUsd: p.settled.maxUsd, maxMinutes: p.settled.maxMinutes },
      );
      if (!gate.ok) {
        file(p.stage, at, 0, { outcome: "over-budget", reason: gate.reason }, null);
        continue;
      }

      /* What the walk noticed about this stage's self-scheduled dependencies.
         Advisory: it colours the note, it never stops the stage. */
      const stale = staleDeps(p.stage);

      const contextId = `pipeline:${id}:${p.stage.id}`;
      db.prepare("UPDATE pipeline_runs SET current_stage=? WHERE id=?").run(p.stage.id,id);
      const stageStarted = Date.now();
      const stageMs = p.settled.maxMinutes ? p.settled.maxMinutes * 60_000 : null;
      const deadline = stageMs ? stageStarted + stageMs : Number.POSITIVE_INFINITY;
      const blockSignal = stageMs ? AbortSignal.any([signal, AbortSignal.timeout(stageMs)]) : signal;
      let result: StageResult;
      try {
        result = await runContext.run(
          {
            id: contextId,
            venture: null,
            /* Automation, always — even from the button. The daily automation
               call cap exists to stop unattended work eating the whole day's
               allowance, and a night the owner started by hand is still
               unattended work. */
            automation: true,
            signal: blockSignal,
            sequence: 0,
            resume: false,
          },
          () =>
            p.stage.run!({
              runId: id,
              stageId: p.stage.id,
              dry,
              signal: blockSignal,
              deadline,
              budget: { maxUsd: p.settled.maxUsd, maxMinutes: p.settled.maxMinutes },
            }),
        );
        if (blockSignal.aborted && result.outcome === "completed") result = { ...result, outcome: "failed", error: "This block reached its time limit or was stopped." };
      } catch (err) {
        result = {
          outcome: "failed",
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        };
      }
      if (stale.length)
        result = {
          ...result,
          note: [result.note, `Worth knowing: ${stale.join("; ")}.`].filter(Boolean).join(" "),
        };
      const children = db.prepare("SELECT agent_run_id FROM pipeline_block_jobs WHERE run_id=? AND block_id=?").all(id,p.stage.id) as { agent_run_id: string }[];
      const ownUsd = dry ? null : spentOnRun(contextId);
      const stageUsd = ownUsd === null ? null : ownUsd + children.reduce((n,r) => n + (spentOnRun(r.agent_run_id) ?? 0),0);
      file(p.stage, at, Date.now() - stageStarted, result, stageUsd);
    }

    const stages = stageResultRows(id).map(shapeStageResult);
    const titles = new Map(list.map(p => [p.stage.id,p.stage.title]));
    const summary = summarise({ id, dry, trigger: opts.trigger, counts, usd: usdTotal, stages, titles });
    db.prepare(
      `UPDATE pipeline_runs SET finished_at = ?, planned = ?, completed = ?, skipped = ?, failed = ?,
              over_budget = ?, usd = ?, ms = ?, summary = ?, current_stage = NULL WHERE id = ?`,
    ).run(
      now(),
      stages.length,
      counts.completed,
      counts.skipped,
      counts.failed,
      counts["over-budget"],
      usdTotal,
      Date.now() - startedAt.getTime(),
      summary,
      id,
    );

    const row = runRow(id)!;
    return { ran: true, why: null, run: shapeRun(row), stages, phone: phoneSummary({ counts, usd: usdTotal, stages, titles }) };
  } finally {
    walking = false;
    activeRunId = null; activeAbort = null;
    /* A night that threw left its row open. Closing it here means the ledger
       never carries a run that started and is apparently still going. */
    db.prepare("UPDATE pipeline_runs SET finished_at = COALESCE(finished_at, ?),current_stage=NULL WHERE id = ?").run(now(), id);
  }
}

/* -------------------------------------------------------------- the result */

/**
 * ONE OVERNIGHT RESULT.
 *
 * Written as prose because it is delivered as prose — into the chat transcript
 * and, when the owner has paired a phone, to Telegram. The rule it follows is
 * the briefing's: what happened first, what did not happen and why, then the
 * money. A summary that led with "12 stages considered" would be a count of
 * the machine's own activity rather than a report on the estate.
 */
export function summarise(input: {
  id: string;
  dry: boolean;
  trigger: string;
  counts: Record<StageOutcome, number>;
  usd: number | null;
  stages: ReturnType<typeof shapeStageResult>[];
  titles?: ReadonlyMap<string, string>;
}): string {
  const title = (id: string) => input.titles?.get(id) ?? id;
  const head = input.dry
    ? `**Planned night** (nothing was run) — ${input.stages.length} stage${input.stages.length === 1 ? "" : "s"} considered.`
    : `**Overnight result** — ${input.counts.completed} completed, ${input.counts.skipped} skipped, ` +
      `${input.counts.failed} failed` +
      (input.counts["over-budget"] ? `, ${input.counts["over-budget"]} over budget` : "") +
      `.`;

  const lines: string[] = [head, ""];

  const ran = input.stages.filter((s) => s.outcome === "completed");
  if (ran.length) {
    lines.push(...ran.map((s) => `- **${title(s.stageId)}** — ${s.note ?? "completed, with nothing to report."}`));
  } else {
    lines.push("- Nothing ran.");
  }

  const bad = input.stages.filter((s) => s.outcome === "failed" || s.outcome === "over-budget");
  if (bad.length) {
    lines.push("");
    lines.push(
      ...bad.map(
        (s) =>
          `- **${title(s.stageId)}** ${s.outcome === "failed" ? "FAILED" : "ran out of budget"} — ${s.error ?? s.reason ?? "no reason recorded"}`,
      ),
    );
  }

  const selfScheduled = input.stages.filter((s) => s.reason?.startsWith("self-scheduled"));
  const decided = input.stages.filter(
    (s) => s.outcome === "skipped" && !s.reason?.startsWith("self-scheduled"),
  );
  if (decided.length) {
    lines.push("");
    lines.push(`Skipped: ${decided.map((s) => `${title(s.stageId)} (${s.reason ?? "no reason"})`).join("; ")}.`);
  }
  if (selfScheduled.length) {
    lines.push("");
    lines.push(
      `${selfScheduled.length} stage${selfScheduled.length === 1 ? " keeps its" : "s keep their"} own timer and ` +
        `${selfScheduled.length === 1 ? "was" : "were"} not started here: ${selfScheduled.map((s) => title(s.stageId)).join(", ")}.`,
    );
  }

  lines.push("");
  lines.push(
    input.usd === null
      ? "Cost is not measured on this box: no price per million tokens is configured, so the night's spend is unknown rather than zero."
      : `Model spend on this night: $${input.usd.toFixed(4)}. Includes direct calls and sub-agent jobs linked to workflow blocks.`,
  );

  return lines.join("\n");
}

/**
 * THE SAME NIGHT, FOR A PHONE.
 *
 * The transcript keeps `summarise`'s full account. A phone gets what a person
 * would text: how the night went in one line, the failures grouped by cause
 * in plain words — nine steps failing because the Dell was off is one
 * sentence, not nine copies of a URL and an exception class — then what got
 * done. Each stage's own note is its area's sentence and is kept as written.
 */
export function phoneSummary(input: {
  counts: Record<StageOutcome, number>;
  usd: number | null;
  stages: ReturnType<typeof shapeStageResult>[];
  titles?: ReadonlyMap<string, string>;
}): string {
  const title = (id: string) => input.titles?.get(id) ?? id;
  const c = input.counts;
  const bad = input.stages.filter((s) => s.outcome === "failed" || s.outcome === "over-budget");
  const parts = [`${c.completed} done`, c.failed ? `${c.failed} failed` : "", c["over-budget"] ? `${c["over-budget"]} over budget` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean);
  const lines = [`🌙 Overnight run: ${parts.join(", ")}`];

  /* Failures by cause: a cause this box can name once, with the steps under
     it; anything else on its own line with its reason shortened. */
  const byCause = new Map<string, string[]>();
  const odd: string[] = [];
  for (const s of bad) {
    if (s.outcome === "over-budget") {
      odd.push(`• ${title(s.stageId)}: ran out of budget`);
      continue;
    }
    const cause = plainCause(s.error ?? s.reason);
    if (cause.known) byCause.set(cause.text, [...(byCause.get(cause.text) ?? []), title(s.stageId)]);
    /* The pointer back to the dashboard ("Open their reports for details.")
       is for a screen; on a phone it is a second sentence to read. */
    else odd.push(`• ${title(s.stageId)}: ${clip(cause.text.replace(/\s*(Open their reports for details|See the per-venture notes)\.$/, ""), 120)}`);
  }
  for (const [cause, names] of byCause) {
    lines.push("", `❌ ${cause[0]!.toUpperCase()}${cause.slice(1)}, so ${names.length === 1 ? "this" : `these ${names.length}`} failed:`);
    lines.push(`• ${names.join(", ")}`);
  }
  if (odd.length) lines.push("", byCause.size ? "❌ Also failed:" : "❌ Failed:", ...odd);

  const ran = input.stages.filter((s) => s.outcome === "completed");
  if (ran.length) {
    lines.push("", "✅ Done:");
    for (const s of ran) lines.push(`• ${title(s.stageId)}${s.note ? `: ${clip(s.note.replace(/\.$/, ""), 140)}` : ""}`);
  }
  if (input.usd !== null && input.usd > 0) lines.push("", `Spent $${input.usd.toFixed(2)} on models.`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------- timer */

let timer: ReturnType<typeof setInterval> | null = null;

export const PIPELINE_SESSION = "pipeline";

/**
 * CLOSE ANY NIGHT THE PROCESS DIED IN THE MIDDLE OF.
 *
 * The general rule is `shared/settle.ts`'s; `runNight`'s own `finally` cannot
 * fire on a killed process, and two rows were left open in testing within a
 * minute of each other for exactly that reason. `runs/manifest.ts`'s
 * `failInterrupted` does the same thing for the run queue.
 */
export function closeInterrupted(): number {
  db.prepare(`UPDATE agent_runs SET status='cancelled',finished_at=?
    WHERE status='queued' AND id IN (SELECT j.agent_run_id FROM pipeline_block_jobs j
    JOIN pipeline_runs n ON n.id=j.run_id WHERE n.finished_at IS NULL)`).run(now());
  return settleOpenRows({
    table: "pipeline_runs",
    /* No status column here: an open row is one with no finish on it. */
    openWhen: "finished_at IS NULL",
    set: { finished_at: NOW, current_stage: null },
    note: { column: "note", text: INTERRUPTED },
  });
}

/** Claim only when the walker can start. A manual run must not consume the
 * scheduled night's watermark. The guard and claim are synchronous. */
export async function tickPipeline(at = new Date()): Promise<NightResult | null> {
  const s = settings();
  if (!s.enabled || walking) return null;
  const { hour, day } = wall(s.timezone, at);
  const due = dueDay(day, hour, s.hour, readSetting(RUNTIME_KEYS.pipelineLastDue));
  if (!due) return null;
  // Persist before starting so a restart never dispatches the same night twice.
  writeSetting(RUNTIME_KEYS.pipelineLastDue, due);
  const skip = skipDay();
  if (skip?.day === due) return null;
  return runNight({ trigger: "schedule" });
}

/**
 * THE NIGHTLY TIMER.
 *
 * A ten-minute interval rather than a timeout aimed at the hour, for the reason
 * every schedule on this box gives: this is a laptop, it sleeps, and a night
 * due at two while the lid was shut should run at nine when it wakes rather
 * than not at all. "Has one run today" is asked of the TABLE and not of a
 * variable, so the dozens of restarts a day that `node --watch` produces cannot
 * make it run twice.
 */
export function startPipeline() {
  if (timer) return;
  const closed = closeInterrupted();
  if (closed) console.log(`[pipeline] closed ${closed} night(s) the process died inside`);
  timer = setInterval(() => {
    void (async () => {
      try {
        const out = await tickPipeline();
        if (out?.ran) {
          await deliver(out);
          console.log(
            `[pipeline] night ${out.run?.id}: ${out.run?.completed} completed, ${out.run?.skipped} skipped, ${out.run?.failed} failed`,
          );
        }
      } catch (err) {
        /* Must not throw: this runs on a timer with nobody to catch it. */
        console.error("[pipeline] the night failed", err);
      }
    })();
  }, 10 * 60_000);
  timer.unref?.();
}

/**
 * DELIVER THE OVERNIGHT RESULT.
 *
 * Through the doors that already exist and no new ones: an assistant turn in
 * the ordinary chat transcript under a fixed session id, which is what makes
 * "Pipeline" a row in the owner's rail he can reply in, and — only if a phone
 * has been paired — the same text as a Telegram push through `notify`, which
 * is the function that cannot send to the wrong person.
 *
 * NEITHER DOOR MAY FAIL THE NIGHT. A night that died because its diary was
 * full would be the cure killing the patient.
 */
export async function deliver(out: NightResult): Promise<{ chat: boolean; telegram: boolean; note: string | null }> {
  if (!out.run) return { chat: false, telegram: false, note: "There was no run to report." };
  const text = out.run.summary;
  let chat = false;
  try {
    const { appendChatMessage } = await import("../../db.ts");
    appendChatMessage({ sessionId: PIPELINE_SESSION, role: "assistant", content: text, channel: "pipeline" });
    chat = true;
  } catch (err) {
    console.error("[pipeline] could not write the overnight result to the transcript", err);
  }

  /* A DRY NIGHT IS NOT PUSHED TO A PHONE. It is a plan somebody asked for at a
     screen; a notification for it would train the owner to ignore the ones
     that report real work. */
  if (out.run.dry) return { chat, telegram: false, note: "A planned night is not pushed." };

  /*
    QUIET HOURS BELONG TO ONE AREA, AND IT IS NOT THIS ONE.

    The customers area already owns "when may we buzz the phone": it parses the
    window, defers deliveries inside it, and the owner sets it once on the
    customers plugin. This push ignored all of that, which mattered more here
    than anywhere — the default start hour is 02:00, inside any plausible quiet
    window, so a box configured for silence was buzzed at two in the morning by
    the pipeline and by nothing else. Two owners for one rule is two rules.

    THE IMPORT IS DYNAMIC AND GUARDED, for the reason the brief gives: no
    manifest may statically reach `routes/pluginConfig.ts`, and an area that is
    not installed must not take this push down with it. A box without the
    customers area gets a push, which is the honest fallback: nothing there has
    said to be quiet.

    THE NIGHT IS NOT DEFERRED AND RE-SENT. `quietDeferral` is asked only whether
    NOW is inside the window; there is no delivery queue here, and a summary
    that arrived at eight would be read beside the briefing that already covered
    it. Inside quiet hours the transcript is the whole delivery, and the answer
    says so rather than reporting a send that did not happen.
  */
  try {
    const [{ quietDeferral }, { settings: customerSettings }] = await Promise.all([
      import("../customers/events.ts"),
      import("../customers/store.ts"),
    ]);
    const cs = customerSettings();
    if (quietDeferral(new Date(), cs.timezone, cs.quiet))
      return {
        chat,
        telegram: false,
        note:
          `Inside the quiet hours set on the customers plugin (${cs.quiet?.from}–${cs.quiet?.to}, ` +
          `${cs.timezone}), so nothing was pushed to the phone. The result is in the transcript.`,
      };
  } catch {
    /* No customers area on this box, or its settings could not be read. A
       missing quiet-hours rule is not a reason to withhold the night's result. */
  }

  try {
    /* Imported here and not at the top for briefing.ts's stated reason: the
       bridge imports routes/chat.ts, which imports the skill registry, which
       imports every manifest — including this area's. A static import would
       close that loop. */
    const { notify } = await import("../../telegram/bridge.ts");
    const sent = await notify(out.phone ?? text.replace(/\*\*/g, ""));
    return { chat, telegram: sent.sent, note: sent.sent ? null : (sent.reason ?? "The Telegram push did not go.") };
  } catch (err) {
    return { chat, telegram: false, note: err instanceof Error ? err.message : "The Telegram push failed." };
  }
}
