/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "290_migrate_population",
    sql: `
      -- WHICH POPULATION A USER ROW BELONGS TO, and whether anybody may write
      -- to them.
      --
      -- The users contract published in integrations/activity/users.ts asks a
      -- product for its signups and says nothing about WHO those people are to
      -- the business. That was fine while every product meant the same thing by
      -- "user". It is not fine across a portfolio: one product's table holds
      -- paying customers, another's holds people who were invited into somebody
      -- else's session and never bought anything, and a third's holds the
      -- owner's own staff logins. Summing those three into "users" produces a
      -- headline number that is true of nothing.
      --
      -- FIVE VALUES, AND THEY ARE THE ONES A BUSINESS ACTUALLY DISTINGUISHES:
      --   customer     — signed up for this product on their own behalf
      --   participant  — present because somebody else invited them
      --   admin        — operates the product
      --   trial        — signed up and has not paid, where the product tracks that
      --   internal     — the owner's own accounts, test rows, seed data
      -- NULL means the document did not say, and the reader treats a missing
      -- population as 'customer' — see users.ts. That default is what makes the
      -- extension backwards compatible: every endpoint written against the old
      -- contract keeps meaning exactly what it meant.
      --
      -- CONTACT_PERMITTED IS NOT DERIVED FROM ANYTHING. It is 0 unless the
      -- adapter was configured with an explicit consent mapping, because the
      -- only honest source for "may I write to this person" is the product's
      -- own consent record. A column that inferred it from "we have an address"
      -- would be this box quietly deciding that possession is permission.
      -- Nothing here stores an address either way: activity_users keeps a
      -- salted hash and no route takes one back.
      ALTER TABLE activity_users ADD COLUMN population TEXT;
      ALTER TABLE activity_users ADD COLUMN contact_permitted INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS activity_users_population
        ON activity_users(account_id, population);
    `,
  },

  {
    name: "291_migrate_batches",
    sql: `
      -- ONE IMPORT, START TO FINISH.
      --
      -- Every row an import writes anywhere in this database is stamped with
      -- this table's id, and that is the only reason rollback can exist: an
      -- importer that merged rows into place without recording which ones it
      -- added has performed an operation nobody can undo, and telling somebody
      -- "restore the backup" is not an undo, it is a loss of everything that
      -- happened since.
      --
      -- A DRY RUN IS A BATCH TOO. It writes no rows anywhere else, and it is
      -- recorded here because the counts it produced are the thing the owner
      -- read before deciding, and a decision worth making is worth being able
      -- to look up afterwards.
      CREATE TABLE IF NOT EXISTS migrate_batches (
        id           TEXT PRIMARY KEY,
        -- The directory that was read. Kept verbatim: a batch is a statement
        -- about one snapshot of one machine's state, and "which folder" is
        -- half of what makes it identifiable a year later.
        source       TEXT NOT NULL,
        -- 'workdash' today. A column rather than a constant because the id map
        -- and the rollback are not specific to WorkDash and a second importer
        -- would reuse all of this.
        kind         TEXT NOT NULL DEFAULT 'workdash',
        dry_run      INTEGER NOT NULL DEFAULT 0,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        -- The kinds actually attempted, comma separated, as asked for on the
        -- command line. A batch that imported only chats must not look like a
        -- batch that imported everything and found no cards.
        kinds        TEXT NOT NULL DEFAULT '',
        -- { kind: { read, imported, skipped, conflicts } } as JSON. One column
        -- rather than a table: it is read whole, with the row, always.
        counts       TEXT NOT NULL DEFAULT '{}',
        -- Problems worth reading, as a JSON array of sentences.
        problems     TEXT NOT NULL DEFAULT '[]',
        -- The archive written before the first insert. NULL on a dry run and
        -- on a run where the backup failed — in which case the run did not
        -- happen either, see cli/import-workdash.ts.
        backup       TEXT,
        ok           INTEGER,
        error        TEXT,
        rolled_back_at TEXT
      );
      CREATE INDEX IF NOT EXISTS migrate_batches_started
        ON migrate_batches(started_at DESC);
    `,
  },

  {
    name: "292_migrate_id_map",
    sql: `
      -- SOURCE ID → TARGET ID, one row per thing carried across.
      --
      -- This is the spine of the whole importer and it does three jobs that
      -- would otherwise need three mechanisms. It makes the import IDEMPOTENT:
      -- a second run of the same directory finds the mapping and updates rather
      -- than duplicating. It makes it REFERENTIAL: a WorkDash card naming a
      -- WorkDash project resolves to the venture that project became, without
      -- the importer holding the whole graph in memory. And it makes it
      -- REVERSIBLE: rollback reads this table and deletes exactly the target
      -- rows this batch created, in the order that respects foreign keys.
      --
      -- (source_kind, source_id) IS UNIQUE, not (batch, source_kind, source_id).
      -- The same WorkDash project imported twice is one venture, and a mapping
      -- table that allowed two answers would be a table you cannot look
      -- anything up in.
      CREATE TABLE IF NOT EXISTS migrate_id_map (
        source_kind TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        batch       TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        -- 0 when the row already existed and this batch only pointed at it.
        -- Rollback deletes what it CREATED and never what it merely matched:
        -- undoing an import must not remove a venture the owner typed himself
        -- because a WorkDash project happened to share its slug.
        created     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (source_kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS migrate_id_map_batch
        ON migrate_id_map(batch, target_kind);
    `,
  },

  {
    name: "293_migrate_history",
    sql: `
      -- METRIC HISTORY THAT COULD NOT BE PUT WHERE IT BELONGS.
      --
      -- WHY THERE IS A SECOND HOME FOR THIS AT ALL. The daily tables on this
      -- box — stripe_charge_days, umami_days, play_sales, appstore_sales — are
      -- keyed by a plugin ACCOUNT, because a figure only means something beside
      -- the credential that fetched it. History imported out of another
      -- application has no such account: nobody can say which of today's Stripe
      -- keys produced a number recorded eighteen months ago, and inventing an
      -- account_id to make the insert succeed would attach somebody else's
      -- arithmetic to a live credential forever.
      --
      -- Worse, the units frequently disagree. A predecessor that stored a
      -- running total where this box stores a daily delta, or a month where
      -- this box stores a day, produces rows that are individually plausible
      -- and collectively a lie — and the chart that draws them has no way to
      -- know.
      --
      -- SO THE RULE IS: a source lands in its real table ONLY where the units
      -- and the window match exactly and the target row is not account-keyed.
      -- Everything else lands here, tagged with where it came from and what it
      -- was called there, visible on the migration page, and NEVER joined into
      -- a live chart. That is a smaller promise than "your history moved" and
      -- it is the one that is true.
      CREATE TABLE IF NOT EXISTS migrate_history (
        batch      TEXT NOT NULL,
        -- 'stripe' | 'umami' | 'gsc' | 'play' | 'appstore' | whatever the file
        -- was called. The predecessor's own word, not a translation.
        source     TEXT NOT NULL,
        -- The predecessor's own name for the figure.
        metric     TEXT NOT NULL,
        -- The subject: a site, a package, an app id, a currency. '' when the
        -- source published one series with no subject.
        subject    TEXT NOT NULL DEFAULT '',
        -- 'YYYY-MM-DD' or 'YYYY-MM'. Stored as written; the window column says which.
        period     TEXT NOT NULL,
        -- 'day' | 'month' | 'unknown'. The one thing a reader must not guess.
        window     TEXT NOT NULL DEFAULT 'unknown',
        value      REAL NOT NULL,
        -- The unit in the source's own words, or NULL where it did not say —
        -- and NULL is left alone rather than filled in with a guess, because a
        -- caption invented here is a caption on somebody else's number.
        unit       TEXT,
        -- Why this did not go into the live table. One sentence, kept with the
        -- row so the page can explain each one rather than one blanket note.
        reason     TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        PRIMARY KEY (batch, source, metric, subject, period)
      );
      CREATE INDEX IF NOT EXISTS migrate_history_source
        ON migrate_history(source, period);
    `,
  },

  {
    name: "294_migrate_files",
    sql: `
      -- EVERY FILE A BATCH COPIED IN, so a rollback can take it out again.
      --
      -- Rows are easy to undo and files are not: a studio image copied into
      -- data/studio has the same name shape as one this box generated, and a
      -- rollback that deleted by pattern would take the owner's own work with
      -- it. So each copy is written down, with the byte count it had when it
      -- landed. Rollback removes a file only if it is still exactly that size —
      -- a file somebody has since replaced is left alone and reported, because
      -- an undo is allowed to fail loudly and is never allowed to delete
      -- something it did not create.
      CREATE TABLE IF NOT EXISTS migrate_files (
        batch       TEXT NOT NULL,
        -- Absolute, inside this data directory.
        path        TEXT NOT NULL,
        source_path TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        target_kind TEXT NOT NULL,
        target_id   TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        PRIMARY KEY (batch, path)
      );
    `,
  },

  {
    name: "295_migrate_validations",
    sql: `
      -- WHAT AN ADAPTER LAST SENT, AND WHETHER IT WAS ACCEPTABLE.
      --
      -- The adapter templates in deploy/adapters/ run on the product's own
      -- host, on the product's own cron, and their output is a JSON document
      -- this box only sees at collection time. That is a slow feedback loop:
      -- somebody edits a mapping, and finds out at four in the morning that a
      -- column was renamed. POST /api/migrate/adapters/validate closes it — a
      -- sample payload is checked against the live contract and the answer is
      -- the same sentences the collector would produce — and this table keeps
      -- the last answer per endpoint so the page can say which adapters have
      -- been checked and which never have.
      --
      -- ONE ROW PER ENDPOINT NAME, replaced. A history of validations is a log
      -- of somebody's afternoon; what matters on a page is the current state of
      -- each mapping.
      CREATE TABLE IF NOT EXISTS migrate_validations (
        -- The endpoint's label. Matched against a product-stats or users
        -- account label where one exists, and free text where it does not —
        -- an adapter is legitimately validated before it is connected.
        endpoint    TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        -- 'users' | 'stats'. Which contract was checked.
        contract    TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        -- 'users' | 'counts' | NULL when it did not parse.
        shape       TEXT,
        rows        INTEGER,
        total       INTEGER,
        -- JSON array of sentences, exactly as the validator produced them.
        problems    TEXT NOT NULL DEFAULT '[]',
        -- JSON { customer, participant, admin, trial, internal, unstated }.
        populations TEXT NOT NULL DEFAULT '{}',
        contactable INTEGER,
        bytes       INTEGER
      );
    `,
  },
];
