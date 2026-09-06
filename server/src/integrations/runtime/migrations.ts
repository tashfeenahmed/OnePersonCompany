/**
 * RUNTIME — three tables, and none of them holds a schedule.
 *
 * The area exists to fill two gaps identified in the pre-launch gap analysis,
 * and the schema is deliberately small because most of what this area knows is
 * owned somewhere else:
 *
 *   WHAT A MODEL CAN DO is measured, not declared, so it is cached rather than
 *   configured — one row per provider+model, re-probed when it ages out.
 *
 *   WHAT A RUNTIME'S SCHEDULER HAS DONE belongs to the runtime. Hermes keeps
 *   its jobs in `~/.hermes/cron/jobs.json` and its runs in
 *   `cron/executions.db` plus `cron/output/`; OpenClaw keeps both in
 *   `state/openclaw.sqlite` (`cron_jobs`, `cron_run_receipts`). This area
 *   READS those and copies nothing about the schedule — no next_run_at, no
 *   expression, no enable flag. The only thing it stores is DELIVERY: which
 *   result was seen here, and whether the owner was actually told.
 *
 * WHY DELIVERY NEEDS A TABLE AT ALL, given the runtime already ran the job.
 * A push with no row behind it has three failure modes nobody can see: it was
 * sent twice, it was never sent because Telegram was down for ninety seconds,
 * or it was sent at three in the morning. Each of those is a column here. The
 * primary key is the run's own identity in the runtime's store, so re-reading
 * the directory cannot re-send and a clock skew cannot either.
 *
 * `runtime_cursor` holds the watermark that makes a fresh install silent: on
 * the first pass every result already on disk is marked seen and not one is
 * sent. A box that has been ticking for a week must not empty its backlog onto
 * somebody's phone the moment this feature is switched on.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "300_runtime_tool_capability",
    sql: `
      -- MEASURED, NOT DECLARED. A model list says nothing about tool calling:
      -- the same gateway serves models that support it and models that ignore
      -- the field, and a provider's documentation is about the provider rather
      -- than about the model the owner chose. So the answer comes from one
      -- trivial call with one trivial tool, and it is cached here because that
      -- call costs tokens and the answer only changes when the model does.
      --
      -- \`mode\` is 'tools' or 'text' — what the connection GIVES, in the words
      -- the settings page uses. 'error' is a third state and is not a verdict:
      -- it means the probe could not be completed (the endpoint was down, the
      -- key was refused), and it must never be reported as "this model cannot
      -- use tools".
      CREATE TABLE IF NOT EXISTS runtime_tool_capability (
        provider   TEXT NOT NULL,
        model      TEXT NOT NULL,
        mode       TEXT NOT NULL,
        detail     TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (provider, model)
      );
    `,
  },
  {
    name: "301_runtime_job_results",
    sql: `
      -- ONE ROW PER NATIVE SCHEDULED RUN THIS BOX HAS SEEN, and whether the
      -- owner was told about it.
      --
      -- \`id\` is '<runtime>:<job id>/<ref>' where \`ref\` is the run's own
      -- identity in the runtime's store — Hermes' output filename, OpenClaw's
      -- receipt id. That is the whole dedupe: an INSERT OR IGNORE.
      --
      -- \`suppressed_by\` IS A SENTENCE AND NOT A BOOLEAN, on customers'
      -- business_events rule, because there are several reasons a result
      -- correctly produces no message and they are not interchangeable:
      --   "first pass"   — history already on disk when the cursor was empty.
      --   "silent"       — the runtime's own silence sentinel. A watchdog with
      --                    nothing to report is working, not broken.
      --   "relay off"    — the owner has not asked for pushes.
      CREATE TABLE IF NOT EXISTS runtime_job_results (
        id             TEXT PRIMARY KEY,
        runtime        TEXT NOT NULL,
        job_id         TEXT NOT NULL,
        job_name       TEXT,
        ref            TEXT NOT NULL,
        -- ISO 8601 UTC: the best real INSTANT available for the run, and it
        -- is deliberately not the runtime's own printed stamp. Hermes names
        -- its output file with local time and no zone on it, so reading that
        -- as UTC would be a lie of up to a day; its file is written once,
        -- atomically, at the end of the run, so the file's mtime is when the
        -- result existed. OpenClaw's receipt carries a real epoch and that is
        -- used directly. Null where neither is available — never "now".
        at             TEXT,
        -- The runtime's own word for how it went, copied rather than mapped.
        status         TEXT,
        -- Bytes of the output as it was read, before any cap for a message.
        chars          INTEGER,
        body           TEXT,
        seen_at        TEXT NOT NULL,
        delivered_at   TEXT,
        delivery_error TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        suppressed_by  TEXT,
        deferred_until TEXT
      );
      CREATE INDEX IF NOT EXISTS runtime_job_results_pending
        ON runtime_job_results(delivered_at, suppressed_by, deferred_until);
      CREATE INDEX IF NOT EXISTS runtime_job_results_seen
        ON runtime_job_results(seen_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_job_results_job
        ON runtime_job_results(runtime, job_id, at DESC);
    `,
  },
  {
    name: "302_runtime_cursor",
    sql: `
      -- The watermark that makes the first pass silent, one row per runtime.
      -- Its ABSENCE is what "this relay has never run for that runtime" means,
      -- which is why it is a table rather than a nullable column somewhere.
      CREATE TABLE IF NOT EXISTS runtime_cursor (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
