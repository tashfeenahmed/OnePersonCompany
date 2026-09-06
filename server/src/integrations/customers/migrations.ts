/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "250_stripe_disputes",
    sql: `
      -- THE CASES THEMSELVES, which this box did not have.
      --
      -- /api/activity/leakage said so out loud: "the COUNT is 0 because there
      -- is no dispute-level table on this box: the ledger records the debit,
      -- not the case." That sentence was true and it cost the two things a
      -- person actually needs — how many are open, and when the evidence is
      -- due. A ledger debit has no deadline on it.
      --
      -- THIS TABLE AND THE LEDGER ARE TWO MEASUREMENTS AND ARE NEVER ADDED.
      -- stripe_ledger_days.disputes is money that MOVED, dated by the balance
      -- posting, and it includes the fee Stripe charges whatever the outcome.
      -- A row here is a CASE, dated by when the cardholder's bank opened it,
      -- carrying the disputed amount and no fee at all. The same $60 can be a
      -- case opened in August and a debit posted in September; every document
      -- that shows both labels which is which.
      --
      -- amount IS IN MAJOR UNITS of its own currency, converted once on the
      -- way in, exactly like every other money column here. There is no
      -- exchange rate on this box and two currencies is two answers.
      --
      -- outcome IS NULL WHILE THE CASE IS LIVE and that is not "no outcome
      -- yet, assume we win". Stripe's own status is kept verbatim in status
      -- (needs_response, warning_needs_response, under_review, won, lost,
      -- warning_closed…) because it is the word the risk page uses; outcome
      -- is the derived two-way collapse of it — won | lost | NULL — and every
      -- count that reads it says which of the two it counted.
      --
      -- closed_at IS WHEN THIS BOX FIRST SAW A TERMINAL STATUS, not when
      -- Stripe closed the case. Stripe publishes no closed timestamp on the
      -- dispute object, so inventing one from \`created\` plus a guess would be
      -- a date somebody quotes. It is null until a walk sees the case settled,
      -- and it is only ever as precise as the collection interval.
      CREATE TABLE IF NOT EXISTS stripe_disputes (
        id                   TEXT PRIMARY KEY,
        account_id           INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        account_label        TEXT NOT NULL,
        charge               TEXT,
        payment_intent       TEXT,
        amount               REAL NOT NULL,
        currency             TEXT NOT NULL,
        reason               TEXT,
        status               TEXT NOT NULL,
        -- ISO 8601 UTC. Stripe gives it as a unix second and it is the one
        -- date on this row somebody has to act before.
        evidence_due_by      TEXT,
        submission_count     INTEGER,
        is_charge_refundable INTEGER,
        created_at           TEXT NOT NULL,
        closed_at            TEXT,
        outcome              TEXT,
        -- Which business this belongs to, when it can be established. NULL is
        -- "could not be attributed", never "the owner's default venture" —
        -- see customers/venture.ts for the two rules that produce it.
        venture_id           TEXT,
        seen_at              TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stripe_disputes_status ON stripe_disputes(status);
      CREATE INDEX IF NOT EXISTS stripe_disputes_due ON stripe_disputes(evidence_due_by);
      CREATE INDEX IF NOT EXISTS stripe_disputes_created ON stripe_disputes(created_at);
      CREATE INDEX IF NOT EXISTS stripe_disputes_account ON stripe_disputes(account_id);

      -- WHERE EACH WALK GOT TO, per account per kind.
      --
      -- In the database rather than in a variable for the reason stripe_state
      -- gives: this process restarts far more often than a Stripe account is
      -- added, and a cursor held in memory would re-walk from the beginning
      -- every time somebody saved a file. \`value\` is a unix second for the
      -- event walk and a UTC day for the dispute walk; the writer of each
      -- kind owns its meaning and no reader shares one across kinds.
      CREATE TABLE IF NOT EXISTS customers_cursor (
        kind       TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        value      TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, account_id)
      );
    `,
  },

  {
    name: "251_customer_cases",
    sql: `
      -- ONE ROW PER THING A PERSON COULD STILL DO SOMETHING ABOUT.
      --
      -- Every other revenue table on this box is a measurement: a day of
      -- charges, a book of subscriptions, a ledger of settlements. None of
      -- them has a state a person moves, and none of them has a DEADLINE. A
      -- subscription that cancels at the end of the period, an invoice on its
      -- third retry and a dispute whose evidence is due on Thursday are three
      -- rows in three tables that share exactly one property: there is a date
      -- after which nothing can be done, and it has not passed yet.
      --
      -- THE ID IS DETERMINISTIC — "<kind>:<subject_ref>" — and that is what
      -- makes this table safe to rebuild on every pass. The pass re-derives
      -- what is open from the Stripe tables and upserts; a case that was
      -- already here keeps its status, its resolution and its draft, and a
      -- case that has gone away is resolved rather than deleted. Nothing
      -- accumulates duplicates and nothing loses the owner's decision.
      --
      -- context IS JSON AND IT IS ONLY FACTS THAT WERE READ. Plan name,
      -- amount, currency, dates, attempt counts, Stripe's own status and
      -- cancellation reason. There is no sentiment, no predicted lifetime
      -- value and no suggested discount in it, because the draft this table
      -- prepares is built from these fields and nothing else — a field that
      -- held a guess would become a sentence in a message to a customer.
      --
      -- THE ADDRESS COLUMNS, AND WHY THERE ARE THREE.
      --
      -- email_hash and email_domain follow the policy activity/users.ts set
      -- and this area does not get to re-open: the hash is salted per install
      -- and identifies a person across collections without being reversible,
      -- and the domain identifies nobody and is the only part worth a chart.
      -- email_plain is the exception the recovery queue needs to exist at all
      -- — a follow-up has to be addressed to somebody — and it is written
      -- ONLY while the documented \`customers.contact-access\` setting is on.
      -- Off is the default, off means the column is nulled on the next pass,
      -- and the routes never publish it while the setting is off even if a
      -- value survived in the row. Three columns rather than one because
      -- "we know who this is", "we may show who this is" and "we may write to
      -- them" are three different permissions.
      --
      -- status: open | drafted | sent | resolved | dismissed.
      --   drafted is a follow-up written INTO THE OUTBOX and waiting for the
      --   owner there. It is not sent, and this table cannot send anything:
      --   outbox_id is a pointer to a row in mailflow_outbox whose approval
      --   button is the only door out of this box.
      --   sent is set when that outbox row leaves.
      --   resolved is the case ending well — the subscription active again,
      --   the invoice paid, the dispute closed — and it is written by the
      --   pass from Stripe's own state as often as by a person.
      --   dismissed is the owner saying "not this one". It is never re-opened
      --   by the pass, which is the whole point of it being a separate word.
      CREATE TABLE IF NOT EXISTS customer_cases (
        id            TEXT PRIMARY KEY,
        venture_id    TEXT,
        account_id    INTEGER NOT NULL,
        account_label TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('churn','payment_failed','dispute','trial_ending')),
        -- Stripe's own customer id, or NULL where the object carried none.
        customer      TEXT,
        email_hash    TEXT,
        email_domain  TEXT,
        email_plain   TEXT,
        -- The Stripe object this case is ABOUT: sub_… , in_… or du_… . Half
        -- of the primary key, and the handle every auto-resolution uses.
        subject_ref   TEXT NOT NULL,
        amount        REAL,
        currency      TEXT,
        -- ISO 8601 UTC. NULL means this case has no deadline at all, which is
        -- a real state (a cancellation already ended) and never "due now".
        deadline      TEXT,
        -- Which date that is, in the words Stripe uses for it, so nobody has
        -- to infer whether Thursday is a retry or an evidence cut-off.
        deadline_is   TEXT,
        context       TEXT NOT NULL,
        status        TEXT NOT NULL CHECK(status IN ('open','drafted','sent','resolved','dismissed')),
        resolution    TEXT,
        outbox_id     INTEGER,
        opened_at     TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        resolved_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS customer_cases_queue ON customer_cases(status, deadline);
      CREATE INDEX IF NOT EXISTS customer_cases_kind ON customer_cases(kind, status);
      CREATE INDEX IF NOT EXISTS customer_cases_venture ON customer_cases(venture_id);
    `,
  },

  {
    name: "252_business_events",
    sql: `
      -- THE EVENT CURSOR'S LEDGER: one row per Stripe event, and whether the
      -- owner was actually told.
      --
      -- WHY A TABLE AND NOT A CALL TO notify(). A push with no row behind it
      -- has three failure modes nobody can see: it was sent twice, it was
      -- never sent because Telegram was down for ninety seconds, or it was
      -- sent at three in the morning. Each of those is a column here, and the
      -- undelivered view is the answer to "did I miss anything".
      --
      -- THE PRIMARY KEY IS STRIPE'S OWN EVENT ID, so the walk can overlap its
      -- own window as much as it likes and an event can only ever be
      -- delivered once. That is the whole dedupe: an INSERT OR IGNORE.
      --
      -- suppressed_by IS A SENTENCE AND NOT A BOOLEAN, because there are four
      -- reasons an event correctly produces no message and they are not
      -- interchangeable:
      --   "first collection"  — history ingested when the cursor was empty.
      --                         Real events, never announced, because nobody
      --                         asked to be told about last night on Tuesday.
      --   "collapsed into <id>" — one of N failures for the same customer in
      --                         the same hour. The survivor's message says
      --                         how many it stands for.
      --   "alert <n> (<rule>)" — an aggregate alert already covered this
      --                         class in this window. One event, one message.
      --   "type muted"        — the owner turned this type off.
      -- muted is the flag those all set; suppressed_by is why, and both are
      -- published, because "you were not told" is a fact about the tool.
      --
      -- deferred_until IS QUIET HOURS AND IS NOT SUPPRESSION. The event is
      -- still going to be delivered; it is waiting for a civil hour in the
      -- owner's own zone. A deferred event that is then collapsed or muted
      -- goes the way of the others.
      CREATE TABLE IF NOT EXISTS business_events (
        id             TEXT PRIMARY KEY,
        account_id     INTEGER NOT NULL,
        account_label  TEXT NOT NULL,
        venture_id     TEXT,
        type           TEXT NOT NULL,
        -- ISO 8601 UTC, Stripe's own \`created\` for the event.
        at             TEXT NOT NULL,
        -- One factual sentence, assembled from the payload's own fields. No
        -- model wrote it and no model is asked to.
        summary        TEXT NOT NULL,
        -- The payload reference: what the event is about, kept as the id and
        -- the type rather than as a copy of the object. A stored copy would
        -- be a second, ageing version of a row Stripe already owns.
        object_id      TEXT,
        object_type    TEXT,
        customer       TEXT,
        amount         REAL,
        currency       TEXT,
        delivered_at   TEXT,
        delivery_error TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        muted          INTEGER NOT NULL DEFAULT 0,
        suppressed_by  TEXT,
        deferred_until TEXT,
        seen_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS business_events_at ON business_events(at);
      CREATE INDEX IF NOT EXISTS business_events_pending
        ON business_events(delivered_at, muted, at);
      CREATE INDEX IF NOT EXISTS business_events_type ON business_events(type, at);

      -- Types the owner has switched off. A row here is a decision, so it is
      -- stored rather than derived, and un-muting is deleting the row.
      CREATE TABLE IF NOT EXISTS business_event_mutes (
        type       TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `,
  },
];
