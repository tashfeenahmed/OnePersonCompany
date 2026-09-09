/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "120_mailflow_triage",
    sql: `
      -- ONE ROW PER THREAD PER MAILBOX, AND IT HOLDS A JUDGEMENT RATHER THAN
      -- A MESSAGE.
      --
      -- THERE IS NO subject COLUMN, NO from COLUMN AND NO snippet COLUMN, and
      -- that absence is the whole privacy claim of this table. routes/mail.ts
      -- earned the same claim structurally — its schema has nowhere to put a
      -- subject — and this table keeps it: what lands here is the model's
      -- reading of a thread (a category, one line of reason, an urgency, a
      -- venture guess) and never a line of the thread itself. Everything the
      -- Triage page SHOWS — subject, sender, snippet, time — is fetched live
      -- from Gmail on the read and joined to these rows by thread id, exactly
      -- as routes/mailbox.ts does, so closing the page forgets the mail and
      -- keeps the judgement.
      --
      -- WHY thread_id IS NOT THE KEY ON ITS OWN. Gmail issues thread ids per
      -- mailbox, so two connected Google accounts CAN hand out the same id.
      -- The key is (account_id, thread_id), which is the previous system's
      -- account|id written as a primary key instead of a string.
      --
      -- at_ms IS THE THREAD'S LAST-MESSAGE TIME AS IT WAS WHEN THE SCORE WAS
      -- MADE, and it is stored so that a reply can INVALIDATE the score
      -- without deleting it. A thread that was safely "fyi" yesterday is a
      -- different thing once the customer has answered it, so the route
      -- compares this against the live listing and marks the row stale rather
      -- than quoting an old sentence about a new conversation.
      --
      -- score IS ONE OF needs_reply | waiting_on_them | fyi | noise, and a
      -- thread with NO ROW HERE IS NOT "noise". It is unscored — the pass has
      -- not reached it, or there was no model to ask — and the route says so
      -- with its own group. Silence is never read as a verdict.
      --
      -- score IS NULLABLE for exactly one case: the owner pressed Done or
      -- Snooze on a thread the model had not read yet. That row exists to
      -- carry his verb, and giving it a category to make the column NOT NULL
      -- would be this schema inventing the model's opinion. NULL here means
      -- "unscored", the same as no row at all.
      CREATE TABLE IF NOT EXISTS mailflow_triage (
        account_id    INTEGER NOT NULL,
        thread_id     TEXT    NOT NULL,
        score         TEXT,
        -- One line, the model's own words, shown beside the score. Never a
        -- quote of the mail: the prompt asks for a reason, and the reason is
        -- what makes a category arguable instead of oracular.
        reason        TEXT,
        -- high | normal | low. The model's, and only meaningful inside its
        -- own category — an urgent piece of noise is still noise.
        urgency       TEXT,
        -- The venture id this thread is about, or NULL for "no venture
        -- matched". NULL is not "personal"; it is "nothing here said".
        venture       TEXT,
        -- How the venture was decided: 'host' (a domain in the thread's
        -- recipients or sender matched a venture's own host — a fact) or
        -- 'model' (the model named one — a guess). NULL where venture is.
        venture_by    TEXT,
        at_ms         INTEGER,
        scored_at     TEXT,
        -- Which model said it, so a row can be read back against the provider
        -- that produced it. NULL where the provider named none.
        model         TEXT,
        -- The owner's two verbs. done_at is "I have dealt with this";
        -- snoozed_until is "not before this instant". Both are the owner's,
        -- never the model's, and neither deletes the score.
        snoozed_until TEXT,
        done_at       TEXT,
        PRIMARY KEY (account_id, thread_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS mailflow_triage_scored ON mailflow_triage(scored_at);

      -- WHEN THE LAST PASS RAN, PER MAILBOX. One row, replaced. It is not the
      -- runs ledger on purpose: this area registers no collector (see
      -- manifest.ts on why it must not clobber the built-in gmail one), so
      -- there is no plugin whose run history this would belong in, and a page
      -- that cannot say "scored 20 minutes ago" is a page showing figures of
      -- unknown age.
      CREATE TABLE IF NOT EXISTS mailflow_triage_runs (
        account_id INTEGER NOT NULL PRIMARY KEY,
        ran_at     TEXT    NOT NULL,
        ok         INTEGER NOT NULL,
        threads    INTEGER NOT NULL,
        scored     INTEGER NOT NULL,
        note       TEXT,
        error      TEXT
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "121_mailflow_outbox",
    sql: `
      -- MAIL THIS BOX HAS WRITTEN. Whether any of it has LEFT is a column,
      -- and the column is what the owner presses.
      --
      -- The one property this table exists to hold: a row moves
      -- draft -> approved -> sent, and only a person moves it from draft to
      -- approved. Nothing else here is interesting. created_by records
      -- whether the words were the agent's or the owner's, and it is not
      -- permission — an agent-written row and an owner-written row are both
      -- drafts and both wait.
      --
      -- THE BODY IS MARKDOWN AND IS STORED, unlike everything in the triage
      -- table next door. It has to be: it is not somebody else's mail, it is
      -- a document this box composed and the owner has to be able to read it
      -- before he stands behind it. A draft nobody can see is a draft nobody
      -- can approve.
      --
      -- status: draft | approved | sent | dismissed | failed.
      --   failed is a SEND that was attempted and refused by Gmail, with the
      --   reason in error. It is not "not sent yet" — a failed row was
      --   approved, went out over the wire and came back, and whether a copy
      --   arrived is Google's answer rather than this table's, so it is a
      --   terminal state a person re-reads rather than a queue this retries.
      CREATE TABLE IF NOT EXISTS mailflow_outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        -- The Gmail plugin account this would be sent FROM. Stored at draft
        -- time so the address the floor is measured against belongs to a
        -- mailbox rather than to whichever account happened to be first.
        account_id  INTEGER NOT NULL,
        to_address  TEXT    NOT NULL,
        subject     TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        -- The Gmail THREAD id this is a reply to, or NULL for a fresh mail.
        -- A reply is threaded by Gmail's own threadId plus In-Reply-To and
        -- References built from the thread's last message at SEND time, not
        -- at draft time: a thread that moved on between writing and sending
        -- should be replied to where it actually is.
        in_reply_to TEXT,
        venture     TEXT,
        status      TEXT    NOT NULL,
        -- agent | owner. Who typed the words.
        created_by  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        approved_at TEXT,
        sent_at     TEXT,
        -- Gmail's own message id for the sent copy. NULL until it is sent,
        -- and the only proof in this table that anything left.
        message_id  TEXT,
        error       TEXT
      );

      CREATE INDEX IF NOT EXISTS mailflow_outbox_status ON mailflow_outbox(status, created_at);
      -- The per-address floor reads this index and it reads EVERY status,
      -- dismissed included: a dismissal is the owner saying "not this person,
      -- not now", and re-offering the same address two days later is how a
      -- queue teaches somebody to stop reading it.
      CREATE INDEX IF NOT EXISTS mailflow_outbox_to ON mailflow_outbox(to_address, created_at);
    `,
  },
  {
    name: "122_outbox_delivery",
    sql: `ALTER TABLE mailflow_outbox ADD COLUMN approved_content TEXT;
          ALTER TABLE mailflow_outbox ADD COLUMN sending_at TEXT;
          ALTER TABLE mailflow_outbox ADD COLUMN delivery_checked_at TEXT;
          UPDATE mailflow_outbox SET status = 'draft', approved_at = NULL WHERE status = 'approved';`,
  },

  {
    name: "123_mailflow_triage_threads",
    sql: `
      -- THE ROW THE TRIAGE PAGE DRAWS, CACHED. THIS TABLE REVERSES THE RULE
      -- 120 ABOVE ARGUES FOR, AND THE REVERSAL IS THE POINT OF THE STEP, SO
      -- IT IS WRITTEN OUT RATHER THAN LEFT TO BE DISCOVERED.
      --
      -- WHAT CHANGED, PLAINLY: A SUBJECT, A SENDER AND GMAIL'S OWN SNIPPET
      -- ARE NOW STORED ON THIS BOX. Migration 120 said "there is no subject
      -- column and that absence is the whole privacy claim of this table",
      -- and for the judgement table that is still true — nothing was added to
      -- it. This is a second table, beside it, and it holds the three fields
      -- the list shows.
      --
      -- WHY THE RULE MOVED. The claim it bought was real but small, and the
      -- price was paid on every page load: with nothing mail-shaped stored,
      -- GET /api/triage had to buy the mail again each time it was opened —
      -- one threads.list plus a threads.get PER ROW, fifty rows, ~510 Gmail
      -- quota units and about four and a half seconds of spinner, for a list
      -- whose contents had not changed since the last pass half an hour
      -- earlier. A page nobody waits for is a page nobody opens. So the mail
      -- the page draws is cached here, the background pass keeps it current,
      -- and the read is a SELECT.
      --
      -- WHAT IS STILL NOT STORED, AND THIS HALF IS UNCHANGED: no message
      -- BODY, ever. There is no readThread call anywhere in this area's pass;
      -- the hydration asks Gmail for format=metadata, so what exists to be
      -- stored is a subject line, a From header, the snippet Gmail itself
      -- computes (~180 characters of the newest message) and counters. No
      -- recipient ADDRESS is stored either — see the domains column below.
      --
      -- WHERE IT SITS. The same SQLite file as mailflow_triage next door,
      -- which already holds a model's judgement of every conversation in the
      -- mailbox, under the same 0600 data directory as the vault and the
      -- refresh token that could fetch all of it again. This adds a row's
      -- worth of text to a file whose compromise was already total.
      CREATE TABLE IF NOT EXISTS mailflow_triage_threads (
        account_id   INTEGER NOT NULL,
        thread_id    TEXT    NOT NULL,
        subject      TEXT    NOT NULL,
        from_address TEXT    NOT NULL,
        from_name    TEXT    NOT NULL,
        -- Gmail's snippet, as Gmail computed it. Never a body, and never
        -- more than the listing itself hands over.
        snippet      TEXT    NOT NULL,
        -- The thread's last-message time, in unix milliseconds. The same
        -- fact mailflow_triage.at_ms holds; here it is the ORDER of the page
        -- and there it is what invalidates a score.
        at_ms        INTEGER,
        messages     INTEGER NOT NULL,
        unread       INTEGER NOT NULL,
        -- THE DOMAINS OF THE THREAD'S ADDRESSES, AND NOT THE ADDRESSES. A
        -- JSON array of hosts taken from every To, Cc, Delivered-To and the
        -- From. The venture tag is re-derived from these on every read, so a
        -- venture whose host is typed in after the last pass still tags its
        -- mail immediately — which is the one thing the live read did that a
        -- cache could otherwise lose. A host is not a person: keeping
        -- "acme.ie" rather than "sarah@acme.ie" is the smallest thing that
        -- answers the question this column exists for.
        domains      TEXT    NOT NULL,
        -- Gmail's history id for the thread as of the last hydration. The
        -- incremental pass compares it against the listing and buys a
        -- threads.get only where it MOVED; a null one falls back to the
        -- snippet, which changes when a message arrives.
        history_id   TEXT,
        -- When the last pass saw this thread in the window, and when it
        -- stopped seeing it. gone_at is not "deleted in Gmail" — it is "no
        -- longer inside the window we ask about", which is what archiving,
        -- and simply ageing out of three days, both look like from here. The
        -- read hides these; a thread that comes back clears it.
        seen_at      TEXT    NOT NULL,
        gone_at      TEXT,
        PRIMARY KEY (account_id, thread_id)
      ) WITHOUT ROWID;

      -- The read's own order: one mailbox, still in the window, newest first.
      CREATE INDEX IF NOT EXISTS mailflow_triage_threads_at
        ON mailflow_triage_threads(account_id, gone_at, at_ms DESC);
    `,
  },
];
