/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "110_people_contacts",
    sql: `
      -- WHO THE OWNER ACTUALLY CORRESPONDS WITH, FOLDED OUT OF GMAIL HEADERS.
      --
      -- THE FIRST THING TO KNOW IS WHAT IS NOT HERE: no subject, no snippet,
      -- no body, no message text of any kind. The collector asks Gmail for
      -- messages in "format=metadata" with an explicit header list — From, To,
      -- Cc, Date, Subject — reads the addresses and the dates out of them, and
      -- keeps the counts. Subject lines are looked at ONCE, in memory, to see
      -- whether a venture's host is mentioned, and are never written down. So
      -- a leak of this database is a leak of "the owner writes to jane@acme.io
      -- about twice a month", not of anything either of them said.
      --
      -- (providers/gmail.ts keeps its correspondent counts as HMAC
      -- fingerprints because its consumer is a number on a card and never
      -- needs the address back. This table is a contacts LIST — a page whose
      -- whole job is to say who — so it keeps the address, the way the
      -- previous system's own contacts collector does, and takes the
      -- narrower promise instead: headers only, nothing about content.)
      --
      -- ONE ROW IS ONE PERSON AS SEEN THROUGH ONE MAILBOX. The key is
      -- (mailbox, address) rather than address alone because two connected
      -- Google accounts are two different relationships with the same human:
      -- merging them would produce a "last written to" that is true of neither
      -- inbox, and there is no way to un-merge it later. The route may show
      -- them side by side; the table never adds them up.
      --
      -- EVERY COUNT IS PER WINDOW AND THE WINDOW IS STORED WITH IT. A count
      -- with no window is a number that means something different every time
      -- the setting changes, and "scan_from" is the OLDEST message the scan
      -- actually reached — which is later than the window's start whenever the
      -- message cap bit. Reading "received" as "all mail ever" is the mistake
      -- these two columns exist to prevent.
      --
      -- NOTHING DERIVED IS STORED. Staleness, temperature, the sent/received
      -- balance and the venture link are all computed when this table is READ,
      -- for the reason the uptime table computes availability on the read: a
      -- stored "stale" is wrong the morning after it was written, and it
      -- survives a collector that has stopped running — which is the one
      -- condition it exists to reveal.
      CREATE TABLE IF NOT EXISTS people_contacts (
        -- The connected Gmail account's own address. The mailbox this person
        -- was seen THROUGH, and half the primary key.
        mailbox        TEXT NOT NULL,
        -- Lower-cased, angle brackets and display name stripped.
        address        TEXT NOT NULL,
        -- The display name most recently seen on a From header for this
        -- address. It is a label somebody typed about themselves, not a fact;
        -- "" when they have only ever appeared in a To or Cc line.
        name           TEXT NOT NULL DEFAULT '',
        -- Everything after the @, lower-cased. What the venture link is
        -- guessed from, and what a domain filter matches.
        domain         TEXT NOT NULL,
        -- ISO timestamps of the extreme messages seen IN THE SCANNED WINDOW.
        -- NULL means no message of that direction was seen in the window — it
        -- does NOT mean never.
        first_seen     TEXT,
        last_received  TEXT,
        last_sent      TEXT,
        -- Messages FROM them and TO them, in the window. A message addressed
        -- to five people counts once for each of the five: these are per
        -- person, and summing the column would count one send five times.
        received       INTEGER NOT NULL DEFAULT 0,
        sent           INTEGER NOT NULL DEFAULT 0,
        -- Distinct Gmail thread ids this address appeared in, either way.
        threads        INTEGER NOT NULL DEFAULT 0,
        -- The window this row's counts are over, and how far back the scan
        -- actually got. scan_from later than (scanned_at - window_days) means
        -- the message cap bit and the counts are a FLOOR.
        window_days    INTEGER NOT NULL,
        scan_from      TEXT,
        scanned_at     TEXT NOT NULL,
        PRIMARY KEY (mailbox, address)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS people_contacts_domain ON people_contacts(domain);
      CREATE INDEX IF NOT EXISTS people_contacts_seen ON people_contacts(last_received, last_sent);

      -- ONE ROW PER PERSON PER CALENDAR DAY, so the contact panel can draw a
      -- shape rather than a pair of totals. The day is the message's own date
      -- in UTC — Gmail's internalDate read as a calendar day — so two people
      -- in two time zones are counted on the same grid.
      --
      -- WRITTEN ONLY FOR CONTACTS THAT MEET THE MINIMUM-EACH-WAY RULE at
      -- collect time. A year of a newsletter is 365 rows about a robot, and
      -- the chart it would draw is a picture of a mailing list rather than of
      -- a relationship. The contacts table keeps everyone; this one keeps the
      -- people there is a correspondence with.
      CREATE TABLE IF NOT EXISTS people_days (
        mailbox   TEXT NOT NULL,
        address   TEXT NOT NULL,
        day       TEXT NOT NULL,
        received  INTEGER NOT NULL DEFAULT 0,
        sent      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (mailbox, address, day)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS people_days_day ON people_days(day);
    `,
  },

  {
    name: "111_people_briefs",
    sql: `
      -- THE WEEKLY READING OF THE RELATIONSHIPS, ONE ROW PER ISO WEEK.
      --
      -- The week is the primary key and that is the whole idempotence
      -- mechanism: the timer runs on every boot and every six hours, and the
      -- second run of a week finds a row and does nothing. A brief that
      -- rewrote itself hourly would be a different account of the same week
      -- every time somebody looked, which is not a record of anything.
      --
      -- "figures" IS THE DOCUMENT THE MODEL WAS GIVEN, stored verbatim as
      -- JSON. It is here so that a claim in the markdown can be checked
      -- against the arithmetic it was supposed to come from — the model is
      -- told to cite only figures present in that document, and this column is
      -- what makes that rule auditable rather than aspirational.
      --
      -- "markdown" NULL with an "error" is a week the model could not be
      -- reached. It is not an empty brief and must never be drawn as "nothing
      -- happened".
      CREATE TABLE IF NOT EXISTS people_briefs (
        -- "2026-W36". ISO-8601 week, Monday-based.
        week        TEXT PRIMARY KEY,
        written_at  TEXT NOT NULL,
        -- Which provider and model wrote it, or NULL where it failed.
        model       TEXT,
        markdown    TEXT,
        figures     TEXT NOT NULL,
        error       TEXT
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "112_people_commitments",
    sql: `
      -- PROMISES THE OWNER MADE, IN HIS OWN SENT MAIL.
      --
      -- WHERE THESE COME FROM, precisely: the scan reads the BODIES of the
      -- owner's own sent messages over a small window, hands each one to the
      -- model, and stores what comes back. The bodies are read transiently and
      -- are NEVER written anywhere — not to this table, not to a log, not to
      -- the run ledger. What is stored is one quoted SENTENCE per commitment,
      -- capped at 200 characters, and that sentence is verified to appear
      -- verbatim in the message before the row is written. A commitment whose
      -- sentence is not in the message is dropped, because a model that
      -- paraphrased is a model that may have invented.
      --
      -- IT IS THE OWNER'S OWN WORDS OR IT IS NOT HERE. Only mail in SENT is
      -- read, so nothing anybody else promised can appear, and nothing the
      -- owner was asked to do can appear either.
      --
      -- THE ID IS THE DEDUP KEY. It is a hash of mailbox + thread + the
      -- normalised sentence, so rescanning the same fortnight finds the same
      -- promises and writes no duplicates — and so a commitment already marked
      -- done stays done across a rescan, which is the property that makes the
      -- scan safe to run whenever.
      --
      -- "due" IS DERIVED AND "due_text" IS EVIDENCE. "due_text" is the words
      -- as the owner wrote them, verified in the message like the sentence is;
      -- "due" is this box's reading of those words as a date, and is NULL
      -- whenever there were no such words. A deadline is never invented: no
      -- due_text, no due.
      CREATE TABLE IF NOT EXISTS people_commitments (
        id            TEXT PRIMARY KEY,
        mailbox       TEXT NOT NULL,
        thread_id     TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        -- Who it was said to: the first recipient of the message it was in.
        -- "" when the message had no readable recipient, which happens on
        -- messages sent only to a Bcc list.
        to_address    TEXT NOT NULL DEFAULT '',
        to_name       TEXT NOT NULL DEFAULT '',
        subject       TEXT NOT NULL DEFAULT '',
        -- The model's one-line statement of the promise. A summary, and
        -- labelled as one everywhere it is shown.
        what          TEXT NOT NULL,
        -- The owner's own sentence, verbatim, <= 200 characters. This is the
        -- evidence and it is shown with every row.
        sentence      TEXT NOT NULL,
        due_text      TEXT,
        due           TEXT,
        sent_at       TEXT,
        -- open | done | dismissed. Nothing is ever deleted: a dismissed
        -- promise is a decision, and losing the row loses the decision too.
        status        TEXT NOT NULL DEFAULT 'open',
        found_at      TEXT NOT NULL,
        decided_at    TEXT
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS people_commitments_status ON people_commitments(status, sent_at);
    `,
  },

  {
    name: "113_people_watch",
    sql: `
      -- THE PEOPLE THE OWNER IS WATCHING, TYPED BY HAND.
      --
      -- EVERY OTHER TABLE IN THIS AREA IS A FOLD OF SOMETHING ELSE. Contacts
      -- come out of Gmail headers, commitments out of the owner's own sent
      -- mail, briefs out of the arithmetic over both. This one is the
      -- opposite: nothing collects it, nothing refreshes it, and no scan can
      -- ever add a row. It is a list somebody decided to keep — an investor
      -- worth reading up on, a founder in the same market, the person on the
      -- other side of a deal — and half the people on it will never appear in
      -- the mailbox at all. That is the point: "who do I correspond with" and
      -- "who am I keeping an eye on" are different questions, and folding the
      -- second into people_contacts would put rows in a table whose every
      -- column is a measurement, with every measurement empty.
      --
      -- IT IS NOT KEYED ON AN EMAIL ADDRESS, and that is the design decision
      -- worth defending. people_contacts is keyed on (mailbox, address)
      -- because an address is what a header carries. A person of interest is
      -- often somebody the owner has no address for, and sometimes somebody
      -- whose address changes twice a year. So the key is a minted id, the
      -- name is the only required field, and \`email\` is one more optional
      -- identity line rather than the identity.
      --
      -- NOTHING DERIVED IS STORED HERE EITHER. The dossiers a person has —
      -- how many, whether one is running, when the last one finished — are
      -- counted out of agent_runs on every read, for the same reason this
      -- area computes temperature on the read: a stored count is wrong the
      -- moment a run finishes, and it would survive a run that was deleted.
      -- The join is by TITLE, because \`dossierTitle\` derives the title from
      -- the person's name and that is the tie between this month's dossier
      -- and last month's. See watch.ts's \`attaches\`.
      --
      -- DELETING A ROW DELETES NOTHING ELSE. The dossiers stay in the run
      -- ledger, where they were the box's work rather than this list's
      -- property. Taking somebody off a watchlist is losing interest in them;
      -- it is not a statement that the reports were never written.
      CREATE TABLE IF NOT EXISTS people_watch (
        -- "pw-" and six characters of base 36, minted like a run id.
        id          TEXT PRIMARY KEY,
        -- The only thing required, and the thing a dossier is titled after.
        name        TEXT NOT NULL,
        -- Identity lines, all optional, all as the owner typed them. Empty
        -- string is "not written down" — there is nothing to distinguish from
        -- "asked and not told" on a field nobody asks anything about.
        company     TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT '',
        email       TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        -- A JSON object of at most five known keys — website, github, x,
        -- linkedin, bluesky. JSON rather than five columns because they are
        -- one thing, "where to find them", and a sixth place to look would
        -- otherwise be a migration.
        links       TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      ) WITHOUT ROWID;
    `,
  },
];
