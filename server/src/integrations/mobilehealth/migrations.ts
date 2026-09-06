/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "260_mobilehealth_dimensions",
    sql: `
      -- WHICH SEGMENTS ACQUIRE AND WHICH RETAIN — the question /api/mobile
      -- structurally cannot answer, because it reads only the two OVERVIEW
      -- exports and an overview is the answer with the segments removed.
      --
      -- ONE ROW IS ONE (app, day, dimension, value, metric). Not a wide table
      -- with a column per metric: Google's slices carry different metrics in
      -- different eras and Apple's analytics reports carry different ones
      -- again, and a wide table would have to invent a NULL column for every
      -- metric a report does not have — which is indistinguishable from a
      -- metric that was measured and came back empty.
      --
      -- \`unit\` IS STORED, NOT ASSUMED. Play's install slices count DEVICES;
      -- Apple's download report counts DOWNLOAD EVENTS with a privacy
      -- threshold under them. Two integers in the same column that mean
      -- different things is the exact mistake this column exists to stop, and
      -- every route that reads this table quotes the unit it found.
      --
      -- \`report\` is the object or report the row came out of, verbatim. It is
      -- how "where did this figure come from" is answered without a guess, and
      -- how a re-ingest of a revised month replaces exactly its own rows.
      --
      -- NOTHING HERE IS EVER SUMMED ACROSS \`metric\`. active_devices is a LEVEL
      -- (how many phones have it today) and installs is an EVENT; adding thirty
      -- days of the first counts one phone thirty times. The routes take the
      -- newest day for a level and sum only events, and the skill rules say so.
      CREATE TABLE IF NOT EXISTS mobile_dimensions (
        store      TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        app        TEXT NOT NULL,
        day        TEXT NOT NULL,
        dimension  TEXT NOT NULL,
        value      TEXT NOT NULL,
        metric     TEXT NOT NULL,
        amount     REAL NOT NULL,
        unit       TEXT NOT NULL,
        report     TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (store, account_id, app, day, dimension, value, metric)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mobile_dimensions_day
        ON mobile_dimensions(day);
      CREATE INDEX IF NOT EXISTS mobile_dimensions_app
        ON mobile_dimensions(store, app, dimension);
    `,
  },

  {
    name: "261_mobilehealth_conversion",
    sql: `
      -- LISTING CONVERSION, from Play's stats/store_performance/ export.
      --
      -- THE RATE IS STORED AS GOOGLE WROTE IT AND IS NEVER SUMMED. The export
      -- carries "Store listing conversion rate" per row as a fraction, and the
      -- rate for a window is acquisitions over visitors computed on the read —
      -- averaging thirty daily rates gives every day equal weight regardless
      -- of traffic, which is a different and wrong number. The stored rate is
      -- kept only so a reader can check ours against Google's on one day.
      --
      -- \`dimension\` is the slice the file was cut by ('country',
      -- 'traffic_source'), and there is no overview file in this era's bucket
      -- at all — the slices ARE the report, and the total is their sum because
      -- they partition the same visitors.
      CREATE TABLE IF NOT EXISTS mobile_store_performance (
        account_id   INTEGER NOT NULL,
        app          TEXT NOT NULL,
        day          TEXT NOT NULL,
        dimension    TEXT NOT NULL,
        value        TEXT NOT NULL,
        visitors     INTEGER,
        acquisitions INTEGER,
        rate         REAL,
        report       TEXT NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, app, day, dimension, value)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mobile_store_performance_day
        ON mobile_store_performance(day);

      -- RETAINED INSTALLERS, if the bucket carries them. On the account this
      -- was written against it does not — stats/retained_installers/ is simply
      -- absent — so this table stays empty and the route says "report not
      -- present in bucket" rather than drawing a retention curve of zeroes.
      --
      -- \`offset_days\` is the day of the curve (1, 7, 15, 30…), read out of the
      -- COLUMN NAME because Google spells those headers several ways. The
      -- denominator is the installers column from the SAME file: a rate is
      -- only ever computed against the cohort it belongs to.
      CREATE TABLE IF NOT EXISTS mobile_retention (
        account_id  INTEGER NOT NULL,
        app         TEXT NOT NULL,
        day         TEXT NOT NULL,
        offset_days INTEGER NOT NULL,
        retained    REAL,
        installers  REAL,
        report      TEXT NOT NULL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (account_id, app, day, offset_days)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "262_mobilehealth_reports",
    sql: `
      -- WHAT WAS ASKED FOR AND WHAT THE STORE SAID — the table that keeps an
      -- absence apart from a zero, one row per (store, account, app, report).
      --
      -- This is the same argument appstore_reports makes for sales days and it
      -- matters more here, because half of what this area asks for does not
      -- exist on a given account: Play writes a folder only for reports the
      -- console generates, Apple generates an analytics instance only once an
      -- app clears its privacy threshold, and both look identical to "the
      -- collector is broken" if nothing writes down which it was.
      --
      -- STATES, and each is a different sentence on a card:
      --   present      rows arrived and were ingested
      --   absent       the report is not in the bucket / Apple lists no such report
      --   empty        the report exists and carried no rows for the window
      --   requested    an ONGOING analytics request exists, nothing generated yet
      --   processing   Apple lists the report, no instance has been produced
      --   available    instances exist and were downloaded
      --   delayed      instances exist but none newer than the expected lag
      --   unauthorized the credential was refused for THIS report specifically
      --   error        anything else, with the provider's own sentence in detail
      --
      -- \`detail\` HOLDS THE PROVIDER'S OWN WORDS. "Google refused the bucket"
      -- written by us is a paraphrase; the 403's body names the role that is
      -- missing, and that sentence is what makes the next fix quick.
      CREATE TABLE IF NOT EXISTS mobile_report_state (
        store      TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        app        TEXT NOT NULL,
        report     TEXT NOT NULL,
        state      TEXT NOT NULL,
        detail     TEXT,
        rows       INTEGER,
        period     TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (store, account_id, app, report)
      ) WITHOUT ROWID;

      -- THE READINESS PROBE, one row per (store, account, probe). Separate
      -- from the table above because a probe is about the CREDENTIAL and a
      -- report is about the DATA: the Play Developer Reporting API can be
      -- switched off for the whole project while every install report in the
      -- bucket is fine, and the whole point of this area is that the first
      -- fact must never blank out the second.
      CREATE TABLE IF NOT EXISTS mobile_health_probes (
        store      TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        probe      TEXT NOT NULL,
        ok         INTEGER NOT NULL,
        status     INTEGER,
        error      TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (store, account_id, probe)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "263_mobilehealth_stability",
    sql: `
      -- CRASHES AND ANRs, dated, and with the source of each row named.
      --
      -- THREE SOURCES THAT ARE NOT THE SAME MEASUREMENT and are therefore
      -- never mixed in one series:
      --   play-bucket     stats/crashes/ — daily COUNTS of crashes and ANRs,
      --                   sliced by app version, device and OS version. A
      --                   count, with no denominator at all.
      --   play-reporting  the Play Developer Reporting API — daily RATES
      --                   (crashRate, anrRate) as a fraction of distinct
      --                   users, by version code. Independently permissioned.
      --   appstore        an App Store Connect analytics report, named in
      --                   \`source\` exactly as Apple names it.
      -- \`unit\` says which ('crashes', 'anrs', 'rate', 'users') and the routes
      -- refuse to put a count and a rate on the same axis.
      --
      -- \`dimension\`/\`value\` default to '(all)' for an overview row so one
      -- query shape serves both the headline and the breakdown.
      CREATE TABLE IF NOT EXISTS mobile_stability (
        store      TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        app        TEXT NOT NULL,
        day        TEXT NOT NULL,
        source     TEXT NOT NULL,
        metric     TEXT NOT NULL,
        dimension  TEXT NOT NULL,
        value      TEXT NOT NULL,
        amount     REAL,
        unit       TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (store, account_id, app, day, source, metric, dimension, value)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mobile_stability_day
        ON mobile_stability(day);
    `,
  },

  {
    name: "264_mobilehealth_reviews",
    sql: `
      -- THE REVIEWS THEMSELVES, both stores in one table, because "what are
      -- people complaining about" is one question and a page that had to join
      -- two tables would eventually join them wrongly.
      --
      -- PLAY'S API HANDS BACK ONLY THE LAST SEVEN DAYS and there is no way to
      -- ask for more, so this table is an ACCUMULATOR for Android: what the
      -- runs have caught since the day this area was switched on, never the
      -- app's all-time review list. Apple's customerReviews is paginated all
      -- the way back. That asymmetry is real, is not fixable, and every route
      -- that counts rows here says which store's rows it is counting.
      --
      -- \`author\` IS THE DISPLAY NAME THE STORE PUBLISHES BESIDE THE REVIEW —
      -- Play's authorName, Apple's reviewerNickname — and nothing else about a
      -- reviewer is stored: no id, no account, no device id. It is here
      -- because a reply, when a human writes one in the console, is addressed
      -- to a name, and a review inbox that cannot show one is a list of
      -- anonymous complaints.
      --
      -- REPLYING IS NOT IN THIS AREA. \`reply\` holds the developer reply the
      -- STORE already has, read only, so a triage list does not re-file a
      -- review somebody already answered. There is no route, no action and no
      -- skill here that writes one.
      CREATE TABLE IF NOT EXISTS mobile_reviews (
        store       TEXT NOT NULL,
        account_id  INTEGER NOT NULL,
        app         TEXT NOT NULL,
        id          TEXT NOT NULL,
        rating      INTEGER,
        title       TEXT,
        body        TEXT,
        author      TEXT,
        language    TEXT,
        territory   TEXT,
        app_version TEXT,
        device      TEXT,
        created     TEXT,
        updated     TEXT,
        reply       TEXT,
        replied_at  TEXT,
        first_seen  TEXT NOT NULL,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (store, app, id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mobile_reviews_created
        ON mobile_reviews(created);
      CREATE INDEX IF NOT EXISTS mobile_reviews_rating
        ON mobile_reviews(store, app, rating);

      -- WHICH REVIEWS WERE ALREADY FILED ONTO THE BOARD, so the same five
      -- one-star reviews do not become five identical cards over five runs of
      -- an agent that forgot. The card id is the board's own; if the card is
      -- deleted this row is a record that it once existed, which is the honest
      -- thing for it to be.
      CREATE TABLE IF NOT EXISTS mobile_review_cards (
        store      TEXT NOT NULL,
        app        TEXT NOT NULL,
        review_id  TEXT NOT NULL,
        card_id    INTEGER NOT NULL,
        filed_at   TEXT NOT NULL,
        PRIMARY KEY (store, app, review_id)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "265_mobilehealth_versions",
    sql: `
      -- VERSION-STATE HISTORY, one row per (app, version, day observed).
      --
      -- APPLE PUBLISHES A STATE AND NOT A HISTORY. /v1/appStoreVersions says
      -- what each version's state IS; nothing in the API says when it changed,
      -- so "how long was 1.0.2 in review" is unanswerable from a single read.
      -- Recording the state ONCE PER DAY OBSERVED builds the history the API
      -- withholds, at the resolution this box actually looks — which is why
      -- the column is called \`observed_on\` and not \`changed_on\`. A gap in the
      -- days is a day nobody collected, not a day the state was unknown.
      --
      -- BOTH VOCABULARIES ARE STORED. Apple returns appStoreState
      -- (READY_FOR_SALE, WAITING_FOR_REVIEW…) and the newer appVersionState
      -- (READY_FOR_DISTRIBUTION…) on the same resource and they do not always
      -- agree in shape; \`state\` is the newer one where present, \`store_state\`
      -- is the older one verbatim, and \`phase\` is this box's own reduction to
      -- live | pending | in review | rejected | other — which is a DERIVED
      -- column and is labelled as one wherever it is read.
      CREATE TABLE IF NOT EXISTS mobile_versions (
        store       TEXT NOT NULL,
        account_id  INTEGER NOT NULL,
        app         TEXT NOT NULL,
        version     TEXT NOT NULL,
        observed_on TEXT NOT NULL,
        platform    TEXT,
        state       TEXT,
        store_state TEXT,
        phase       TEXT,
        created     TEXT,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (store, account_id, app, version, observed_on)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mobile_versions_observed
        ON mobile_versions(observed_on);
    `,
  },

  {
    name: "266_mobilehealth_analytics",
    sql: `
      -- WHICH APP STORE CONNECT ANALYTICS INSTANCES HAVE BEEN DOWNLOADED.
      --
      -- Apple's analytics pipeline is four resources deep — a request, its
      -- reports, each report's daily instances, each instance's segments — and
      -- an instance's CSV never changes once it exists. So the cost of this
      -- pipeline after the first run is one listing per report, provided
      -- something remembers which instance ids are already in. That is this
      -- table, and nothing else.
      CREATE TABLE IF NOT EXISTS mobile_analytics_instances (
        account_id  INTEGER NOT NULL,
        app         TEXT NOT NULL,
        report      TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        processed   TEXT,
        rows        INTEGER,
        bytes       INTEGER,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (account_id, app, report, instance_id)
      ) WITHOUT ROWID;
    `,
  },
];
