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
 * only when ITS OWN interval has elapsed — see cadence.ts. A box that has
 * touched none of the settings behaves identically: every connected plugin
 * still comes round every `OPC_COLLECT_MINUTES`, in the same order, one at a
 * time. The minute tick costs one pass over a handful of rows and a Date.parse
 * per plugin; it does no I/O when nothing is due.
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
import { intervalMinutes, isCustom } from "./cadence.ts";
import { prune as pruneLeases } from "./leases.ts";

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
      const r = await collector();
      ran.push(id);
      console.log(`[collect] ${id} ${r.ok ? "ok" : "failed"}${r.error ? ` — ${r.error}` : ""}`);
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
      const pruned = pruneDb(retain.readings, retain.load);
      const leases = pruneLeases();
      if (pruned.readings || pruned.runs || pruned.load || leases)
        console.log(
          `[prune] ${pruned.readings} readings, ${pruned.runs} runs, ` +
            `${pruned.load} load samples${leases ? `, ${leases} finished leases` : ""}`,
        );
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
    void tick(collectors, defaultMinutes, retain);
  }, TICK_MS).unref();
  return true;
}

export function schedulerState(): { running: boolean; lastTickAt: string | null; inFlight: boolean } {
  return { running: started, lastTickAt, inFlight };
}
