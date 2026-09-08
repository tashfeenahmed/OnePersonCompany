/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "040_uptime",
    sql: `
      -- ONE ROW PER HOST PER CHECK, AND NOTHING DERIVED.
      --
      -- Availability, p50, p95 and "is it up right now" are all computed when
      -- this table is READ, for the reason the domains table computes its
      -- countdowns on every read: a stored "99.4% over 24 hours" is wrong an
      -- hour later and catastrophically wrong after a collection that did not
      -- run. What is stored is only what was actually observed at one instant.
      --
      -- THERE IS NO "up" COLUMN SEPARATE FROM "ok". A check is ok when the
      -- final response carried a status below 400 — a 301 that lands on a 200
      -- is ok, a 500 is not, and a connection that never opened has ok = 0
      -- with a null status and the reason in "error". A host that answered 403
      -- is DOWN by this definition and the route says which status it was, so
      -- the owner can tell "my server is off" from "Cloudflare is challenging
      -- the checker".
      --
      -- "host" is exactly what the owner typed, normalised to lower case. That
      -- is deliberate: it is the entity key venture_links points at, and a key
      -- that changed shape when a redirect moved would orphan every link. The
      -- scheme is part of it when one was typed, because "does http redirect
      -- to https" is a question only askable of an http:// host.
      --
      -- Retention is 30 days, pruned by the collector rather than by db.ts's
      -- prune() — this table is one row per host per half hour, which is a
      -- different order of magnitude from readings and has its own answer.
      CREATE TABLE uptime_checks (
        host        TEXT NOT NULL,
        ts          TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        -- NULL means the request never got a response at all. It is not a 0.
        status      INTEGER,
        latency_ms  INTEGER,
        -- Days until the certificate presented by the host expires. NULL for a
        -- plain-http target, and NULL when the TLS probe itself failed — which
        -- is not the same as "expired" and must never be drawn as 0 days left.
        tls_days    INTEGER,
        bytes       INTEGER,
        final_url   TEXT,
        error       TEXT,
        PRIMARY KEY (host, ts)
      ) WITHOUT ROWID;

      CREATE INDEX uptime_checks_ts ON uptime_checks(ts);
    `,
  },

  {
    name: "041_fleet",
    sql: `
      -- A BOX OVER SSH, SAMPLED. Four tables rather than one wide row, because
      -- they have four different cardinalities: one sample per box per run,
      -- several filesystems, a variable number of containers, and one row per
      -- box that is REPLACED rather than appended.
      --
      -- account_id is the key throughout — an account here is one box, and the
      -- account's own label is its name. Nothing is keyed by hostname: two
      -- boxes can both call themselves "ubuntu", and a hostname changes when
      -- somebody edits a file while the credential that reaches the machine
      -- does not.
      --
      -- Samples are retained 30 days by the collector. The questions this data
      -- answers -- "was it swapping last night", "when did / start filling up"
      -- -- are asked of recent history; a year of half-hourly samples per box
      -- would be a hundred thousand rows to answer none of them better.
      CREATE TABLE fleet_samples (
        account_id  INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        load1       REAL,
        load5       REAL,
        load15      REAL,
        cpus        INTEGER,
        -- Bytes, always. The probe reads kB from /proc/meminfo and pages from
        -- vm_stat and converts at the source, so nothing downstream has to
        -- know which kind of machine answered.
        mem_total   INTEGER,
        mem_used    INTEGER,
        mem_avail   INTEGER,
        swap_total  INTEGER,
        swap_used   INTEGER,
        uptime_s    INTEGER,
        PRIMARY KEY (account_id, ts)
      ) WITHOUT ROWID;

      CREATE INDEX fleet_samples_ts ON fleet_samples(ts);

      -- Bytes, from df -P, per mount. Appended per run rather than replaced,
      -- because "when did this disk start filling" is the only question a disk
      -- figure is ever really asked.
      CREATE TABLE fleet_disks (
        account_id  INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        mount       TEXT NOT NULL,
        size        INTEGER,
        used        INTEGER,
        avail       INTEGER,
        PRIMARY KEY (account_id, ts, mount)
      ) WITHOUT ROWID;

      CREATE INDEX fleet_disks_ts ON fleet_disks(ts);

      -- Only when docker is on the box. No docker is NOT zero containers, and
      -- the route reports the difference from fleet_hosts.docker.
      CREATE TABLE fleet_containers (
        account_id  INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        name        TEXT NOT NULL,
        image       TEXT,
        status      TEXT,
        since       TEXT,
        PRIMARY KEY (account_id, ts, name)
      ) WITHOUT ROWID;

      CREATE INDEX fleet_containers_ts ON fleet_containers(ts);

      -- What the box SAYS IT IS, replaced every run: one row per account. The
      -- error column holds the last failure and is cleared by the next
      -- success, so a box that stopped answering keeps its identity on the
      -- page with the reason it went quiet beside it, rather than vanishing.
      CREATE TABLE fleet_hosts (
        account_id  INTEGER PRIMARY KEY,
        hostname    TEXT,
        kernel      TEXT,
        -- 0 / 1 / NULL, and NULL means the probe never got far enough to look.
        docker      INTEGER,
        seen_at     TEXT NOT NULL,
        -- When it last answered, as against when it was last asked.
        ok_at       TEXT,
        error       TEXT
      );
    `,
  },

  {
    name: "042_product_stats",
    sql: `
      -- THE LAST DOCUMENT EACH PRODUCT ENDPOINT ANSWERED WITH, and only the
      -- last.
      --
      -- One row per account, replaced. A history of documents would be 64 KB
      -- of JSON every thirty minutes per endpoint to answer a question nobody
      -- asks — the numbers INSIDE it are the history, and they go to readings
      -- as "product.<accountId>.<label>" where they are one row of three
      -- columns instead.
      --
      -- The document is kept at all for one reason: the mapping is edited
      -- later than it is collected. A path that resolves to nothing has to be
      -- reported as a mapping error rather than as a zero, and that judgement
      -- can only be made against the shape the endpoint actually answers with
      -- — which is here, so the route can re-resolve every path on every read
      -- and tell the owner what their new line matched.
      CREATE TABLE product_docs (
        account_id  INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL,
        -- 1 when the endpoint answered with JSON this app could parse.
        ok          INTEGER NOT NULL,
        -- The HTTP status. NULL when nothing answered at all.
        status      INTEGER,
        ms          INTEGER,
        -- NULL when it was not truncated. A document over the cap is stored
        -- truncated and UNPARSEABLE, so it is stored with ok = 0 and this
        -- note, rather than silently mapped from half a JSON document.
        truncated   INTEGER,
        doc         TEXT,
        error       TEXT
      );
    `,
  },

  {
    name: "043_backups",
    sql: `
      -- EVERY BACKUP ATTEMPT, SUCCESSFUL OR NOT, for the reason runs exists:
      -- "when did this last work" is only answerable by something that also
      -- records the times it did not. A backup system that logs its successes
      -- is a backup system that goes quiet for a month and looks healthy.
      --
      -- remote_ok is a THIRD state and not a boolean: NULL means no remote is
      -- configured, 1 that rsync succeeded, 0 that the archive is on this
      -- machine only. A local archive is a real backup and the run is ok; the
      -- route says the copy did not leave.
      CREATE TABLE backup_runs (
        ts         TEXT NOT NULL,
        file       TEXT,
        bytes      INTEGER,
        ok         INTEGER NOT NULL,
        remote_ok  INTEGER,
        -- What went in, so "does this archive have the vault key" is
        -- answerable without opening it.
        members    TEXT,
        ms         INTEGER,
        -- 'manual' or 'nightly'. A 4 a.m. failure and a button pressed at
        -- lunchtime are read differently.
        kind       TEXT NOT NULL DEFAULT 'manual',
        error      TEXT,
        PRIMARY KEY (ts)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "044_fleet_target",
    sql: `
      -- WHERE THIS BOX ACTUALLY IS, kept beside what it says it is.
      --
      -- The ssh target lives in the vault, because it is one half of a
      -- credential set and the entry names are how this codebase decides what
      -- is configured without decrypting anything. But every read of the fleet
      -- page needs it — to name the box, and to tell venture_links which
      -- hostname the account is about — and opening a ciphertext to draw a
      -- page would put a secret_access row under every refresh and decrypt the
      -- private key beside it to get at a hostname that was never secret.
      --
      -- So the collector writes it here as it uses it. It is a CACHE of the
      -- vault and says so: it is only ever as fresh as the last collection,
      -- and the vault stays the record.
      --
      -- APPENDED RATHER THAN FOLDED INTO 041, because 041 has been applied.
      -- A step that has run anywhere must never change; the database that ran
      -- 041 and one that never saw it both end up here.
      ALTER TABLE fleet_hosts ADD COLUMN target TEXT;
    `,
  },

  {
    name: "045_product_url",
    sql: `
      -- WHICH ENDPOINT THIS DOCUMENT CAME FROM, cached beside it.
      --
      -- Same argument as 044_fleet_target, one integration over. The URL is
      -- one half of a credential set and lives in the vault, but the page
      -- needs it — to name the endpoint, and to give venture_links the
      -- hostname the account is obviously about — and opening a ciphertext to
      -- draw a page would decrypt the bearer token sitting beside it to get at
      -- a URL that was never secret.
      --
      -- The collector writes it as it uses it, so it is only ever as fresh as
      -- the last collection. The vault stays the record.
      ALTER TABLE product_docs ADD COLUMN url TEXT;
    `,
  },

  {
    name: "046_fleet_cpu",
    sql: `
      -- HOW BUSY THE CPU ACTUALLY IS, which nothing in 041_fleet could say.
      --
      -- The probe recorded load averages and no utilisation, and the two are
      -- not the same measurement: load counts RUNNABLE TASKS, so a box waiting
      -- on a slow disk carries a load of 4 with idle cores, and a box pinned at
      -- 100% on two threads carries a load of 2. "Is this machine busy" is a
      -- question about utilisation, and the Servers board is asked it first.
      --
      -- REAL AND NULLABLE. It is a percentage of one instant sampled over a
      -- second, so 12.5 is a real reading and rounding it to an integer throws
      -- away the only resolution a quiet box has. NULL is the state every row
      -- written before this column existed is in, and it means NOT MEASURED —
      -- never an idle CPU. Every card below draws those rows as a gap.
      ALTER TABLE fleet_samples ADD COLUMN cpu_pct REAL;
    `,
  },
];
