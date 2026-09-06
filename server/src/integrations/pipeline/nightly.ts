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
import { budgets, runContext } from "../../runtime/budgets.ts";
import { dueDay } from "../../runtime/schedule.ts";
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
  zoned,
  type PipelineSettings,
  type SettledStage,
  type Stage,
  type StageOutcome,
  type StageResult,
} from "./registry.ts";

export type RunRow = {
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
  const clock = zoned(s, at);
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
    } else if (!dueByCadence(conf.cadence, lastCompleted(stage.id), clock.day)) {
      refusal = {
        outcome: "skipped",
        reason: `not due — the cadence is ${conf.cadence} and it last completed ${lastCompleted(stage.id)}`,
      };
    } else {
      const black = blackoutFor(s.blackouts, stage.id, clock.minute, clock.weekday);
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
          clock.minute,
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

export type NightResult = {
  ran: boolean;
  why: string | null;
  run: ReturnType<typeof shapeRun> | null;
  stages: ReturnType<typeof shapeStageResult>[];
};

function mintRunId(): string {
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** What one stage's model calls cost, read from the same ledger the run queue
 *  is billed through. Null when this box prices no tokens — see the header. */
function costOf(contextId: string): number | null {
  if (!budgets().usdPerMillion) return null;
  try {
    const row = db
      .prepare("SELECT coalesce(sum(usd), 0) AS usd FROM budget_usage WHERE run_id = ?")
      .get(contextId) as { usd: number };
    return Number(row.usd);
  } catch {
    return null;
  }
}

/** How fresh a self-scheduled dependency's own work has to be to count as
 *  satisfied. A day, because every self-scheduled pass on this box runs at
 *  least daily and because the question a dependency asks is "is what I am
 *  about to read current". */
export const DEP_FRESH_HOURS = 24;

/**
 * IS A DEPENDENCY SATISFIED? Null if it is; the sentence to record if it is not.
 *
 * THREE RULES, AND EACH OF THEM WAS A BUG BEFORE IT WAS A RULE.
 *
 * A DEPENDENCY ON A SELF-SCHEDULED STAGE CANNOT MEAN "IT COMPLETED TONIGHT",
 * because the pipeline never starts one and so it never completes here. It was
 * the first thing this file got wrong: `rounds` depends on `collect`, `collect`
 * keeps its own half-hourly timer, and the walk skipped the rounds every single
 * night waiting for a completion that by construction could not arrive. So a
 * self-scheduled dependency is satisfied by its own FRESHNESS — the newest row
 * its area wrote, inside the last day — which is what the depending stage
 * actually needs to be true. It is a weaker claim than "it completed", and the
 * skip reason says which claim failed so the morning is not left guessing.
 *
 * A DEPENDENCY THAT WAS SKIPPED DOES NOT BLOCK, and that is the second one. A
 * skip is a DECISION — the owner switched that stage off, or it is not due
 * tonight, or it is inside a blackout — and cascading a decision down the graph
 * turns one switch into a silent kill for everything behind it. With the rounds
 * switched off, the synthesis pass would never run again, for a reason nobody
 * would ever connect to the switch they flipped. The dependency did its job:
 * it had its turn first.
 *
 * A DEPENDENCY THAT FAILED OR RAN OUT OF BUDGET DOES BLOCK. That is a fault
 * rather than a decision, and the stage behind it would be reading output that
 * is missing or half-written. This is the case the whole mechanism exists for.
 */
export function unsatisfied(depId: string, outcomes: Map<string, StageOutcome>): string | null {
  const dep = stageById(depId);
  /* A dependency naming a stage nothing registered. `orderStages` already
     dropped it from the ordering and published it as an unknown dep; blocking
     on it here as well would take a working stage down with a typo. */
  if (!dep) return null;

  if (!dep.run) {
    let last: string | null = null;
    try {
      last = dep.lastRun?.() ?? null;
    } catch {
      last = null;
    }
    if (!last) return `${depId}, which keeps its own timer and has never run`;
    const ageHours = (Date.now() - Date.parse(last)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > DEP_FRESH_HOURS)
      return `${depId}, which keeps its own timer and last ran ${last} — more than ${DEP_FRESH_HOURS} hours ago`;
    return null;
  }

  const outcome = outcomes.get(depId);
  if (outcome === "completed" || outcome === "skipped") return null;
  if (outcome === "failed") return `${depId}, which failed tonight`;
  if (outcome === "over-budget") return `${depId}, which ran out of budget before its turn tonight`;
  return `${depId}, which has not run tonight`;
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

  walking = true;
  const id = mintRunId();
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  db.prepare(
    "INSERT INTO pipeline_runs (id, started_at, trigger, dry, planned, completed, skipped, failed, over_budget, summary) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '')",
  ).run(id, startedIso, opts.trigger, Number(dry));

  const counts = { completed: 0, skipped: 0, failed: 0, "over-budget": 0 } as Record<StageOutcome, number>;
  /* What each stage DID tonight, which is what `unsatisfied` reads: a skip and
     a failure are different answers to "may the stage behind this one run". */
  const outcomes = new Map<string, StageOutcome>();
  let usdTotal: number | null = budgets().usdPerMillion ? 0 : null;

  const signal = opts.signal ?? AbortSignal.timeout(Math.max(60, (s.maxMinutes ?? 240) * 60) * 1000);

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
  };

  try {
    const { planned } = plan(s, startedAt);
    const list = only ? planned.filter((p) => p.stage.id === only) : planned;

    for (const p of list) {
      if (signal.aborted) break;
      const at = now();

      if (p.refusal) {
        file(p.stage, at, 0, { outcome: p.refusal.outcome, reason: p.refusal.reason }, null);
        continue;
      }

      /* A DEPENDENCY THAT IS NOT SATISFIED. Not checked when one stage is run
         on its own: `only` is the owner asking for this stage now, and
         refusing because the collector has not run today would be the schedule
         overruling a button press. */
      if (!only) {
        const short = p.stage.deps.map((d) => unsatisfied(d, outcomes)).filter((x): x is string => x !== null);
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

      const contextId = `pipeline:${id}:${p.stage.id}`;
      const stageStarted = Date.now();
      const stageMs = p.settled.maxMinutes ? p.settled.maxMinutes * 60_000 : null;
      const deadline = stageMs ? stageStarted + stageMs : Number.POSITIVE_INFINITY;
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
            signal,
            sequence: 0,
            resume: false,
          },
          () =>
            p.stage.run!({
              runId: id,
              stageId: p.stage.id,
              dry,
              signal,
              deadline,
              budget: { maxUsd: p.settled.maxUsd, maxMinutes: p.settled.maxMinutes },
            }),
        );
      } catch (err) {
        result = {
          outcome: "failed",
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        };
      }
      file(p.stage, at, Date.now() - stageStarted, result, dry ? null : costOf(contextId));
    }

    const stages = stageResultRows(id).map(shapeStageResult);
    const summary = summarise({ id, dry, trigger: opts.trigger, counts, usd: usdTotal, stages });
    db.prepare(
      `UPDATE pipeline_runs SET finished_at = ?, planned = ?, completed = ?, skipped = ?, failed = ?,
              over_budget = ?, usd = ?, ms = ?, summary = ? WHERE id = ?`,
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
    return { ran: true, why: null, run: shapeRun(row), stages };
  } finally {
    walking = false;
    /* A night that threw left its row open. Closing it here means the ledger
       never carries a run that started and is apparently still going. */
    db.prepare("UPDATE pipeline_runs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(now(), id);
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
}): string {
  const head = input.dry
    ? `**Planned night** (nothing was run) — ${input.stages.length} stage${input.stages.length === 1 ? "" : "s"} considered.`
    : `**Overnight result** — ${input.counts.completed} completed, ${input.counts.skipped} skipped, ` +
      `${input.counts.failed} failed` +
      (input.counts["over-budget"] ? `, ${input.counts["over-budget"]} over budget` : "") +
      `.`;

  const lines: string[] = [head, ""];

  const ran = input.stages.filter((s) => s.outcome === "completed");
  if (ran.length) {
    lines.push(...ran.map((s) => `- **${s.stageId}** — ${s.note ?? "completed, with nothing to report."}`));
  } else {
    lines.push("- Nothing ran.");
  }

  const bad = input.stages.filter((s) => s.outcome === "failed" || s.outcome === "over-budget");
  if (bad.length) {
    lines.push("");
    lines.push(
      ...bad.map(
        (s) =>
          `- **${s.stageId}** ${s.outcome === "failed" ? "FAILED" : "ran out of budget"} — ${s.error ?? s.reason ?? "no reason recorded"}`,
      ),
    );
  }

  const selfScheduled = input.stages.filter((s) => s.reason?.startsWith("self-scheduled"));
  const decided = input.stages.filter(
    (s) => s.outcome === "skipped" && !s.reason?.startsWith("self-scheduled"),
  );
  if (decided.length) {
    lines.push("");
    lines.push(`Skipped: ${decided.map((s) => `${s.stageId} (${s.reason ?? "no reason"})`).join("; ")}.`);
  }
  if (selfScheduled.length) {
    lines.push("");
    lines.push(
      `${selfScheduled.length} stage${selfScheduled.length === 1 ? " keeps its" : "s keep their"} own timer and ` +
        `${selfScheduled.length === 1 ? "was" : "were"} not started here: ${selfScheduled.map((s) => s.stageId).join(", ")}.`,
    );
  }

  lines.push("");
  lines.push(
    input.usd === null
      ? "Cost is not measured on this box: no price per million tokens is configured, so the night's spend is unknown rather than zero."
      : `Model spend on this night: $${input.usd.toFixed(4)}. It counts calls the stages made themselves; work they QUEUED (sub-agent runs) is billed to those runs.`,
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------------- timer */

let timer: ReturnType<typeof setInterval> | null = null;

export const PIPELINE_SESSION = "pipeline";

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
/**
 * CLOSE ANY NIGHT THE PROCESS DIED IN THE MIDDLE OF.
 *
 * `runNight`'s own `finally` closes the row on a thrown error, and cannot on a
 * KILLED PROCESS — which on this box is a routine event, because `node --watch`
 * restarts the server on every save and the owner's terminal is where it runs.
 * Two rows were left open in testing within a minute of each other for exactly
 * that reason, and an open row reads as "still walking", forever.
 *
 * Called at boot, before the timer is armed, so the ledger never carries a run
 * that started six weeks ago and is apparently still going. The row is closed
 * with a NOTE rather than deleted: a night that was interrupted is a fact about
 * what happened, and the stage results it did manage to file are still true.
 * `runs/manifest.ts`'s `failInterrupted` does the same thing for the run queue.
 */
export function closeInterrupted(): number {
  try {
    const res = db
      .prepare(
        `UPDATE pipeline_runs
            SET finished_at = ?,
                note = COALESCE(note, 'The process stopped while this night was walking — a restart, a crash or a closed lid. Whatever had already finished is recorded; the rest never started.')
          WHERE finished_at IS NULL`,
      )
      .run(now());
    return Number(res.changes);
  } catch {
    return 0;
  }
}

export function startPipeline() {
  if (timer) return;
  const closed = closeInterrupted();
  if (closed) console.log(`[pipeline] closed ${closed} night(s) the process died inside`);
  timer = setInterval(() => {
    void (async () => {
      try {
        const s = settings();
        if (!s.enabled) return;
        const { hour, day } = zoned(s);
        const saved = db.prepare("SELECT value FROM runtime_settings WHERE key='pipeline-last-due'").get() as
          | { value: string }
          | undefined;
        const due = dueDay(day, hour, s.hour, saved?.value ?? null);
        if (!due) return;

        const skip = skipDay();
        if (skip && skip.day === due) {
          /* The watermark is written anyway. "Skip tonight" means tonight does
             not happen, not "tonight happens tomorrow morning as well". */
          db.prepare(
            "INSERT INTO runtime_settings (key,value) VALUES ('pipeline-last-due',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(due);
          console.log(`[pipeline] ${due} skipped by hand${skip.reason ? `: ${skip.reason}` : ""}`);
          return;
        }

        const out = await runNight({ trigger: "schedule" });
        if (out.ran) {
          db.prepare(
            "INSERT INTO runtime_settings (key,value) VALUES ('pipeline-last-due',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(due);
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

  try {
    /* Imported here and not at the top for briefing.ts's stated reason: the
       bridge imports routes/chat.ts, which imports the skill registry, which
       imports every manifest — including this area's. A static import would
       close that loop. */
    const { notify } = await import("../../telegram/bridge.ts");
    const sent = await notify(text.replace(/\*\*/g, ""));
    return { chat, telegram: sent.sent, note: sent.sent ? null : (sent.reason ?? "The Telegram push did not go.") };
  } catch (err) {
    return { chat, telegram: false, note: err instanceof Error ? err.message : "The Telegram push failed." };
  }
}
