/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    /*
      SERP TEARDOWN — ONE ROW PER QUERY, NOT PER RUN.

      A teardown is asked per QUERY because ranking is per query: "we are
      ninth for planning permission search" and "we are second for planning
      appeal ireland" are two different facts with two different pages above
      us, and a run-level row would have to flatten them into one blob that
      nothing could ever query. So the run is the ledger row over in
      agent_runs and this is the measurement: what was searched, where we
      came in the result set, and what the pages that beat us are made of.

      `our_rank` IS THE METASEARCH NODE'S ORDER AND IT IS NOT GOOGLE'S. That
      distinction is the single most important thing in this table and it is
      why the column is not called `position`. SearXNG merges several engines
      and returns its own order; Google's average position for the same query
      is a different figure, over a different window, in gsc_queries, and it
      is copied onto `gsc_position` here so a reader has both and can never
      mistake one for the other. NULL in `our_rank` means our host was not in
      the results at all — which is a real and common measurement, and never
      a zero.

      `competitors` IS JSON because it is one document read once, by the page
      and by the report, and never joined on. Each entry is a page structure
      this server read out of the HTML in code — title, headings, word count,
      schema types, link counts — plus the domain it came from. A table of
      them would buy a join and an ordering question for a list that is at
      most eight rows long and is only ever read whole.

      `degraded` IS THE SELF-CHECK AND IT GATES EVERY CONCLUSION. A search
      node asked a long-tail question frequently answers a DIFFERENT one — it
      rewrites the query, or one engine is answering and it ignored the terms
      — so the share of the query's own words appearing in the titles and
      snippets is measured and stored beside the verdict. Below the floor the
      row is marked degraded and the report draws no gap list from it: a gap
      list computed from ten pages about something else is worse than none.
      `unmeasurable` is the third state — a one-word or all-stop-word query,
      where the check has only two possible answers and therefore measures
      nothing.
    */
    name: "150_growth_serp",
    sql: `
      CREATE TABLE IF NOT EXISTS growth_serp (
        run_id       TEXT NOT NULL,
        venture_id   TEXT NOT NULL,
        query        TEXT NOT NULL,
        -- Where the query came from: 'owner' (typed into the form),
        -- 'gsc' (a striking-distance query out of Search Console) or
        -- 'description' (derived mechanically from the venture record).
        -- Never merged: a derived query is not evidence that anybody
        -- searches for it, and the report has to be able to say so.
        source       TEXT NOT NULL,
        -- Google's own average position for this query over Search Console's
        -- window, when there is one. NULL when the query did not come from
        -- Search Console or Google reported none.
        gsc_position REAL,
        gsc_impressions INTEGER,
        -- Our place in the SearXNG result list, 1-based. NULL is "our host
        -- was not in the results", which is a measurement.
        our_rank     INTEGER,
        our_url      TEXT,
        -- The structure of OUR page, read from its HTML the same way the
        -- competitors' were, so the comparison is like with like.
        ours         TEXT,
        competitors  TEXT NOT NULL DEFAULT '[]',
        -- The relevance self-check: matched query words over countable query
        -- words, and the verdict. NULL ratio means unmeasurable.
        relevance    REAL,
        degraded     INTEGER NOT NULL DEFAULT 0,
        unmeasurable TEXT,
        -- The mechanical gap list: fields where the competitor median beats
        -- ours, computed here rather than by a model.
        gaps         TEXT NOT NULL DEFAULT '[]',
        ts           TEXT NOT NULL,
        PRIMARY KEY (run_id, query)
      );
      CREATE INDEX IF NOT EXISTS growth_serp_venture ON growth_serp(venture_id, ts DESC);
    `,
  },

  {
    /*
      CRO — THE EXPERIMENT LEDGER, AND THE LIBRARY IS NOT IN IT.

      The library of hypotheses is a static file in this area's directory: it
      is written by hand, it is the same for every owner who installs this,
      and a copy of it in the database would be a copy that drifts from the
      one the code reads. What IS per-owner is which of those experiments a
      venture is actually running, so that is the table — one row per
      (venture, experiment), started when the owner starts it.

      `status` IS FOUR-VALUED AND `dropped` IS NOT `done`. An experiment that
      was abandoned before it had a result is not a finding, and folding it
      into "done" would let a run of abandoned tests read as a run of
      learnings. `result` is free text and is only meaningful on `done`.

      `outcome_link` IS DELIBERATELY UNCONSTRAINED. Another area may one day
      hold the outcome of a change (a board card, a chief-of-staff decision
      record); until then this is a string nobody writes, and a foreign key
      to a table that does not exist yet is a migration that cannot run.
    */
    name: "151_growth_cro",
    sql: `
      CREATE TABLE IF NOT EXISTS growth_cro (
        venture_id   TEXT NOT NULL,
        experiment   TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('planned','running','done','dropped')),
        stage        TEXT,
        started_at   TEXT,
        finished_at  TEXT,
        result       TEXT,
        outcome_link TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (venture_id, experiment)
      );
      CREATE INDEX IF NOT EXISTS growth_cro_venture ON growth_cro(venture_id, updated_at DESC);
    `,
  },

  {
    /*
      INDEXING — WHAT WAS SUBMITTED, TO WHOM, AND WHAT CAME BACK.

      One row per URL per submission, and the row keeps the HTTP status and
      the body verbatim because THE STATUS IS THE WHOLE ANSWER. IndexNow's
      200 and 202 mean "received" and "accepted for processing" — they do not
      mean indexed, they do not mean crawled, and nothing on this box may
      ever report them as either. A row is therefore a record of a REQUEST
      and its receipt, which is the only thing that actually happened.

      `endpoint` IS ON THE ROW because IndexNow is a protocol with several
      participating hosts (api.indexnow.org fans out; bing.com and yandex
      take submissions directly), and "we told Bing" and "we told the shared
      endpoint" are different claims. `status` is NULL when the request never
      got an HTTP answer at all, with the reason in `response`.
    */
    name: "152_growth_indexing",
    sql: `
      CREATE TABLE IF NOT EXISTS growth_indexing (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        host         TEXT NOT NULL,
        url          TEXT NOT NULL,
        endpoint     TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        -- The HTTP status IndexNow answered with, or NULL when nothing did.
        status       INTEGER,
        -- 'received' | 'accepted' | 'refused' | 'unreachable' | 'dry-run'.
        -- 'dry-run' is a submission this box refused to make because the key
        -- file was not hosted; it is kept so the log shows the attempt and
        -- the reason rather than nothing at all.
        outcome      TEXT NOT NULL,
        response     TEXT,
        -- Why this URL was in the batch: 'owner', 'audit-new', 'audit-changed'
        -- or 'sitemap'. A submission nobody can trace back to a reason is a
        -- submission nobody can decide to stop making.
        reason       TEXT NOT NULL DEFAULT 'owner'
      );
      CREATE INDEX IF NOT EXISTS growth_indexing_host ON growth_indexing(host, submitted_at DESC);
    `,
  },

  {
    /*
      ASO — ONE ROW PER APP PER RUN.

      The store listing is audited the way a shopper reads it, so the row
      keeps the LISTING as it was read (title, subtitle, description length,
      screenshot count, rating) beside the checks that were computed from it.
      Two columns for one fact, deliberately: six months from now the checks
      may be different code, and a row that kept only its verdicts could not
      be re-scored.

      `score` AND `grade` ARE NULLABLE AND THAT IS THE POINT. A listing where
      fewer than three dimensions could be scored is refused rather than
      graded, and the refusal sentence is stored in `refusal`. A grade
      computed from two checks would be a confident number about a listing
      nobody could read.

      `store` IS 'appstore' OR 'play' and never merged. The two stores index
      different fields — Play reads the full description for search, Apple
      reads the name, the subtitle and a 100-BYTE keyword field and ignores
      the description entirely — so the same advice is wrong on one of them.
    */
    name: "153_growth_aso",
    sql: `
      CREATE TABLE IF NOT EXISTS growth_aso (
        run_id     TEXT NOT NULL,
        venture_id TEXT NOT NULL,
        store      TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        name       TEXT,
        listing    TEXT NOT NULL DEFAULT '{}',
        checks     TEXT NOT NULL DEFAULT '[]',
        dimensions TEXT NOT NULL DEFAULT '{}',
        score      INTEGER,
        grade      TEXT,
        coverage   REAL,
        refusal    TEXT,
        competitors TEXT NOT NULL DEFAULT '[]',
        ts         TEXT NOT NULL,
        PRIMARY KEY (run_id, store, app_id)
      );
      CREATE INDEX IF NOT EXISTS growth_aso_venture ON growth_aso(venture_id, ts DESC);
    `,
  },
];
