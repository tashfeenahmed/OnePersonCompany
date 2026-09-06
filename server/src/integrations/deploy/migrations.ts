/**
 * DEPLOY — two tables, both about a machine rather than about a business.
 *
 * `job_leases` IS A REGISTRY OF CLAIMS, NOT A QUEUE. A row says "something is
 * using this machine, and it will still be true until `expires_at` unless
 * somebody says otherwise". Nothing here schedules, orders or blocks: the only
 * question it answers — is anybody mid-job — is one the system this replaces
 * answered with a module-level Map, and it answers it out of a table so
 * that the answer survives the restart that a `node --watch` save causes every
 * time this file's neighbours are edited. An in-memory flag on this box would
 * be cleared four times an afternoon while a forty-minute render was running.
 *
 * A LEASE EXPIRES. That is the whole safety story: a process that dies without
 * releasing leaves a row, and a row whose `expires_at` has passed is not a
 * live lease. It is kept rather than deleted because "what was holding the GPU
 * when the machine was slept out from under it" is exactly the question asked
 * afterwards, and a deleted row cannot answer it. `released_at` distinguishes a
 * clean hand-back from a lapse, and `release_reason` says which.
 *
 * `wake_ownership` IS ONE ROW PER RESOURCE AND IT IS ABOUT WHO PAYS. The rule
 * this table exists to keep: we power off exactly what we
 * powered on. If the machine was already up when this app first looked, it is
 * up for somebody else's reasons and this app is a guest. `found_state` records
 * what was true at the moment of the wake, so that record cannot be
 * retroactively argued with, and `owns` is the derived claim the sleep path
 * reads.
 *
 * NO FOREIGN KEY TO `ventures`. A lease may name a venture and often does, but
 * a lease outliving a deleted venture is a true record of what ran; a cascade
 * would delete the history of the machine because somebody tidied a business.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "210_job_leases",
    sql: `
      CREATE TABLE IF NOT EXISTS job_leases (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        resource       TEXT NOT NULL,
        venture_id     TEXT,
        note           TEXT,
        acquired_at    TEXT NOT NULL,
        heartbeat_at   TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        released_at    TEXT,
        release_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS job_leases_live ON job_leases(released_at, expires_at);
      CREATE INDEX IF NOT EXISTS job_leases_resource ON job_leases(resource, released_at);
    `,
  },
  {
    name: "211_wake_ownership",
    sql: `
      CREATE TABLE IF NOT EXISTS wake_ownership (
        resource    TEXT PRIMARY KEY,
        woke_at     TEXT NOT NULL,
        woke_by     TEXT NOT NULL,
        found_state TEXT NOT NULL,
        owns        INTEGER NOT NULL,
        released_at TEXT
      );
    `,
  },
];
