/**
 * THE TABLES, READ AND WRITTEN — and nothing that decides anything.
 *
 * Every function here is a query or an upsert. The arithmetic that turns rows
 * into a card lives in routes.ts and is computed on the read, for the reason
 * /api/mobile computes its totals on the read: a stored "42% conversion in
 * August" is wrong the next morning and badly wrong after a week of failed
 * collections, which is the week somebody actually looks.
 *
 * WRITES ARE UPSERTS KEYED ON THE MEASUREMENT, never inserts. Google rewrites
 * the running month's CSV every day and Apple revises a fresh analytics
 * instance, so a re-ingest must CORRECT a day rather than duplicate it. That
 * is why every primary key here contains the day.
 */
import { db } from "../../db.ts";

const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------- dimensions */

export type DimensionWrite = {
  store: string;
  accountId: number;
  app: string;
  day: string;
  dimension: string;
  value: string;
  metric: string;
  amount: number;
  unit: string;
  report: string;
};

export function writeDimensions(rows: DimensionWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_dimensions
       (store, account_id, app, day, dimension, value, metric, amount, unit, report, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(
      r.store,
      r.accountId,
      r.app,
      r.day,
      r.dimension,
      r.value,
      r.metric,
      r.amount,
      r.unit,
      r.report,
      ts,
    );
  return rows.length;
}

export type DimensionRowOut = {
  store: string;
  app: string;
  day: string;
  dimension: string;
  value: string;
  metric: string;
  amount: number;
  unit: string;
};

export function dimensions(opts: {
  since: string;
  store?: string;
  app?: string;
  dimension?: string;
}): DimensionRowOut[] {
  const where = ["day >= ?"];
  const args: (string | number)[] = [opts.since];
  if (opts.store) (where.push("store = ?"), args.push(opts.store));
  if (opts.app) (where.push("app = ?"), args.push(opts.app));
  if (opts.dimension) (where.push("dimension = ?"), args.push(opts.dimension));
  return db
    .prepare(
      `SELECT store, app, day, dimension, value, metric, amount, unit
         FROM mobile_dimensions WHERE ${where.join(" AND ")} ORDER BY day`,
    )
    .all(...args) as unknown as DimensionRowOut[];
}

/** Which (store, app, dimension) pairs exist at all, so a route can say what
 *  the bucket carries rather than probing one dimension at a time. */
export function dimensionIndex(): { store: string; app: string; dimension: string; days: number }[] {
  return db
    .prepare(
      `SELECT store, app, dimension, COUNT(DISTINCT day) AS days
         FROM mobile_dimensions GROUP BY store, app, dimension ORDER BY store, app, dimension`,
    )
    .all() as unknown as { store: string; app: string; dimension: string; days: number }[];
}

/* -------------------------------------------------- store performance */

export type PerformanceWrite = {
  accountId: number;
  app: string;
  day: string;
  dimension: string;
  value: string;
  visitors: number | null;
  acquisitions: number | null;
  rate: number | null;
  report: string;
};

export function writePerformance(rows: PerformanceWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_store_performance
       (account_id, app, day, dimension, value, visitors, acquisitions, rate, report, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(
      r.accountId,
      r.app,
      r.day,
      r.dimension,
      r.value,
      r.visitors,
      r.acquisitions,
      r.rate,
      r.report,
      ts,
    );
  return rows.length;
}

export type PerformanceRowOut = {
  app: string;
  day: string;
  dimension: string;
  value: string;
  visitors: number | null;
  acquisitions: number | null;
  rate: number | null;
};

export function performance(since: string, app?: string): PerformanceRowOut[] {
  const where = ["day >= ?"];
  const args: (string | number)[] = [since];
  if (app) (where.push("app = ?"), args.push(app));
  return db
    .prepare(
      `SELECT app, day, dimension, value, visitors, acquisitions, rate
         FROM mobile_store_performance WHERE ${where.join(" AND ")} ORDER BY day`,
    )
    .all(...args) as unknown as PerformanceRowOut[];
}

/* -------------------------------------------------------------- retention */

export type RetentionWrite = {
  accountId: number;
  app: string;
  day: string;
  offsetDays: number;
  retained: number | null;
  installers: number | null;
  report: string;
};

export function writeRetention(rows: RetentionWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_retention
       (account_id, app, day, offset_days, retained, installers, report, seen_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(r.accountId, r.app, r.day, r.offsetDays, r.retained, r.installers, r.report, ts);
  return rows.length;
}

export function retention(since: string, app?: string) {
  const where = ["day >= ?"];
  const args: (string | number)[] = [since];
  if (app) (where.push("app = ?"), args.push(app));
  return db
    .prepare(
      `SELECT app, day, offset_days AS offsetDays, retained, installers
         FROM mobile_retention WHERE ${where.join(" AND ")} ORDER BY day, offset_days`,
    )
    .all(...args) as unknown as {
    app: string;
    day: string;
    offsetDays: number;
    retained: number | null;
    installers: number | null;
  }[];
}

/* ------------------------------------------------------- report readiness */

export type ReportState =
  | "present"
  | "absent"
  | "empty"
  | "requested"
  | "processing"
  | "available"
  | "delayed"
  | "unauthorized"
  | "error";

export function writeReportState(v: {
  store: string;
  accountId: number;
  app: string;
  report: string;
  state: ReportState;
  detail?: string | null;
  rows?: number | null;
  period?: string | null;
}) {
  db.prepare(
    `INSERT OR REPLACE INTO mobile_report_state
       (store, account_id, app, report, state, detail, rows, period, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    v.store,
    v.accountId,
    v.app,
    v.report,
    v.state,
    v.detail ?? null,
    v.rows ?? null,
    v.period ?? null,
    now(),
  );
}

export type ReportStateRow = {
  store: string;
  account_id: number;
  app: string;
  report: string;
  state: ReportState;
  detail: string | null;
  rows: number | null;
  period: string | null;
  checked_at: string;
};

export function reportStates(store?: string): ReportStateRow[] {
  return (
    store
      ? db.prepare("SELECT * FROM mobile_report_state WHERE store = ? ORDER BY app, report").all(store)
      : db.prepare("SELECT * FROM mobile_report_state ORDER BY store, app, report").all()
  ) as unknown as ReportStateRow[];
}

export function writeProbe(v: {
  store: string;
  accountId: number;
  probe: string;
  ok: boolean;
  status?: number | null;
  error?: string | null;
}) {
  db.prepare(
    `INSERT OR REPLACE INTO mobile_health_probes
       (store, account_id, probe, ok, status, error, checked_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(v.store, v.accountId, v.probe, v.ok ? 1 : 0, v.status ?? null, v.error ?? null, now());
}

export type ProbeRow = {
  store: string;
  account_id: number;
  probe: string;
  ok: number;
  status: number | null;
  error: string | null;
  checked_at: string;
};

export function probes(): ProbeRow[] {
  return db
    .prepare("SELECT * FROM mobile_health_probes ORDER BY store, account_id, probe")
    .all() as unknown as ProbeRow[];
}

/* -------------------------------------------------------------- stability */

export type StabilityWrite = {
  store: string;
  accountId: number;
  app: string;
  day: string;
  source: string;
  metric: string;
  dimension: string;
  value: string;
  amount: number | null;
  unit: string;
};

export function writeStability(rows: StabilityWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_stability
       (store, account_id, app, day, source, metric, dimension, value, amount, unit, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(
      r.store,
      r.accountId,
      r.app,
      r.day,
      r.source,
      r.metric,
      r.dimension,
      r.value,
      r.amount,
      r.unit,
      ts,
    );
  return rows.length;
}

export type StabilityRowOut = {
  store: string;
  app: string;
  day: string;
  source: string;
  metric: string;
  dimension: string;
  value: string;
  amount: number | null;
  unit: string;
};

export function stability(opts: { since: string; store?: string; app?: string }): StabilityRowOut[] {
  const where = ["day >= ?"];
  const args: (string | number)[] = [opts.since];
  if (opts.store) (where.push("store = ?"), args.push(opts.store));
  if (opts.app) (where.push("app = ?"), args.push(opts.app));
  return db
    .prepare(
      `SELECT store, app, day, source, metric, dimension, value, amount, unit
         FROM mobile_stability WHERE ${where.join(" AND ")} ORDER BY day`,
    )
    .all(...args) as unknown as StabilityRowOut[];
}

/* ---------------------------------------------------------------- reviews */

export type ReviewWrite = {
  store: string;
  accountId: number;
  app: string;
  id: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  author: string | null;
  language: string | null;
  territory: string | null;
  appVersion: string | null;
  device: string | null;
  created: string | null;
  updated: string | null;
  reply: string | null;
  repliedAt: string | null;
};

/**
 * Reviews, upserted.
 *
 * `first_seen` IS PRESERVED ACROSS RE-INGESTS and `seen_at` is not. An edited
 * review comes back with new text and the same id, and "when did this box
 * first catch it" is the only honest basis for "reviews this week" on the
 * Android side — where the API's window is seven days and the table is an
 * accumulator. COALESCE on the existing row is what keeps it.
 */
export function writeReviews(rows: ReviewWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO mobile_reviews
       (store, account_id, app, id, rating, title, body, author, language, territory,
        app_version, device, created, updated, reply, replied_at, first_seen, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(store, app, id) DO UPDATE SET
       account_id = excluded.account_id,
       rating = excluded.rating,
       title = excluded.title,
       body = excluded.body,
       author = excluded.author,
       language = excluded.language,
       territory = excluded.territory,
       app_version = excluded.app_version,
       device = excluded.device,
       created = COALESCE(mobile_reviews.created, excluded.created),
       updated = excluded.updated,
       reply = excluded.reply,
       replied_at = excluded.replied_at,
       seen_at = excluded.seen_at`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(
      r.store,
      r.accountId,
      r.app,
      r.id,
      r.rating,
      r.title,
      r.body,
      r.author,
      r.language,
      r.territory,
      r.appVersion,
      r.device,
      r.created,
      r.updated,
      r.reply,
      r.repliedAt,
      ts,
      ts,
    );
  return rows.length;
}

export type ReviewRowOut = {
  store: string;
  app: string;
  id: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  author: string | null;
  language: string | null;
  territory: string | null;
  app_version: string | null;
  device: string | null;
  created: string | null;
  updated: string | null;
  reply: string | null;
  first_seen: string;
};

export function reviews(opts: {
  store?: string;
  app?: string;
  minRating?: number;
  maxRating?: number;
  since?: string;
  limit: number;
}): ReviewRowOut[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.store) (where.push("store = ?"), args.push(opts.store));
  if (opts.app) (where.push("app = ?"), args.push(opts.app));
  if (opts.minRating !== undefined) (where.push("rating >= ?"), args.push(opts.minRating));
  if (opts.maxRating !== undefined) (where.push("rating <= ?"), args.push(opts.maxRating));
  if (opts.since) (where.push("COALESCE(created, first_seen) >= ?"), args.push(opts.since));
  args.push(opts.limit);
  return db
    .prepare(
      `SELECT store, app, id, rating, title, body, author, language, territory,
              app_version, device, created, updated, reply, first_seen
         FROM mobile_reviews
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(created, first_seen) DESC LIMIT ?`,
    )
    .all(...args) as unknown as ReviewRowOut[];
}

export function reviewsByIds(ids: string[]): ReviewRowOut[] {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT store, app, id, rating, title, body, author, language, territory,
              app_version, device, created, updated, reply, first_seen
         FROM mobile_reviews WHERE id IN (${marks})`,
    )
    .all(...ids) as unknown as ReviewRowOut[];
}

export function reviewCounts(): { store: string; app: string; n: number; newest: string | null }[] {
  return db
    .prepare(
      `SELECT store, app, COUNT(*) AS n, MAX(COALESCE(created, first_seen)) AS newest
         FROM mobile_reviews GROUP BY store, app ORDER BY store, app`,
    )
    .all() as unknown as { store: string; app: string; n: number; newest: string | null }[];
}

export function filedReviews(ids: string[]): { review_id: string; card_id: number }[] {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT review_id, card_id FROM mobile_review_cards WHERE review_id IN (${marks})`)
    .all(...ids) as unknown as { review_id: string; card_id: number }[];
}

export function fileReviews(
  rows: { store: string; app: string; reviewId: string }[],
  cardId: number,
) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_review_cards (store, app, review_id, card_id, filed_at)
     VALUES (?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows) stmt.run(r.store, r.app, r.reviewId, cardId, ts);
}

/* --------------------------------------------------------------- versions */

export type VersionWrite = {
  store: string;
  accountId: number;
  app: string;
  version: string;
  observedOn: string;
  platform: string | null;
  state: string | null;
  storeState: string | null;
  phase: string;
  created: string | null;
};

export function writeVersions(rows: VersionWrite[]) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mobile_versions
       (store, account_id, app, version, observed_on, platform, state, store_state, phase, created, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ts = now();
  for (const r of rows)
    stmt.run(
      r.store,
      r.accountId,
      r.app,
      r.version,
      r.observedOn,
      r.platform,
      r.state,
      r.storeState,
      r.phase,
      r.created,
      ts,
    );
  return rows.length;
}

export type VersionRowOut = {
  store: string;
  app: string;
  version: string;
  observed_on: string;
  platform: string | null;
  state: string | null;
  store_state: string | null;
  phase: string;
  created: string | null;
};

export function versions(since: string, app?: string): VersionRowOut[] {
  const where = ["observed_on >= ?"];
  const args: (string | number)[] = [since];
  if (app) (where.push("app = ?"), args.push(app));
  return db
    .prepare(
      `SELECT store, app, version, observed_on, platform, state, store_state, phase, created
         FROM mobile_versions WHERE ${where.join(" AND ")}
        ORDER BY app, created DESC, version, observed_on`,
    )
    .all(...args) as unknown as VersionRowOut[];
}

/* ---------------------------------------------------- analytics instances */

export function knownInstances(accountId: number, app: string): Set<string> {
  const rows = db
    .prepare("SELECT instance_id FROM mobile_analytics_instances WHERE account_id = ? AND app = ?")
    .all(accountId, app) as unknown as { instance_id: string }[];
  return new Set(rows.map((r) => r.instance_id));
}

export function writeInstance(v: {
  accountId: number;
  app: string;
  report: string;
  instanceId: string;
  processed: string | null;
  rows: number;
  bytes: number;
}) {
  db.prepare(
    `INSERT OR REPLACE INTO mobile_analytics_instances
       (account_id, app, report, instance_id, processed, rows, bytes, seen_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(v.accountId, v.app, v.report, v.instanceId, v.processed, v.rows, v.bytes, now());
}

/** When anything in this area was last written, per store. Null before the
 *  first pass — which is "never collected", not "nothing to report". */
export function lastSeen(): { store: string; at: string | null }[] {
  const one = (store: string) => {
    const row = db
      .prepare("SELECT MAX(checked_at) AS at FROM mobile_report_state WHERE store = ?")
      .get(store) as { at: string | null } | undefined;
    return { store, at: row?.at ?? null };
  };
  return [one("play"), one("appstore")];
}
