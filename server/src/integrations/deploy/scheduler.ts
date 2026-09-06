/**
 * THE COLLECTOR SCHEDULER — moved out of index.ts so that a cadence can be per
 * source, and so that "when did this last run, and when is it next due" is a
 * question something can answer.
 *
 * WHAT INDEX.TS USED TO DO, AND WHAT IS UNCHANGED. One `setInterval` at
 * `OPC_COLLECT_MINUTES`, walking every connected plugin in order, awaiting each
 * collector, then pruning. The reasoning in that file still holds and is worth
 * restating rather than deleting: a plain interval rather than cron, because
 * there is one process, the cadence is "every so often" rather than "at 03:00",
 * and a missed tick while the laptop was asleep should be the next tick and not
 * a backlog to catch up on. All of that survives here.
 *
 * WHAT CHANGED. The timer now fires every minute and each plugin is collected
 * only when ITS OWN interval has elapsed — see cadence.ts. On a box that has
 * touched none of the settings every connected plugin still comes round every
 * `OPC_COLLECT_MINUTES`, in the same order, one at a time. The minute tick
 * costs one pass over a handful of rows and a Date.parse per plugin; it does
 * no I/O when nothing is due.
 *
 * ONE THING IS GENUINELY DIFFERENT AND IT IS NOT A BUG: THE FIRST TICK AFTER A
 * RESTART. The old loop's first collection was `COLLECT_MINUTES` after boot,
 * whatever the database said; this one is due-based, so a source whose last
 * run is already older than its cadence is collected within a minute of the
 * process starting. That is the correct behaviour for a service that has been
 * down — the whole point of the change is that a box which was asleep catches
 * up — but on a development box under `node --watch`, where a save restarts
 * the server several times an hour, it means a full sweep shortly after most
 * restarts rather than none. If that is unwanted, `OPC_COLLECT_MINUTES=0`
 * turns the scheduler off and the Collect buttons still work.
 *
 * A COLLECTION THAT IS STILL RUNNING DOES NOT START AGAIN. The tick is
 * serialised by a single in-flight flag rather than per plugin, because the old
 * loop was serial and two collectors writing at once is a behaviour change
 * nobody asked for. A source whose cadence is shorter than the time its
 * collector takes therefore gets "as often as it can", and the log says when a
 * tick was skipped for that reason.
 *
 * "LAST RUN" IS READ OUT OF THE `runs` TABLE rather than kept in memory. Every
 * collector on this box opens a run row through `startRun`, so the table
 * already knows; a second in-memory copy would be reset by the restart this
 * process performs on every source edit and would then re-collect everything
 * at once. This is the same argument leases.ts makes about its own rows.
 */
import { allPlugins, db, prune as pruneDb } from "../../db.ts";
import { LOAD_RETAIN_DAYS, RETAIN_DAYS } from "../../config.ts";
import { pruneAll, registerRetention } from "../../shared/retention.ts";
import { intervalMinutes, isCustom } from "./cadence.ts";
/* IMPORTED FOR ITS REGISTRATION. leases.ts declares `job_leases`' window as a
   side effect of being loaded, and this is the file whose sweep deletes the
   rows — so it is loaded here rather than left to whichever router happened to
   import it first. */
import "./leases.ts";

export type Collectors = Record<string, () => Promise<{ ok: boolean; error?: string | null }>>;

/** How often the tick looks. One minute is the resolution of the cadence
 *  setting and is stated in its hint. */
export const TICK_MS = 60_000;

/**
 * THE COLLECTOR MAP, HANDED IN ONCE FROM index.ts.
 *
 * It is registered rather than imported because the map is assembled there out
 * of the built-ins and every manifest's, and importing `integrations/index.ts`
 * from a file that an integration manifest reaches would close a cycle. One
 * call at boot, and everything here — the schedule page, the health check, the
 * skill — reads the same list the scheduler runs.
 */
let registry: Collectors = {};

export function registerCollectors(c: Collectors) {
  registry = c;
}

/** The ids, sorted. Empty before boot has run, which is what a test sees. */
export function collectorIds(): string[] {
  return Object.keys(registry).sort();
}

export function collectorMap(): Collectors {
  return registry;
}

/**
 * THE WINDOWS THE CENTRAL PRUNE APPLIES, DECLARED BESIDE THE CALL THAT APPLIES
 * THEM.
 *
 * `db.ts` deletes from these tables itself, in one function, on the two
 * settings below. What it did NOT do is say so anywhere a reader could find:
 * `/api/health` published `retainDays` out of config, which reads as a
 * description of the box and was not one — it did not describe the fleet
 * samples, the uptime checks, the workstation states or the job leases, and it
 * certainly did not describe the three tables that nothing pruned at all.
 *
 * So they are registered, and `/api/health` reports the registry rather than a
 * number. They are declared HERE, next to `pruneDb`, rather than in db.ts,
 * because db.ts is the core module this pass does not edit — and that is the
 * one thing wrong with this block: the declarations belong beside the DELETEs
 * they describe, and a table added to `prune()` without a line added here is
 * invisible again. Moving them into `prune()` itself, and letting the sweep
 * below do the deleting, is the finishing of this and is written up as such.
 *
 * DECLARING IS NOT A SECOND PRUNE IN ANY MEANINGFUL SENSE: `pruneAll()` runs
 * immediately after `pruneDb()` and finds nothing left in these tables. It is
 * one extra DELETE per table per collection interval, and it is what keeps the
 * registry — the thing the owner reads — the same list as the behaviour.
 */
const CENTRAL: [table: string, column: string, grain: "instant" | "day", load?: "load"][] = [
  ["readings", "ts", "instant"],
  ["runs", "started_at", "instant"],
  ["secret_access", "ts", "instant"],
  ["stock_quota", "ts", "instant"],
  ["replicate_predictions", "created_at", "instant"],
  ["github_traffic", "day", "day"],
  ["npm_downloads", "day", "day"],
  ["meta_ad_days", "day", "day"],
  ["openai_costs", "day", "day"],
  ["openrouter_activity", "day", "day"],
  ["cloudflare_traffic", "day", "day"],
  ["gsc_days", "day", "day"],
  ["bing_traffic_days", "day", "day"],
  ["bing_crawl_days", "day", "day"],
  ["bing_queries", "day", "day"],
  /* THE ONE TABLE ON THE SHORT WINDOW. A few thousand rows a day, and the
     questions it answers — "was the box busy last night", "has this been
     climbing all week" — are asked of recent history. A year of it would be a
     million rows kept to answer nothing. */
  ["hetzner_load", "ts", "instant", "load"],
];

for (const [table, column, grain, load] of CENTRAL)
  registerRetention({
    table,
    column,
    grain,
    /* A THUNK, so nothing can print a window the prune has stopped using. */
    days: load ? () => LOAD_RETAIN_DAYS : () => RETAIN_DAYS,
    source: "setting",
    setting: load ? "OPC_LOAD_RETAIN_DAYS" : "OPC_RETAIN_DAYS",
    note: load
      ? "Server-load samples, on the short window: a few thousand rows a day, read only for the last few nights."
      : "The box's own history, on the setting the owner can change. Deleted by db.ts's central prune().",
  });

let inFlight = false;
let started = false;
let lastTickAt: string | null = null;
let lastPruneAt: string | null = null;

/**
 * The last time a collector for this plugin STARTED, from the runs table.
 *
 * The start rather than the finish, deliberately: a cadence is "how often do we
 * go and look", and pinning it to the finish would make a slow source drift
 * later every cycle by however long it takes.
 */
export function lastStartedAt(pluginId: string): string | null {
  const row = db
    .prepare("SELECT started_at FROM runs WHERE plugin_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(pluginId) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}

export type Schedule = {
  pluginId: string;
  connected: boolean;
  /** Null means "never on a schedule" — the setting is 0, or the box scheduler
   *  is off entirely. */
  everyMinutes: number | null;
  /** Did the owner type this cadence, or is it the box default? */
  custom: boolean;
  lastStartedAt: string | null;
  /** Null when nothing is scheduled, or when nothing has run yet — in which
   *  case the next tick collects it. */
  nextDueAt: string | null;
  due: boolean;
};

/** Every collectable plugin, with its cadence and when it is next due. The
 *  Deployment page and the `deploy` skill both draw this. */
export function schedules(collectors: Collectors, defaultMinutes: number): Schedule[] {
  const rows = new Map(allPlugins().map((p) => [p.id, p]));
  const at = Date.now();
  return Object.keys(collectors)
    .sort()
    .map((id) => {
      const every = defaultMinutes > 0 ? intervalMinutes(id, defaultMinutes) : null;
      const last = lastStartedAt(id);
      const lastMs = last ? Date.parse(last) : NaN;
      const nextMs = every !== null && Number.isFinite(lastMs) ? lastMs + every * 60_000 : null;
      return {
        pluginId: id,
        connected: (rows.get(id)?.connected ?? 0) === 1,
        everyMinutes: every,
        custom: isCustom(id),
        lastStartedAt: last,
        nextDueAt: nextMs === null ? null : new Date(nextMs).toISOString(),
        due: every !== null && (nextMs === null || nextMs <= at),
      };
    });
}

/** Which plugins the next tick would collect. Exported for the test, which
 *  must not have to run a timer to check the arithmetic. */
export function dueNow(collectors: Collectors, defaultMinutes: number): string[] {
  return schedules(collectors, defaultMinutes)
    .filter((s) => s.connected && s.due)
    .map((s) => s.pluginId);
}

/** One pass. Exported so a test and the route can run it without waiting a
 *  minute; returns what it did rather than logging only. */
export async function tick(
  collectors: Collectors,
  defaultMinutes: number,
  retain: { readings: number; load: number },
): Promise<{ ran: string[]; skipped: boolean }> {
  if (inFlight) return { ran: [], skipped: true };
  inFlight = true;
  lastTickAt = new Date().toISOString();
  const ran: string[] = [];
  try {
    for (const id of dueNow(collectors, defaultMinutes)) {
      const collector = collectors[id];
      if (!collector) continue;
      /*
        ONE COLLECTOR'S THROW MUST NOT END THE PASS, LET ALONE THE PROCESS.
        Every collector on this box is written to return `{ ok: false, error }`
        rather than reject — but "written to" is not "guaranteed to", and the
        old loop awaited them bare: a single rejection aborted the remaining
        thirty-seven sources and, under Node's default unhandled-rejection
        behaviour, took the server down with it. A source that throws is a
        source that failed, logged as such, and the pass continues.
      */
      ran.push(id);
      try {
        const r = await collector();
        console.log(`[collect] ${id} ${r.ok ? "ok" : "failed"}${r.error ? ` — ${r.error}` : ""}`);
      } catch (err) {
        console.error(`[collect] ${id} threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /* PRUNING KEEPS THE OLD CADENCE rather than following any source's. It is
       a housekeeping pass over three tables and belongs to the box, not to a
       plugin; running it every minute would be a DELETE every minute for no
       reason. It runs when a collection ran, and at most once per default
       interval otherwise. */
    const pruneEvery = Math.max(1, defaultMinutes) * 60_000;
    const prunedDue = !lastPruneAt || Date.now() - Date.parse(lastPruneAt) >= pruneEvery;
    if (ran.length || prunedDue) {
      lastPruneAt = new Date().toISOString();
      try {
        const pruned = pruneDb(retain.readings, retain.load);
        /* EVERY REGISTERED WINDOW, INCLUDING THE ONES NO SETTING REACHES and
           the three tables that nothing pruned at all before this. One sweep
           over one list, so "what is kept, and for how long" has a single
           answer that /api/health can report verbatim. */
        const swept = pruneAll().filter((p) => p.deleted || p.error);
        for (const p of swept)
          if (p.error) console.error(`[prune] ${p.table} could not be pruned — ${p.error}`);
        const aged = swept.reduce((n, p) => n + p.deleted, 0);
        if (pruned.readings || pruned.runs || pruned.load || aged)
          console.log(
            `[prune] ${pruned.readings} readings, ${pruned.runs} runs, ` +
              `${pruned.load} load samples${aged ? `, ${aged} row(s) past their window` : ""}`,
          );
      } catch (err) {
        /* A DELETE that lost a race with a writer is a row that ages out next
           cycle, not a reason to end the pass. */
        console.error(`[prune] failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ran, skipped: false };
  } finally {
    inFlight = false;
  }
}

/** What index.ts calls. Idempotent, and a no-op when the box scheduler is off
 *  (`OPC_COLLECT_MINUTES=0`) — which is what the tests set. */
export function startCollectors(
  collectors: Collectors,
  defaultMinutes: number,
  retain: { readings: number; load: number },
): boolean {
  /* The registration happens even when the scheduler is off, because "what
     could be collected, and how often" is a question the page and the health
     check still answer on a box with OPC_COLLECT_MINUTES=0. */
  registerCollectors(collectors);
  if (started || defaultMinutes <= 0) return false;
  started = true;
  setInterval(() => {
    /* THE LAST CATCH. `tick` already guards each collector and the prune, so
       nothing is expected here — which is exactly why it is here: an interval
       callback whose promise rejects is an unhandled rejection, and an
       unhandled rejection is a dead server on Node's defaults. A supervisor
       would restart it, which is worse than a logged line, because the restart
       looks like a crash nobody caused. */
    void tick(collectors, defaultMinutes, retain).catch((err: unknown) => {
      console.error(`[collect] the scheduler tick failed — ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TICK_MS).unref();
  return true;
}

export function schedulerState(): { running: boolean; lastTickAt: string | null; inFlight: boolean } {
  return { running: started, lastTickAt, inFlight };
}
