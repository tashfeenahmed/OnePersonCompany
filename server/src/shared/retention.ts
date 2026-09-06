/**
 * HOW LONG HISTORY IS KEPT — a registry, rather than one setting and a rumour.
 *
 * There was one global setting, `OPC_RETAIN_DAYS`, applied by the central
 * prune to about a dozen tables; four more windows hardcoded in four areas
 * that no setting could reach; and — because there was no single place that
 * listed them — three tables with no prune anywhere at all: whole JSON
 * documents, one per security incident, plus a QA table and a backup log,
 * growing for the life of the box.
 *
 * WORSE THAN THE SIZE WAS THE CLAIM. `/api/health` reported `retainDays` out
 * of config, which reads as a description of the box and is not one: it did
 * not describe the uptime checks, the fleet samples, the workstation states or
 * the job leases, all of which age on their own numbers, and it certainly did
 * not describe the three tables that never aged at all. A health endpoint that
 * names a retention window it does not govern is worse than one that names
 * none, because somebody will plan around it.
 *
 * SO: EVERY WINDOW IS REGISTERED, AND THE HEALTH ENDPOINT REPORTS THE REGISTRY
 * VERBATIM. A table with no entry here is a table nothing prunes, and that is
 * now a visible fact rather than an absence. `source` says where the number
 * came from — a setting the owner can change, or a decision an area made —
 * because "400 days because you set it" and "30 days because the fleet
 * collector decided" are different answers to "can I keep more".
 *
 * REGISTRATION IS A SIDE EFFECT OF IMPORTING THE AREA THAT OWNS THE TABLE,
 * which is deliberate. The alternative is one list in one file naming thirty
 * tables it knows nothing about — which is how the windows drifted from the
 * code that wrote the rows in the first place. An area registers what it
 * writes, next to the constant it already had.
 *
 * NOTHING HERE DELETES A ROW THE OWNER TYPED. Every table registered is a
 * table of MEASUREMENTS — samples, checks, snapshots, day rollups — and the
 * ledgers the owner corrects by hand are deliberately absent. That rule is not
 * enforceable from this file; it is the reviewer's, and it is written here
 * because this is where somebody adding a table will read it.
 */
import { db } from "../db.ts";

/** Where a window's number comes from. */
export type RetentionSource =
  /** A setting the owner can change, named in `setting`. */
  | "setting"
  /** A number the owning area chose, for a reason in `note`. */
  | "area";

/** How the column that carries the age is written. */
export type RetentionGrain =
  /** A full ISO instant, e.g. `2026-09-06T11:04:00.000Z`. */
  | "instant"
  /** A calendar day, `YYYY-MM-DD`. The cutoff is sliced to match, because a
   *  day key compared against an instant is a string comparison that keeps one
   *  extra day at every boundary. */
  | "day";

export type Retention = {
  table: string;
  /** The column the cutoff is compared against. */
  column: string;
  /** The window, in days. A function when it follows a setting that can change
   *  while the process is running, so `/api/health` cannot report a number the
   *  prune is no longer using. */
  days: number | (() => number);
  source: RetentionSource;
  /** The setting's name, when `source` is "setting". `OPC_RETAIN_DAYS`. */
  setting?: string;
  grain?: RetentionGrain;
  /** An extra predicate ANDed onto the cutoff. `job_leases` only prunes rows
   *  that have been RELEASED — an open lease is not history, it is a claim. */
  where?: string;
  /** Why this window and not another, in a sentence. Shown wherever the
   *  registry is. */
  note?: string;
};

/** What a caller reads: the window resolved to a number it can print. */
export type RetentionEntry = Omit<Retention, "days"> & { days: number };

const REGISTRY = new Map<string, Retention>();

/**
 * Declare how long one table's rows are kept.
 *
 * KEYED ON THE TABLE, and re-registering replaces. Two areas claiming one
 * table would otherwise prune it twice on two windows, and the shorter would
 * silently win; last-registration-wins at least makes it one answer, and the
 * duplicate is visible in the registry listing.
 */
export function registerRetention(entry: Retention): void {
  identifier(entry.table);
  identifier(entry.column);
  REGISTRY.set(entry.table, entry);
}

/** Every registered window, resolved, sorted by table. This is what
 *  `/api/health` reports and what `prune()` walks — the same list, so the two
 *  cannot disagree. */
export function retentions(): RetentionEntry[] {
  return [...REGISTRY.values()]
    .map((r) => ({ ...r, days: typeof r.days === "function" ? r.days() : r.days }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** One table's entry, or undefined when nothing prunes it. */
export function retentionFor(table: string): RetentionEntry | undefined {
  return retentions().find((r) => r.table === table);
}

export type PruneOutcome = {
  table: string;
  days: number;
  deleted: number;
  /** Set when the delete could not be run at all — a table a migration has not
   *  created yet, most often. Never a reason to stop the sweep. */
  error: string | null;
};

/**
 * Delete everything past its window, table by table.
 *
 * ONE TABLE'S FAILURE IS NOT THE SWEEP'S. A prune runs on a schedule with
 * nobody watching, and an area whose migration has not run yet must not stop
 * the other twenty-nine tables from being trimmed. The failure is reported
 * rather than swallowed, so the caller can log it.
 */
export function pruneAll(): PruneOutcome[] {
  const out: PruneOutcome[] = [];
  for (const entry of retentions()) {
    try {
      out.push({ table: entry.table, days: entry.days, deleted: pruneOne(entry), error: null });
    } catch (err) {
      out.push({
        table: entry.table,
        days: entry.days,
        deleted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** One table, past its own window. Exported for the areas that prune on their
 *  own collection rather than waiting for the sweep. */
export function pruneOne(entry: RetentionEntry): number {
  const cutoff = new Date(Date.now() - entry.days * 86_400_000).toISOString();
  const value = entry.grain === "day" ? cutoff.slice(0, 10) : cutoff;
  const where = `${identifier(entry.column)} < ?${entry.where ? ` AND ${entry.where}` : ""}`;
  const res = db.prepare(`DELETE FROM ${identifier(entry.table)} WHERE ${where}`).run(value);
  return Number(res.changes ?? 0);
}

/** Only for tests, which need a registry that does not carry whatever the
 *  imported areas happened to register. */
export function clearRetentions(): void {
  REGISTRY.clear();
}

/** Table and column names cannot be bound as parameters, so they are spliced
 *  into the statement — safe only because they are checked here and because
 *  every caller passes a literal. `where` is a caller literal too, for the
 *  reason settle.ts gives: a predicate cannot be parameterised. */
function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`“${name}” is not a plain table or column name.`);
  return name;
}
