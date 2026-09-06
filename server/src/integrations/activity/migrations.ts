/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "130_activity_users",
    sql: `
      -- THE PEOPLE, ONE ROW EACH, FROM THE PRODUCT'S OWN MOUTH.
      --
      -- Every other integration on this box reads a platform: Stripe knows who
      -- paid, Umami knows who visited. Neither knows who SIGNED UP, because a
      -- signup is an event inside an application and no vendor is told about
      -- it. The application is, so the application publishes it — a JSON
      -- document at a URL, one account per product, the contract written down
      -- in integrations/activity/users.ts.
      --
      -- WHY THE ADDRESS IS A HASH AND NOT AN ADDRESS. This table exists to
      -- answer "how many, when, and on which plan"; not one of those questions
      -- needs to know that somebody is called mary@example.com. What the
      -- address IS needed for is identity across collections — the same person
      -- read twice must be one row — and a hash does that exactly as well.
      -- The salt is per install (131_activity_salt) so the hashes are not
      -- comparable with any other copy of this app, and there is deliberately
      -- no route, no filter and no search that takes an address: a lookup by
      -- address is precisely the capability being declined here.
      --
      -- \`email_domain\` IS KEPT IN THE CLEAR and that is not a contradiction.
      -- "gmail.com" identifies nobody and is the one thing about an address
      -- worth a chart — free mail against company mail is the whole of the
      -- consumer/business question for most products.
      --
      -- \`created_at\` IS THE ROW'S OWN, as the product reported it, and it is
      -- the only timestamp here that is a measurement rather than a
      -- collection. \`seen_at\` is when THIS box last read the row; the two are
      -- never mixed and no window is ever computed from seen_at.
      --
      -- NOTHING IS EVER DELETED BY A COLLECTION. A product that publishes only
      -- its newest hundred users must not cause the older ones to vanish, so
      -- this is an upsert and never a replace. The consequence is stated on
      -- the route: a count of rows here is a floor, and \`total\` from the
      -- document wins whenever the document has one.
      CREATE TABLE activity_users (
        account_id   INTEGER NOT NULL,
        -- The account's label at the time it was read. A caption, allowed to
        -- go stale on a rename, the way venture_links' label is.
        product      TEXT NOT NULL,
        -- The product's own id for this person. Opaque to us.
        user_id      TEXT NOT NULL,
        -- sha256(salt + ":" + lowercased address). NULL means the document
        -- carried no address for this row, which is not the same as an empty
        -- one and is why this column is nullable.
        email_hash   TEXT,
        email_domain TEXT,
        created_at   TEXT NOT NULL,
        plan         TEXT,
        -- 1, 0, or NULL for "the product did not say". A product that does not
        -- publish \`paid\` has an unknown paid count, never a zero one.
        paid         INTEGER,
        last_seen    TEXT,
        country      TEXT,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, user_id)
      );
      CREATE INDEX activity_users_created ON activity_users(account_id, created_at DESC);
      CREATE INDEX activity_users_day ON activity_users(created_at);
    `,
  },

  {
    name: "131_activity_salt",
    sql: `
      -- THE ONE SECRET THIS AREA HOLDS, and it is not a credential.
      --
      -- It is the salt every address is hashed with, generated once on this
      -- install and never again. It is in its own table rather than in
      -- plugin_config for one reason: plugin_config is READ BACK BY A ROUTE
      -- (that is the entire difference between it and the vault), so a salt
      -- kept there would be published to the browser beside the settings it
      -- sits with. Nothing selects from this table except the hasher.
      --
      -- A ROW OF ONE, enforced by the check, because two salts would mean the
      -- same person hashing to two different rows and the identity this table
      -- is for silently breaking.
      CREATE TABLE activity_salt (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        salt       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },

  {
    name: "132_activity_user_days",
    sql: `
      -- ONE ROW PER PRODUCT PER DAY, AND TWO DIFFERENT FIGURES ON IT.
      --
      -- \`signups\` is how many rows this box holds whose own createdAt falls on
      -- that day. It is derived from activity_users and rebuilt for an account
      -- on every collection, so a product that back-fills its history changes
      -- the past here — which is correct, because the past it is changing is
      -- OUR knowledge of it, not the days themselves.
      --
      -- \`total\` is the product's own total as it stood the last time that day
      -- was collected. It exists for the products that cannot list their users
      -- at all and publish a count instead: those have no rows, therefore no
      -- signups, and a NULL in that column rather than a zero.
      --
      -- THE TWO ARE NEVER ADDED AND NEVER COMPARED. One is a count of events
      -- inside a day; the other is a level at the end of one. \`source\` says
      -- which kind of document the row came from so a reader never has to
      -- infer it from which column is null.
      CREATE TABLE activity_user_days (
        account_id INTEGER NOT NULL,
        day        TEXT NOT NULL,
        signups    INTEGER,
        total      INTEGER,
        -- 'rows' — counted from user rows we hold. 'counts' — the product
        -- published a count and no rows.
        source     TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (account_id, day)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "133_activity_user_docs",
    sql: `
      -- THE LAST DOCUMENT, AND WHY IT WAS REFUSED.
      --
      -- Same argument as product_docs one integration over, with one addition
      -- that matters more here: this document is validated against a published
      -- contract, and a document that FAILS validation must not replace the
      -- rows the last good one produced. A product that ships a bad deploy at
      -- four in the morning should cost the owner a red line on a page, not
      -- every user row he had.
      --
      -- So: the rows stay, \`error\` and \`problems\` say exactly which field is
      -- wrong, and \`doc\` keeps whichever document was last stored — with
      -- EVERY ADDRESS STRIPPED OUT before it is written. The panel shows this
      -- so a contract error can be read against the shape that caused it, and
      -- a debugging aid is not a reason to keep thousands of real addresses in
      -- a table that exists to avoid holding them.
      --
      -- \`shape\` is 'users' or 'counts' — which of the two forms of the
      -- contract this endpoint publishes. NULL before anything validated.
      CREATE TABLE activity_user_docs (
        account_id   INTEGER PRIMARY KEY,
        ts           TEXT NOT NULL,
        ok           INTEGER NOT NULL,
        status       INTEGER,
        ms           INTEGER,
        shape        TEXT,
        url          TEXT,
        doc          TEXT,
        -- How many user rows the last VALID document carried, and what it said
        -- its own total was. NULL for "it did not say".
        users        INTEGER,
        total        INTEGER,
        generated_at TEXT,
        error        TEXT,
        -- A JSON array of sentences, one per field that is wrong. Empty array
        -- when the document validated.
        problems     TEXT NOT NULL DEFAULT '[]'
      );
    `,
  },

  {
    name: "134_activity_events",
    sql: `
      -- THE ONE TABLE ON THIS BOX THAT IS ON THE TIME AXIS.
      --
      -- Every other table here is a set of current readings or a series of
      -- levels. This is a list of THINGS THAT HAPPENED, merged from the
      -- sources already being collected, so that "what changed this week" is a
      -- query rather than six pages read in sequence.
      --
      -- \`exact\` IS THE POINT OF THE WHOLE TABLE. Half of these sources
      -- publish a moment — a signup's own createdAt, a run's finished_at, a
      -- card's done_at, GitHub's pushed_at — and half publish a DAY: Stripe's
      -- charge and ledger tables are one row per UTC day per currency, so the
      -- best that can be said of a refund is which day it settled on. Those
      -- get exact = 0 and a ts at the start of their day, and every surface
      -- that draws them says "day" rather than printing an invented 00:00 as
      -- if somebody had observed it.
      --
      -- NOTHING HERE FABRICATES A TIMESTAMP. A source that cannot say when
      -- something happened does not appear at all — an active-subscription
      -- count going up is real and is not an event, because Stripe reports it
      -- as a level and the moment it moved was never recorded.
      --
      -- \`key\` IS THE DEDUPE KEY AND IT IS THE PRIMARY KEY, so the pass that
      -- fills this table is idempotent by construction: it runs every
      -- collection, re-derives everything in its window, and inserts what is
      -- not already here. A day row that Stripe later revises (a refund
      -- landing against an old charge) updates the event's title in place
      -- rather than adding a second one — the day is the event, and there is
      -- one of it.
      --
      -- \`venture_id\` HAS NO FOREIGN KEY, on the same argument agent_runs
      -- makes: a deleted business does not un-happen the events that were
      -- about it. It resolves to nothing and the feed draws them unfiled. It
      -- is NULL where the source genuinely cannot attribute — Stripe's day
      -- tables are per account and not per product, so nothing may pretend a
      -- day's charges belonged to one venture.
      CREATE TABLE activity_events (
        key        TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        exact      INTEGER NOT NULL,
        -- signup | charge | refund | dispute | payment_failed | run | card |
        -- push | alert. A closed set in practice, TEXT so a new source is a
        -- pass and not a migration.
        kind       TEXT NOT NULL,
        venture_id TEXT,
        -- The product or account this is about, as a caption. NULL where there
        -- is none.
        product    TEXT,
        title      TEXT NOT NULL,
        detail     TEXT NOT NULL DEFAULT '{}',
        -- Which pass produced it: 'users', 'stripe', 'runs', 'board',
        -- 'github', 'alerts'.
        source     TEXT NOT NULL,
        -- When this box first noticed. Never used as the event's time — it is
        -- here so "the feed went quiet" can be told from "the pass stopped".
        found_at   TEXT NOT NULL
      );
      CREATE INDEX activity_events_ts ON activity_events(ts DESC);
      CREATE INDEX activity_events_kind_ts ON activity_events(kind, ts DESC);
      CREATE INDEX activity_events_venture_ts ON activity_events(venture_id, ts DESC);
    `,
  },
];
