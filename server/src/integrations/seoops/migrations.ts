/**
 * SEO OPS — the tables. NO IMPORTS: see integrations/manifest.ts's header for
 * why an area's SQL depends on nothing.
 *
 * FOUR FEATURES, FOUR GROUPS OF TABLES, AND THEY DO NOT JOIN TO EACH OTHER.
 * A URL's Search Console history, a directory checklist, a model's opinion of
 * a screenshot and a browser's reading of a page's computed styles are four
 * measurements of four different things that happen to share an owner. They
 * are in one area because they are the same WORK — the off-page half of
 * looking after a small site — and not because anything sums across them.
 *
 * THE ONE RULE ALL FOUR SHARE IS `measured`. Every reading table here carries
 * a flag saying whether a figure was actually read, beside the figure. A page
 * missing from a capped report, a screenshot no model could look at, a site
 * that would not render: all of those are rows with `measured = 0` and a
 * sentence, never a row of zeroes. That is the whole reason these are tables
 * rather than derived on read — the ABSENCE has to be storable.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    /*
      A BASELINE IS A URL AND A DATE, and the date is the ACTION's, not the
      capture's. Everything downstream is measured in days after the action —
      the day the card was marked done — so a box that was asleep for a week
      still takes the 14-day reading on day sixteen and records that it did,
      rather than moving the schedule to whenever it woke up.

      `source` + `source_ref` + `url` IS UNIQUE, which is what lets the sweep
      that finds finished cards run every hour, twice, or in two processes and
      leave one baseline behind. board.ts's `fileCard` makes the same trade for
      the same reason: the expensive half of "something filed this
      automatically" is the idempotency, not the INSERT.

      `property` IS NULLABLE AND ITS ABSENCE IS A FINDING. A URL whose host
      matches no Search Console property this box can see cannot be measured at
      all, and that is a different state from "measured as nothing".
    */
    name: "320_seoops_baselines",
    sql: `
      CREATE TABLE IF NOT EXISTS seo_baselines (
        id           TEXT PRIMARY KEY,
        venture_id   TEXT,
        source       TEXT NOT NULL,
        source_ref   TEXT,
        url          TEXT NOT NULL,
        property     TEXT,
        tag          TEXT,
        title        TEXT NOT NULL,
        action_at    TEXT NOT NULL,
        offsets      TEXT NOT NULL,
        outcome_id   TEXT,
        created_at   TEXT NOT NULL,
        closed_at    TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS seo_baselines_origin
        ON seo_baselines(source, source_ref, url);
      CREATE INDEX IF NOT EXISTS seo_baselines_venture ON seo_baselines(venture_id);

      -- One reading of one URL over one window. The measured column is what the
      -- whole feature turns on: 0 means Search Console was asked and gave this
      -- URL no row, which is NOT a zero — see the routes' rules.
      CREATE TABLE IF NOT EXISTS seo_baseline_readings (
        id            INTEGER PRIMARY KEY,
        baseline_id   TEXT NOT NULL,
        ts            TEXT NOT NULL,
        kind          TEXT NOT NULL,
        day_offset    INTEGER,
        measured      INTEGER NOT NULL,
        source        TEXT,
        window_start  TEXT,
        window_end    TEXT,
        window_days   INTEGER,
        clicks        INTEGER,
        impressions   INTEGER,
        ctr           REAL,
        position      REAL,
        -- The whole property over the same window, so a page that fell with
        -- everything else can be told from a page that fell on its own.
        site_clicks       INTEGER,
        site_impressions  INTEGER,
        queries       TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS seo_baseline_readings_b
        ON seo_baseline_readings(baseline_id, day_offset);

      -- One diagnosis per baseline per offset, and never two: the unique index
      -- is what makes a re-run of a due follow-up a no-op rather than a second
      -- opinion.
      CREATE TABLE IF NOT EXISTS seo_diagnoses (
        id          INTEGER PRIMARY KEY,
        baseline_id TEXT NOT NULL,
        day_offset  INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        verdict     TEXT NOT NULL,
        diagnosis   TEXT NOT NULL,
        rule        INTEGER,
        decided_by  TEXT NOT NULL,
        model       TEXT,
        next_action TEXT NOT NULL,
        delta       TEXT NOT NULL,
        model_note  TEXT,
        error       TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS seo_diagnoses_slot
        ON seo_diagnoses(baseline_id, day_offset);
    `,
  },
  {
    /*
      THE LEDGER IS THE OWNER'S AND THE CRAWLER MAY ONLY RATCHET IT FORWARD.
      `set_by` records which of the two wrote the row last, because the two
      have different rights: a person may set any state, including back to
      not_listed; detection may only move a row to `detected` and only from
      `not_listed` or `pending`. The reason is the ordinary case rather than an
      edge one — a directory that stops answering, or a listing under a slug
      the probe does not guess, would otherwise un-tick work that was really
      done.

      THE TIMESTAMPS ARE STAMPED ONCE. `submitted_at` and `confirmed_at` are
      set the first time the row reaches that state and never restamped:
      "confirmed in April" is the fact, and a second press in August must not
      rewrite it.
    */
    name: "321_seoops_listing_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS listing_ledger (
        venture_id   TEXT NOT NULL,
        directory_id TEXT NOT NULL,
        state        TEXT NOT NULL,
        note         TEXT,
        url          TEXT,
        detected_at  TEXT,
        submitted_at TEXT,
        confirmed_at TEXT,
        last_checked TEXT,
        set_by       TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (venture_id, directory_id)
      );
      CREATE INDEX IF NOT EXISTS listing_ledger_state ON listing_ledger(state);
    `,
  },
  {
    /*
      ONE VERDICT PER DISTINCT PICTURE PER VENTURE, which is the reuse rule
      written into the schema rather than into a cache. `shot_hash` is the
      SHA-256 of the file's bytes: a weekly capture of a site that has not
      changed hashes the same, finds this row, and costs nothing. A row whose
      `verdict` is NULL is a failed attempt and may be replaced; a row with a
      verdict is kept.
    */
    name: "322_seoops_shot_vision",
    sql: `
      CREATE TABLE IF NOT EXISTS shot_vision (
        id          INTEGER PRIMARY KEY,
        venture_id  TEXT NOT NULL,
        shot_path   TEXT NOT NULL,
        shot_hash   TEXT NOT NULL,
        shot_ts     TEXT,
        ts          TEXT NOT NULL,
        provider    TEXT,
        model       TEXT,
        verdict     TEXT,
        issues      TEXT NOT NULL DEFAULT '[]',
        raw         TEXT,
        error       TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS shot_vision_hash
        ON shot_vision(venture_id, shot_hash);
      CREATE INDEX IF NOT EXISTS shot_vision_v ON shot_vision(venture_id, ts);

      -- Whether the ACTIVE provider's model will accept an image at all,
      -- probed once and remembered. The supports column is NULL for "the probe itself
      -- failed", which is not the same as "it refused the image".
      CREATE TABLE IF NOT EXISTS model_vision_probe (
        key      TEXT PRIMARY KEY,
        ts       TEXT NOT NULL,
        supports INTEGER,
        detail   TEXT NOT NULL
      );
    `,
  },
  {
    /*
      THE RENDERED READING SITS BESIDE THE STATIC ONE AND NEVER OVER IT.
      `ventures.brand` stays exactly what ventures/enrich.ts measured out of
      the HTML; this is a second reading of the same site through a browser,
      with `method` saying which window it came through. The venture page shows
      both and says which it is drawing.

      THE OVERRIDE IS A THIRD TABLE-SHAPED THING IN THE SAME ROW SPACE, kept
      apart so that re-measuring never erases what the owner typed and clearing
      an override never erases the measurement.
    */
    name: "323_seoops_brand_measured",
    sql: `
      CREATE TABLE IF NOT EXISTS brand_measured (
        venture_id TEXT PRIMARY KEY,
        method     TEXT NOT NULL,
        ts         TEXT NOT NULL,
        url        TEXT,
        doc        TEXT NOT NULL,
        error      TEXT
      );
      CREATE TABLE IF NOT EXISTS brand_overrides (
        venture_id TEXT PRIMARY KEY,
        doc        TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
