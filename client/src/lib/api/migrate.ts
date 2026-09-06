import { call } from "@/lib/api";

/**
 * THE MIGRATION AREA FROM THIS SIDE — the import ledger and the adapters.
 *
 * THERE IS NO `startImport` HERE AND THERE CANNOT BE. An import reads a
 * directory off the server's filesystem and writes to eleven tables in one
 * transaction; the server publishes no route that starts one, deliberately, so
 * there is nothing for this file to call. The page says the command instead.
 *
 * ROLLBACK IS HERE, and it is the one call in this file that changes anything.
 * It takes only a batch id the server already holds — nothing this browser
 * could invent — which is exactly what makes it safe to publish where an
 * import is not.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. `lastOk: null` is "the
 * collector has never read this endpoint", which is different from false;
 * `validated: null` is "nobody has ever checked a sample against the contract",
 * which is different from a check that failed; and a metric's `value: null`
 * with a `why` is a MAPPING ERROR and never a zero.
 */

/* ---------------------------------------------------------------- batches */

export type BatchCounts = Record<string, { read: number; imported: number; skipped: number; conflicts: number }>;

export type Batch = {
  id: string;
  source: string;
  kind: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  kinds: string[];
  /** What the run reported at the time. */
  counts: BatchCounts;
  /** What the id map says is in the database NOW — the number a rollback would
   *  remove. After a rollback the two disagree and this is the true one. */
  created: Record<string, number>;
  problems: string[];
  backup: string | null;
  ok: boolean | null;
  error: string | null;
  rolledBackAt: string | null;
  reversible: boolean;
};

export type BatchesDoc = { batches: Batch[]; note: string };

export type RollbackResult = {
  ok: boolean;
  batch: string;
  deleted: Record<string, number>;
  filesRemoved: number;
  filesKept: { path: string; why: string }[];
  problems: string[];
  note: string;
};

/* --------------------------------------------------------------- adapters */

export type EndpointMetric = { label: string; path: string; value: number | null; why: string | null };

export type Endpoint = {
  label: string;
  /** 'users' or 'product-stats'. */
  plugin: string;
  accountId: number;
  connected: boolean;
  lastRead: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  validated: {
    ts: string;
    ok: boolean;
    shape: string | null;
    rows: number | null;
    populations: Record<string, number>;
    contactable: number | null;
    problems: string[];
  } | null;
  metrics: EndpointMetric[] | null;
};

export type AdaptersDoc = {
  endpoints: Endpoint[];
  populations: { product: string; accountId: number; populations: Record<string, number>; contactable: number }[];
  validated: number;
  note: string;
};

/* --------------------------------------------------------------- history */

export type HistorySeries = {
  source: string;
  metric: string;
  subject: string | null;
  window: string;
  unit: string | null;
  rows: number;
  from: string;
  to: string;
  reason: string;
};

export type HistoryDoc = {
  series: HistorySeries[];
  plan: { series: string; window: string; wouldGoTo: string; reason: string }[];
  note: string;
};

/* ------------------------------------------------------------------- api */

export const migrateApi = {
  batches: () => call<BatchesDoc>("/migrate/batches"),
  adapters: () => call<AdaptersDoc>("/migrate/adapters"),
  history: () => call<HistoryDoc>("/migrate/history"),
  /** Destructive. Deletes exactly what one batch created. */
  rollback: (id: string) =>
    call<RollbackResult>(`/migrate/batches/${encodeURIComponent(id)}/rollback`, { method: "POST" }),
};
