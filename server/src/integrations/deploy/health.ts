/**
 * WHAT `GET /api/health` MEANS NOW.
 *
 * IT USED TO BE A LIVENESS PROBE AND IT STILL IS ONE. `cli/restore.ts` fetches
 * it to refuse to overwrite a database the server has open, and the owner gate
 * lets it through with no credential for that reason — so the shape it always
 * had (`ok`, `now`, `collectors`, `collectEveryMinutes`) is kept exactly, and
 * nothing added here may make it fail to answer. A health check that 500s
 * because a disk call threw is a health check that reports the wrong thing at
 * the worst moment.
 *
 * WHAT IT NOW ALSO ANSWERS is the question an unattended install actually
 * asks: not "is the process up" — the TCP connect already proved that — but
 * "is this box doing its job". Five checks, each of which can be `ok`, `warn`
 * or `fail`, and every one of them says WHY in a sentence rather than in a
 * boolean:
 *
 *   database    — the file opens and answers a query, and its quick_check
 *                 passes. This is the check that catches a half-restored
 *                 archive.
 *   migrations  — every migration this build ships has a row in `migrations`.
 *                 A binary newer than its database is the failure mode of a
 *                 service that restarted into a half-applied upgrade.
 *   collectors  — how long ago each connected source last STARTED a run,
 *                 against its own cadence. Silence is the failure that a
 *                 process-liveness probe cannot see: the API answers perfectly
 *                 while nothing has collected since Tuesday.
 *   gateway     — the managed agent, if one is meant to be running. `warn`
 *                 rather than `fail` when none is configured, because a box
 *                 with no agent is a supported box.
 *   disk        — free bytes on the data directory's filesystem. Videos and
 *                 snapshots live there and a full disk is silent until a write
 *                 fails.
 *
 * `WARN` IS NOT `FAIL` AND THE DIFFERENCE IS LOAD-BEARING. `fail` means
 * something a person has to fix now; `warn` means something worth looking at
 * that a monitor should not page for. Nothing here invents a threshold it
 * cannot justify: the disk levels are stated in the payload, the collector
 * lateness multiplier is stated, and both are reported alongside the raw
 * figures so a reader can disagree.
 */
import { existsSync, statfsSync, statSync } from "node:fs";
import { COLLECT_MINUTES, DATA_DIR, DB_FILE } from "../../config.ts";
/* db.ts BEFORE retention.ts, and it matters: the two import each other and
   db.ts registers its own windows at module scope, so retention.ts must not
   be the one that starts the cycle. */
import { allPlugins, db } from "../../db.ts";
import { retentions, type RetentionEntry } from "../../shared/retention.ts";
import { INTEGRATION_MIGRATIONS } from "../migrations.ts";
import { intervalMinutes } from "./cadence.ts";
import { lastStartedAt, schedulerState } from "./scheduler.ts";

export type Verdict = "ok" | "warn" | "fail";

export type Check = {
  key: string;
  status: Verdict;
  /** One sentence a person can act on. Never a bare "unhealthy". */
  detail: string;
  /** Whatever numbers the check actually read, so the sentence can be
   *  checked. Absent when the check could read nothing. */
  measured?: Record<string, unknown>;
};

/** A collector is late when it has not started for this many times its own
 *  cadence. Three is two missed cycles plus the one in progress — enough that
 *  a single slow pass or a laptop lid does not raise it. */
export const LATE_MULTIPLIER = 3;
/** Free space thresholds on the data directory's filesystem, in bytes. */
export const DISK_WARN_BYTES = 5 * 1024 ** 3;
export const DISK_FAIL_BYTES = 1 * 1024 ** 3;

function databaseCheck(): Check {
  try {
    const one = db.prepare("SELECT 1 AS one").get() as { one: number } | undefined;
    if (one?.one !== 1) return { key: "database", status: "fail", detail: "The database answered, but not with what was asked for." };
    const quick = db.prepare("PRAGMA quick_check").get() as Record<string, string> | undefined;
    const verdict = quick ? Object.values(quick)[0] : null;
    const bytes = existsSync(DB_FILE) ? statSync(DB_FILE).size : null;
    if (verdict && verdict !== "ok")
      return { key: "database", status: "fail", detail: `SQLite's quick_check says: ${verdict}.`, measured: { file: DB_FILE, bytes } };
    return {
      key: "database",
      status: "ok",
      detail: `Open at ${DB_FILE} and answering; quick_check passes.`,
      measured: { file: DB_FILE, bytes },
    };
  } catch (err) {
    return {
      key: "database",
      status: "fail",
      detail: `The database could not be read: ${err instanceof Error ? err.message : String(err)}`,
      measured: { file: DB_FILE },
    };
  }
}

function migrationsCheck(): Check {
  try {
    const applied = new Set(
      (db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name),
    );
    /* Only the integration migrations can be enumerated from here — db.ts keeps
       its own list private and importing it would be a cycle. That is enough
       for the failure this check is for: an area's tables missing after a
       service restarted into a newer build. */
    const missing = INTEGRATION_MIGRATIONS.map((m) => m.name).filter((n) => !applied.has(n));
    if (missing.length)
      return {
        key: "migrations",
        status: "fail",
        detail:
          `${missing.length} migration(s) this build ships have never been applied: ${missing.slice(0, 5).join(", ")}` +
          `${missing.length > 5 ? ", …" : ""}. The process is newer than its database.`,
        measured: { applied: applied.size, missing },
      };
    return {
      key: "migrations",
      status: "ok",
      detail: `${applied.size} migrations applied; every one this build ships is among them.`,
      measured: { applied: applied.size, shipped: INTEGRATION_MIGRATIONS.length },
    };
  } catch (err) {
    return { key: "migrations", status: "fail", detail: `The migrations table could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function collectorsCheck(collectorIds: string[]): Check {
  try {
    const connected = new Set(allPlugins().filter((p) => p.connected === 1).map((p) => p.id));
    const watched = collectorIds.filter((id) => connected.has(id));
    if (!watched.length)
      return {
        key: "collectors",
        status: "ok",
        detail: "No connected source has a collector, so there is nothing on the schedule to be late.",
        measured: { connected: 0 },
      };
    const late: { plugin: string; lastStartedAt: string | null; everyMinutes: number | null; lateByMinutes: number | null }[] = [];
    for (const id of watched) {
      const every = COLLECT_MINUTES > 0 ? intervalMinutes(id, COLLECT_MINUTES) : null;
      if (every === null) continue; // deliberately never scheduled
      const last = lastStartedAt(id);
      if (!last) {
        late.push({ plugin: id, lastStartedAt: null, everyMinutes: every, lateByMinutes: null });
        continue;
      }
      const ageM = (Date.now() - Date.parse(last)) / 60_000;
      if (ageM > every * LATE_MULTIPLIER)
        late.push({ plugin: id, lastStartedAt: last, everyMinutes: every, lateByMinutes: Math.round(ageM - every) });
    }
    if (!late.length)
      return {
        key: "collectors",
        status: "ok",
        detail: `${watched.length} connected source(s) have all collected within ${LATE_MULTIPLIER}× their own cadence.`,
        measured: { connected: watched.length, scheduler: schedulerState() },
      };
    /* A source that has NEVER run is a warn rather than a fail: the box may
       have been connected a minute ago and the first tick is up to a cadence
       away. A source that has run and then stopped is the real signal. */
    const neverRan = late.every((l) => l.lastStartedAt === null);
    return {
      key: "collectors",
      status: neverRan ? "warn" : "fail",
      detail:
        `${late.length} connected source(s) have not collected within ${LATE_MULTIPLIER}× their cadence: ` +
        late.map((l) => `${l.plugin} (${l.lastStartedAt ? `${l.lateByMinutes}m late` : "never"})`).join(", ") + ".",
      measured: { connected: watched.length, late, scheduler: schedulerState() },
    };
  } catch (err) {
    return { key: "collectors", status: "warn", detail: `The collection history could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The managed agent. Dynamically imported, and that is not laziness: this
 * module is reached from an integration manifest, and `agents/instance.ts`
 * imports the skills registry, which imports the manifest list. A static
 * import here would close that circle at module-evaluation time.
 */
async function gatewayCheck(): Promise<Check> {
  try {
    const instance = await import("../../agents/instance.ts");
    const running = instance.runningAgent();
    const reports = instance.AGENT_IDS.map((id) => instance.report(id, running));
    const wanted = reports.filter((r) => r.autostart);
    if (!wanted.length)
      return {
        key: "gateway",
        status: "warn",
        detail:
          "No managed agent is set to run. Chat falls through to whichever model provider is the default, which is " +
          "text only — business tools need an agent. This is a supported configuration, not a fault.",
        measured: { agents: reports.map((r) => ({ id: r.id, state: r.state, autostart: r.autostart })) },
      };
    const bad = wanted.filter((r) => r.state !== "running");
    if (bad.length)
      return {
        key: "gateway",
        status: "fail",
        detail: bad
          .map((r) => `${r.label} is set to run but is ${r.state}${r.lastError ? ` — ${r.lastError}` : ""}.`)
          .join(" "),
        measured: { agents: wanted.map((r) => ({ id: r.id, state: r.state, pid: r.pid, restarts: r.restarts, healthyAt: r.healthyAt })) },
      };
    return {
      key: "gateway",
      status: "ok",
      detail: wanted.map((r) => `${r.label} is running on 127.0.0.1:${r.port}${r.healthyAt ? ` and answered at ${r.healthyAt}` : ""}.`).join(" "),
      measured: { agents: wanted.map((r) => ({ id: r.id, state: r.state, pid: r.pid, restarts: r.restarts, healthyAt: r.healthyAt })) },
    };
  } catch (err) {
    return { key: "gateway", status: "warn", detail: `The agent runtime could not be asked: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function diskCheck(dir = DATA_DIR): Check {
  try {
    const s = statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    const measured = { dir, freeBytes: free, totalBytes: total, warnBelowBytes: DISK_WARN_BYTES, failBelowBytes: DISK_FAIL_BYTES };
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (free < DISK_FAIL_BYTES)
      return { key: "disk", status: "fail", detail: `${gb(free)} free on the filesystem holding ${dir}. Videos, snapshots and backups all write there.`, measured };
    if (free < DISK_WARN_BYTES)
      return { key: "disk", status: "warn", detail: `${gb(free)} free on the filesystem holding ${dir}.`, measured };
    return { key: "disk", status: "ok", detail: `${gb(free)} free of ${gb(total)} on the filesystem holding ${dir}.`, measured };
  } catch (err) {
    return { key: "disk", status: "warn", detail: `Free space could not be read: ${err instanceof Error ? err.message : String(err)}`, measured: { dir } };
  }
}

export type Health = {
  /** UNCHANGED FROM THE ORIGINAL ROUTE. `cli/restore.ts` only looks at the
   *  status code, but anything else written against this before today read
   *  these four, and they still mean what they meant. */
  ok: boolean;
  now: string;
  collectors: string[];
  collectEveryMinutes: number;
  /** The worst verdict among the checks. */
  status: Verdict;
  checks: Check[];
  /**
   * HOW LONG HISTORY IS KEPT, TABLE BY TABLE, VERBATIM FROM THE REGISTRY.
   *
   * This used to be `retainDays: { readings, load }` read straight out of
   * config, and it was a claim about the box that was not true of the box. It
   * described neither the uptime checks, the fleet samples, the workstation
   * states nor the job leases — each of which aged on a number no setting
   * could reach — and it certainly did not describe `security_snapshots`,
   * `security_shotsqa` and `backup_runs`, which at the time nothing anywhere
   * pruned. A health endpoint naming a retention window it does not govern is
   * worse than one naming none, because somebody plans around it.
   *
   * It is now the same list the sweep walks, so the two cannot disagree, and a
   * table that is ABSENT from it is a table nothing prunes — which is a
   * visible fact rather than an absence.
   */
  retention: RetentionEntry[];
  note: string;
};

/**
 * NEVER THROWS, and never answers anything but 200. `ok` stays true whenever
 * the process is answering, because that is what the field has always meant
 * and `cli/restore.ts` reads the STATUS CODE to decide whether a database is
 * in use. The verdict is `status`, which is a new field and can be read
 * without changing what an old caller believes.
 */
export async function health(collectorIds: string[]): Promise<Health> {
  const checks: Check[] = [];
  try {
    checks.push(databaseCheck(), migrationsCheck(), collectorsCheck(collectorIds));
  } catch (err) {
    checks.push({ key: "database", status: "fail", detail: `Health checks threw: ${err instanceof Error ? err.message : String(err)}` });
  }
  checks.push(await gatewayCheck());
  checks.push(diskCheck());

  const worst: Verdict = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

  return {
    ok: true,
    now: new Date().toISOString(),
    collectors: collectorIds,
    collectEveryMinutes: COLLECT_MINUTES,
    status: worst,
    checks,
    retention: retentions(),
    note:
      "`ok` means this process answered, and nothing else — it is the liveness probe cli/restore.ts uses to refuse " +
      "to overwrite a live database, so it stays true even when a check fails. `status` is the verdict over the " +
      "checks: fail is something to fix now, warn is something to look at. Every threshold used is in the check's " +
      "own `measured` object rather than only in the sentence. `retention` is the registry the prune itself walks, " +
      "one row per table — not a setting that describes some of them; a table missing from it is a table nothing " +
      "ages out.",
  };
}

/**
 * WHAT AN UNAUTHENTICATED CALLER GETS, WHICH IS ALMOST NOTHING.
 *
 * `GET /api/health` is on the gate's OPEN list — it answers with no credential
 * even once a password is set, because `cli/restore.ts` uses it to refuse to
 * overwrite a live database and a probe that could not tell "running" from
 * "locked" would be the dangerous version of that tool. That was fine when the
 * document was four fields. It is not fine now that the checks carry absolute
 * paths, the database's size, free and total disk, the names of missing
 * migrations and the agent's verbatim last error: four harmless fields became
 * a description of the machine, served to anything that can reach the port.
 *
 * So the DETAIL is behind the lock and the LIVENESS is not. With no password
 * set nothing changes — there is no lock to be behind, and the dashboard, the
 * doctor and curl all see everything. Once a password exists, an
 * unauthenticated caller gets the four original fields minus the collector
 * NAMES (which say which businesses this box is connected to) and a `status`
 * of `null` meaning "not told", which is this codebase's word for it
 * everywhere else.
 */
export type MinimalHealth = {
  ok: true;
  now: string;
  status: null;
  note: string;
};

export async function healthFor(
  collectorIds: string[],
  opts: { authenticated: boolean; locked: boolean },
): Promise<Health | MinimalHealth> {
  if (opts.locked && !opts.authenticated)
    return {
      ok: true,
      now: new Date().toISOString(),
      status: null,
      note:
        "This dashboard has a password on it, so this probe answers liveness only. `ok: true` means the process " +
        "replied and nothing more; `status: null` means the checks were not run for you rather than that they " +
        "passed. Sign in, or send a service key, for the checks, the collector list and the disk figures.",
    };
  return health(collectorIds);
}
