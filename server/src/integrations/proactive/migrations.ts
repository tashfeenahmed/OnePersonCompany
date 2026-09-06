/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "100_alert_rules",
    sql: `
      -- A RULE IS A COMPARISON THE OWNER WROTE DOWN, AND NOTHING MORE.
      --
      -- That sentence is the whole design and it is why this table holds no
      -- thresholds of its own, no severities and no notion of "healthy". Every
      -- other alerting product on earth ships with an opinion about what a
      -- normal disk looks like; this one cannot have one, because it does not
      -- know what business it is watching. What it knows is that somebody
      -- typed "disk > 85" and meant it.
      --
      -- SO A RULE ADDRESSES A DOCUMENT THE SAME WAY AN AGENT DOES: a skill id,
      -- a view key and the parameters that view takes — which is exactly the
      -- catalogue "GET /api/skills" publishes. The engine then reads that
      -- document over loopback HTTP, byte for byte the request "opc" makes.
      -- The consequence is the point: this table has no private knowledge of
      -- any other table in this database, so a rule can be written against a
      -- plugin that was added after this file, and an integration that changes
      -- its storage changes nothing here.
      --
      -- "path" IS A DOT PATH INTO THAT DOCUMENT, with [0] for an array index
      -- and @count(...) for the length of a list — the same syntax the product
      -- endpoints' metric mapping uses, deliberately, because an owner who has
      -- learned one of them has learned both.
      --
      -- "threshold" IS NULL FOR THE OPERATORS THAT DO NOT TAKE ONE. "changed"
      -- compares this reading with the last one; the two percentage operators
      -- carry their percentage in "threshold" and their window in
      -- "window_minutes". A comparison operator with a null threshold is a rule
      -- that cannot be evaluated, and the route refuses to store one.
      --
      -- "cooldown_minutes" IS WHY THIS IS USABLE. A rule that trips every
      -- thirty minutes for a week is a rule the owner turns off, and an alert
      -- nobody reads is worse than no alert. The engine will not raise a second
      -- trip for a rule inside its cooldown; the CONDITION is still true and
      -- the events list still says when it was first seen.
      --
      -- "seeded" MARKS A RULE THIS BOX WROTE RATHER THAN THE OWNER. It changes
      -- nothing about how a rule behaves — a seeded rule is edited and deleted
      -- exactly like a typed one — and it exists so the page can say "we
      -- suggested this" instead of letting the owner believe they configured
      -- something they never saw.
      CREATE TABLE IF NOT EXISTS alert_rules (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        skill            TEXT NOT NULL,
        view             TEXT NOT NULL DEFAULT 'default',
        -- JSON object of the view's own parameters, as the catalogue names
        -- them. '{}' for a view that takes none.
        params           TEXT NOT NULL DEFAULT '{}',
        path             TEXT NOT NULL,
        op               TEXT NOT NULL CHECK (op IN
                           ('<','<=','>','>=','==','!=','changed','dropped_by_pct','rose_by_pct')),
        threshold        REAL,
        -- Only read by dropped_by_pct / rose_by_pct: how far back the earlier
        -- reading is taken from. NULL means the operator does not use one.
        window_minutes   INTEGER,
        -- The venture this rule is ABOUT, or NULL for the whole business. It
        -- is a label on the finding, not a filter on the document: this table
        -- cannot narrow somebody else's route to one venture, and pretending
        -- otherwise would be an alert scoped to a venture whose figure came
        -- from all of them.
        venture_id       TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 360,
        seeded           INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        -- The last evaluation, whatever came of it. NULL means never asked.
        last_evaluated_at TEXT,
        -- The last value READ, which is not the same as the last value that
        -- tripped. NULL means the last read failed or has not happened.
        last_value       REAL,
        last_error       TEXT
      );

      CREATE INDEX IF NOT EXISTS alert_rules_enabled ON alert_rules(enabled, skill);
      CREATE INDEX IF NOT EXISTS alert_rules_venture ON alert_rules(venture_id);
    `,
  },

  {
    name: "101_alert_events",
    sql: `
      -- WHAT ACTUALLY HAPPENED, ONCE, WITH THE FIGURES THAT MADE IT HAPPEN.
      --
      -- "observed" and "previous" are stored rather than recomputed because
      -- they are the evidence: a document read at 09:31 cannot be read again,
      -- and an event that had to re-derive its own value would quietly change
      -- its story every time somebody opened the page.
      --
      -- "kind" HAS THREE VALUES AND THE SECOND ONE IS THE HONEST ONE.
      --   trip        the comparison the owner configured came out true
      --   unreadable  the document could not be read, or the path resolved to
      --               nothing. This is NOT a trip and must never be drawn as
      --               one: "Stripe did not answer" and "failed payments are
      --               over your limit" are different mornings.
      --   test        the owner pressed Test on the rule. Recorded so a value
      --               that was checked by hand is in the same ledger as one
      --               that was checked by the timer, and never acknowledged
      --               because there is nothing to acknowledge.
      --
      -- "narration" IS A MODEL'S SENTENCES ABOUT FIGURES THAT WERE READ, and
      -- it is nullable for exactly the reason every figure on this box is: a
      -- box with no model provider configured has no narration, and the
      -- "narration_note" beside it says so in words. Nothing here ever writes
      -- a plausible sentence in the absence of one.
      CREATE TABLE IF NOT EXISTS alert_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id       INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        ts            TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('trip','unreadable','test')),
        observed      REAL,
        previous      REAL,
        -- One sentence naming the rule, the figure and the comparison. Written
        -- by the engine, not by a model.
        message       TEXT NOT NULL,
        narration     TEXT,
        -- Why there is no narration, when there is none. NULL when there is.
        narration_note TEXT,
        acknowledged_at TEXT
      );

      CREATE INDEX IF NOT EXISTS alert_events_ts ON alert_events(ts DESC);
      CREATE INDEX IF NOT EXISTS alert_events_rule ON alert_events(rule_id, ts DESC);
      CREATE INDEX IF NOT EXISTS alert_events_open ON alert_events(acknowledged_at, ts DESC);
    `,
  },

  {
    name: "102_alert_observations",
    sql: `
      -- EVERY READING, SO THAT "DROPPED 50% VS LAST WEEK" HAS SOMETHING TO
      -- COMPARE WITH.
      --
      -- The two percentage operators need a value from the past, and the only
      -- honest source of one is a value this box actually read at the time.
      -- Re-deriving it — asking the document for "pageviews seven days ago" —
      -- would work for the handful of routes that carry history and silently
      -- fail for every route that carries only the present, which is most of
      -- them.
      --
      -- ONE ROW PER RULE PER EVALUATION, pruned to 30 days by the engine. That
      -- is roughly 48 rows a day per rule; a hundred rules is 144,000 rows a
      -- month, which is small. The window is 30 rather than 7 because a rule
      -- comparing against "the prior week" needs a fortnight before it can say
      -- anything at all, and a retention shorter than the longest window a
      -- rule can name would make that rule permanently unanswerable.
      CREATE TABLE IF NOT EXISTS alert_observations (
        rule_id  INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        ts       TEXT NOT NULL,
        value    REAL NOT NULL,
        PRIMARY KEY (rule_id, ts)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS alert_observations_ts ON alert_observations(ts);
    `,
  },

  {
    name: "103_alert_snapshots",
    sql: `
      -- WHAT ELSE WAS TRUE AT THE MOMENT A RULE TRIPPED.
      --
      -- A trip on its own is a number crossing a line. What makes it useful is
      -- the rest of the morning: revenue moved, a box filled up, traffic
      -- halved. So on every evaluation cycle this stores the summary view of a
      -- bounded set of connected skills, and when a rule trips the narrator
      -- diffs the newest snapshot against the previous one and hands the model
      -- ONLY the figures that actually changed.
      --
      -- THE WHOLE DOCUMENT IS STORED, NOT A SUMMARY OF IT. A summary written
      -- here would be this file deciding which figures matter for every
      -- integration that will ever exist, including ones nobody has written.
      -- The diff picks the headline numbers at read time, generically, out of
      -- whatever shape the document turned out to have.
      --
      -- SEVEN DAYS, pruned by the engine. These are the largest rows this area
      -- writes — a Stripe document is tens of kilobytes — and nothing reads one
      -- older than the previous cycle except a person debugging a narration.
      CREATE TABLE IF NOT EXISTS alert_snapshots (
        skill  TEXT NOT NULL,
        ts     TEXT NOT NULL,
        -- The document as the route answered it, verbatim JSON. NULL is never
        -- stored: a cycle that could not read a skill writes no row, so a gap
        -- here means "not read" rather than "read as empty".
        doc    TEXT NOT NULL,
        PRIMARY KEY (skill, ts)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS alert_snapshots_ts ON alert_snapshots(ts);
    `,
  },

  {
    name: "104_alert_seeds",
    sql: `
      -- WHICH PLUGINS HAVE ALREADY BEEN OFFERED THEIR DEFAULT RULES.
      --
      -- Seeding has to happen once per plugin and never again, and "has this
      -- been seeded" cannot be answered by looking at the rules table: the
      -- owner deleting a suggested rule is the owner saying no, and a seeder
      -- that read an empty table would put it straight back on the next
      -- restart. So the fact is recorded separately from the thing it created.
      --
      -- PER PLUGIN RATHER THAN GLOBALLY, so that connecting Stripe in March
      -- gets Stripe's suggestions in March rather than never — the defaults
      -- are only ever written for a plugin that is connected, because a rule
      -- against a disconnected skill is an "unreadable" event every half hour.
      CREATE TABLE IF NOT EXISTS alert_seeds (
        plugin    TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL,
        rules     INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "105_briefings",
    sql: `
      -- ONE DOCUMENT A DAY, AND THE FACTS IT WAS BUILT FROM.
      --
      -- "facts" IS STORED BESIDE "markdown" AND THAT IS THE WHOLE POINT OF
      -- THIS TABLE. The prose is written by a model; the facts are read from
      -- the same skills every other page reads. Keeping both means the page
      -- can show, under any sentence, the figures it came from — and a
      -- sentence with no fact behind it is visible as such. A briefing table
      -- holding only prose would be a machine writing confident paragraphs
      -- about a business with nothing to check them against.
      --
      -- THE KEY IS THE LOCAL DAY IN THE OWNER'S CONFIGURED TIME ZONE, which is
      -- what makes the scheduler idempotent across restarts: building "today"
      -- twice is one INSERT OR IGNORE, and a laptop that was shut at seven
      -- builds the morning's briefing when it wakes rather than skipping it.
      --
      -- "markdown" MAY BE EMPTY AND "note" SAYS WHY. A box with no model
      -- provider still assembles the facts — they are the honest half — and
      -- says in one sentence that nobody was available to write them up.
      CREATE TABLE IF NOT EXISTS briefings (
        day        TEXT PRIMARY KEY,
        built_at   TEXT NOT NULL,
        -- IANA zone the day was computed in, stored so a briefing does not
        -- change which day it belongs to when the setting changes.
        timezone   TEXT NOT NULL,
        markdown   TEXT NOT NULL DEFAULT '',
        -- JSON: the assembled facts, section by section.
        facts      TEXT NOT NULL DEFAULT '{}',
        model      TEXT,
        note       TEXT,
        -- Whether it reached each door. 0 is "not delivered", which for
        -- Telegram is usually "no bot is paired" rather than a failure.
        to_chat    INTEGER NOT NULL DEFAULT 0,
        to_telegram INTEGER NOT NULL DEFAULT 0,
        delivery_note TEXT
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS briefings_built ON briefings(built_at DESC);
    `,
  },
];
