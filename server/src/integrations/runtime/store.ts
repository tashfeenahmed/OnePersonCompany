/**
 * THE RUNTIME AREA'S SETTINGS AND ITS THREE TABLES.
 *
 * Two features share this file because they share one question — "what is the
 * agent runtime allowed to do on this box" — and because both of them are
 * bounded by numbers the owner types rather than by constants:
 *
 *   THE TOOL LOOP  how many calls one turn may make, how long it may take,
 *                  how much it may spend, and whether it may WRITE at all.
 *   THE JOB RELAY  whether native scheduled results are pushed, how many per
 *                  pass, and how much of one goes in a message.
 *
 * NO CREDENTIAL. Everything here reaches the model through the provider the
 * owner already chose (models/provider.ts) and Telegram through the bot they
 * already paired (telegram/bridge.ts). A config-only pseudo-plugin, on the
 * pattern agentcore and briefing already keep: a row in `plugins` so
 * `plugin_config`'s foreign key has something to point at, and settings that
 * appear on the Integrations page.
 *
 * QUIET HOURS ARE NOT DEFINED HERE and that is deliberate. The customers area
 * already asks the owner what hours they do not want a phone buzzing in, in
 * one field, with a timezone beside it — and two places to type a quiet window
 * is two places for it to be wrong. `relay.ts` reads that setting through
 * `customers/store.ts` and `customers/events.ts`; this file does not restate
 * it.
 */
import { configValue, db, now } from "../../db.ts";

/** The pseudo-plugin the area's settings hang off. Named once, here, because
 *  the string is a foreign key value and two spellings of it would be two
 *  settings. */
export const RUNTIME_PLUGIN = "runtime";

/* ---------------------------------------------------------------- defaults */

/**
 * THE CEILING ON ONE TURN'S TOOL CALLS.
 *
 * Twelve, and the number is an opinion with a reason: a question that genuinely
 * needs more than a dozen reads of this box's own documents is a question that
 * wanted a sub-agent RUN rather than a chat turn, and the run queue exists.
 * Past the ceiling the loop does not fail — it takes the tools away and makes
 * the model answer with what it has, saying which part it could not check.
 */
export const DEFAULT_MAX_TOOL_CALLS = 12;

/**
 * THE WALL CLOCK ON ONE TURN, IN SECONDS.
 *
 * Not the same thing as the per-call timeout, which the provider's own policy
 * owns. This one exists because twelve calls each taking their full timeout is
 * twenty-four minutes of a page spinning, and the honest answer at three
 * minutes is "here is what I found, I ran out of time" rather than silence.
 */
export const DEFAULT_TOOL_SECONDS = 180;

/**
 * HOW BIG THE TOOL LIST MAY BE, IN BYTES.
 *
 * 24 KB, and it is agentcore's response budget's number on purpose: a tool
 * LIST that is bigger than a whole tool ANSWER is out of proportion, and both
 * are the same kind of claim on the same context window. Above it the loop
 * hands the model a three-tool index instead of one tool per integration —
 * which is not a degraded mode, only a differently shaped one (see
 * `indexTools`). Raise it for a large-window model that would rather have the
 * typed parameters; lower it for a local 8k one.
 */
export const DEFAULT_TOOL_CATALOG_BYTES = 24 * 1024;

/** How many results one relay pass renders individually. Lower than an event
 *  feed's, because a cron run's output is a whole answer rather than a line.
 *  Past it, one message says how many were held back and where to read them. */
export const DEFAULT_JOBS_PER_PASS = 5;

/** Characters of one result that go in a message. The full text stays in the
 *  row and in the runtime's own store; a 40 KB answer split into a dozen
 *  consecutive messages is the flood this cap exists to prevent. */
export const DEFAULT_JOBS_BODY_CHARS = 2800;

/* ---------------------------------------------------------------- settings */

const onOff = (v: string | null, fallback: boolean) => {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return fallback;
  return t === "on" || t === "yes" || t === "true" || t === "1";
};

function intSetting(key: string, fallback: number, lo: number, hi: number): number {
  const raw = (configValue(RUNTIME_PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  /* An unreadable value reads as the DEFAULT rather than as zero, for
     agentcore's reason: a hand-edited row must not be able to switch a bound
     off by being wrong. */
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function usdSetting(key: string, fallback: number): number {
  const raw = (configValue(RUNTIME_PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : fallback;
}

export type RuntimeSettings = {
  /** May a direct provider use tools at all. On, but it only takes effect for
   *  a model MEASURED to support them — see probe.ts. */
  tools: boolean;
  /** May the loop call skill ACTIONS (writes), or only views (reads). Off, and
   *  the reason is in the manifest's hint: a raw model is new to this door. */
  actions: boolean;
  maxToolCalls: number;
  toolSeconds: number;
  /** Above this, the per-skill tool list is replaced by the three-tool index. */
  catalogBytes: number;
  /** Dollars one turn may spend across every model call it makes. 0 = no
   *  dollar ceiling of this area's own; the global budgets in
   *  runtime/budgets.ts still apply. */
  turnUsd: number;
  /** Whether native scheduled results are pushed to Telegram at all. OFF until
   *  asked for, on customers' rule: a message arriving on somebody's phone
   *  because a default said so is a surprise. */
  relay: boolean;
  jobsPerPass: number;
  jobsBodyChars: number;
};

export function settings(): RuntimeSettings {
  return {
    tools: onOff(configValue(RUNTIME_PLUGIN, "tools"), true),
    actions: onOff(configValue(RUNTIME_PLUGIN, "actions"), false),
    maxToolCalls: intSetting("max_tool_calls", DEFAULT_MAX_TOOL_CALLS, 1, 100),
    toolSeconds: intSetting("tool_seconds", DEFAULT_TOOL_SECONDS, 10, 3600),
    catalogBytes: intSetting("tool_catalog_bytes", DEFAULT_TOOL_CATALOG_BYTES, 1024, 4 * 1024 * 1024),
    turnUsd: usdSetting("turn_usd", 0),
    relay: onOff(configValue(RUNTIME_PLUGIN, "relay"), false),
    jobsPerPass: intSetting("jobs_per_pass", DEFAULT_JOBS_PER_PASS, 1, 50),
    jobsBodyChars: intSetting("jobs_body_chars", DEFAULT_JOBS_BODY_CHARS, 200, 20_000),
  };
}

/* -------------------------------------------------------------- capability */

export type ToolMode = "tools" | "text" | "error";

export type Capability = {
  provider: string;
  model: string;
  mode: ToolMode;
  detail: string | null;
  checkedAt: string;
};

/**
 * How long a measurement stands.
 *
 * Seven days, because the thing being measured — whether THIS model on THIS
 * gateway honours a `tools` array — changes when the far end is upgraded and
 * not otherwise. A router that answers `auto` is the case that ages worst, and
 * seven days is short enough that a gateway which gained tool support is
 * noticed within a week and long enough that the probe is not a per-turn cost.
 */
export const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function capability(provider: string, model: string): Capability | null {
  const r = db
    .prepare(
      "SELECT provider, model, mode, detail, checked_at FROM runtime_tool_capability WHERE provider = ? AND model = ?",
    )
    .get(provider, model) as
    | { provider: string; model: string; mode: string; detail: string | null; checked_at: string }
    | undefined;
  if (!r) return null;
  return {
    provider: r.provider,
    model: r.model,
    mode: r.mode === "tools" || r.mode === "text" ? r.mode : "error",
    detail: r.detail,
    checkedAt: r.checked_at,
  };
}

export function writeCapability(provider: string, model: string, mode: ToolMode, detail: string | null) {
  db.prepare(
    `INSERT INTO runtime_tool_capability (provider, model, mode, detail, checked_at) VALUES (?,?,?,?,?)
       ON CONFLICT(provider, model) DO UPDATE SET mode = excluded.mode, detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(provider, model, mode, detail, now());
}

export function capabilities(): Capability[] {
  const rows = db
    .prepare("SELECT provider, model, mode, detail, checked_at FROM runtime_tool_capability ORDER BY checked_at DESC")
    .all() as { provider: string; model: string; mode: string; detail: string | null; checked_at: string }[];
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    mode: r.mode === "tools" || r.mode === "text" ? r.mode : "error",
    detail: r.detail,
    checkedAt: r.checked_at,
  }));
}

export function isFresh(c: Capability, at = Date.now()): boolean {
  const t = Date.parse(c.checkedAt);
  return Number.isFinite(t) && at - t < CAPABILITY_TTL_MS;
}

/* ------------------------------------------------------------------ cursor */

export function cursor(key: string): string | null {
  const r = db.prepare("SELECT value FROM runtime_cursor WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r ? r.value : null;
}

export function setCursor(key: string, value: string) {
  db.prepare(
    `INSERT INTO runtime_cursor (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

/* ------------------------------------------------------------- job results */

export type JobResultRow = {
  id: string;
  runtime: string;
  job_id: string;
  job_name: string | null;
  ref: string;
  at: string | null;
  status: string | null;
  chars: number | null;
  body: string | null;
  seen_at: string;
  delivered_at: string | null;
  delivery_error: string | null;
  attempts: number;
  suppressed_by: string | null;
  deferred_until: string | null;
};

/**
 * Record a result the reader found, once.
 *
 * INSERT OR IGNORE IS THE WHOLE DEDUPE. The id is the run's own identity in
 * the runtime's own store, so a second pass over the same directory inserts
 * nothing and a delivered row can never be delivered again. Returns true when
 * the row is NEW, which is what "there is something to relay" means.
 */
export function recordResult(r: {
  id: string;
  runtime: string;
  jobId: string;
  jobName: string | null;
  ref: string;
  at: string | null;
  status: string | null;
  body: string | null;
  suppressedBy: string | null;
}): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO runtime_job_results
         (id, runtime, job_id, job_name, ref, at, status, chars, body, seen_at, suppressed_by, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .run(
      r.id,
      r.runtime,
      r.jobId,
      r.jobName,
      r.ref,
      r.at,
      r.status,
      r.body === null ? null : r.body.length,
      r.body,
      now(),
      r.suppressedBy,
    );
  return info.changes > 0;
}

/** Has this exact run already been recorded here? Cheap — a primary-key
 *  lookup — and used by the reader to avoid opening a file it has already
 *  read. It is an OPTIMISATION and not the dedupe: the dedupe is the
 *  `INSERT OR IGNORE` above, so a false answer here costs a wasted read and
 *  never a duplicate row. */
export function alreadySeen(id: string): boolean {
  return db.prepare("SELECT 1 FROM runtime_job_results WHERE id = ?").get(id) !== undefined;
}

/** Results that still want a message: never delivered, not suppressed, not
 *  deferred past this moment, and under the attempt ceiling. Oldest first, so
 *  a backlog is relayed in the order it happened. */
export function pendingResults(limit: number, at = new Date()): JobResultRow[] {
  return db
    .prepare(
      `SELECT * FROM runtime_job_results
        WHERE delivered_at IS NULL
          AND suppressed_by IS NULL
          AND attempts < ?
          AND (deferred_until IS NULL OR deferred_until <= ?)
        ORDER BY coalesce(at, seen_at) ASC, id ASC
        LIMIT ?`,
    )
    .all(MAX_DELIVERY_ATTEMPTS, at.toISOString(), limit) as JobResultRow[];
}

/**
 * Five, and it is customers/collect.ts's number rather than a new one.
 *
 * The failure it bounds is the same failure: Telegram refusing a message for a
 * reason that will not fix itself (a bot removed from the chat, a body the API
 * will not accept) turns into a row retried on every pass forever. Five
 * attempts is enough to ride out a network blip and few enough that a
 * permanent refusal stops costing requests — and the row keeps its last error,
 * so "you were not told" stays readable rather than becoming silence.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export function markDelivered(id: string) {
  db.prepare(
    "UPDATE runtime_job_results SET delivered_at = ?, delivery_error = NULL, attempts = attempts + 1 WHERE id = ?",
  ).run(now(), id);
}

export function markDeliveryFailed(id: string, why: string) {
  db.prepare(
    "UPDATE runtime_job_results SET delivery_error = ?, attempts = attempts + 1 WHERE id = ?",
  ).run(why.slice(0, 400), id);
}

export function defer(id: string, until: string) {
  db.prepare("UPDATE runtime_job_results SET deferred_until = ? WHERE id = ?").run(until, id);
}

export function suppress(id: string, why: string) {
  db.prepare("UPDATE runtime_job_results SET suppressed_by = ? WHERE id = ?").run(why.slice(0, 200), id);
}

export function results(opts: { runtime?: string; jobId?: string; limit?: number } = {}): JobResultRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 40)));
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.runtime) {
    where.push("runtime = ?");
    args.push(opts.runtime);
  }
  if (opts.jobId) {
    where.push("job_id = ?");
    args.push(opts.jobId);
  }
  args.push(limit);
  return db
    .prepare(
      `SELECT * FROM runtime_job_results
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY coalesce(at, seen_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(...args) as JobResultRow[];
}

/** The last result this box saw for one job, whatever became of it. Used by
 *  the jobs view so a job listed from the runtime's store carries the run this
 *  side actually read. */
export function lastResult(runtimeId: string, jobId: string): JobResultRow | null {
  const r = db
    .prepare(
      `SELECT * FROM runtime_job_results WHERE runtime = ? AND job_id = ?
        ORDER BY coalesce(at, seen_at) DESC, id DESC LIMIT 1`,
    )
    .get(runtimeId, jobId) as JobResultRow | undefined;
  return r ?? null;
}

export function resultCounts(): { seen: number; delivered: number; pending: number; suppressed: number } {
  const r = db
    .prepare(
      `SELECT count(*) AS seen,
              sum(delivered_at IS NOT NULL) AS delivered,
              sum(delivered_at IS NULL AND suppressed_by IS NULL AND attempts < ${MAX_DELIVERY_ATTEMPTS}) AS pending,
              sum(suppressed_by IS NOT NULL) AS suppressed
         FROM runtime_job_results`,
    )
    .get() as { seen: number; delivered: number | null; pending: number | null; suppressed: number | null };
  return {
    seen: r.seen ?? 0,
    delivered: r.delivered ?? 0,
    pending: r.pending ?? 0,
    suppressed: r.suppressed ?? 0,
  };
}
