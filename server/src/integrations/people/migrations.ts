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
  {
    name: "114_people_watch_file",
    sql: `
      -- THE WATCHED PERSON'S FILE: what is publicly true about them, beside
      -- what the owner typed about them.
      --
      -- 113 gave the watchlist its identity lines and nothing else, and that
      -- was the honest table for a list that nothing collected. This step adds
      -- the half that IS collected — followers, karma, a timeline of public
      -- posts and pushes — and the first thing to say about it is that the two
      -- halves never overwrite each other. \`name\`, \`company\`, \`role\`,
      -- \`email\` and \`note\` are still only ever what he typed. Everything
      -- added here comes from somebody else's public API and is stamped with
      -- when it was read.
      --
      -- KEYLESS SOURCES ONLY, and that is a design decision rather than a
      -- limitation to be fixed later. A watchlist that needed an X token, a
      -- LinkedIn cookie and a scraping budget would be a watchlist that stops
      -- working the first time one of them expires, on a box whose owner would
      -- have no idea which. GitHub's public API, Bluesky's public AppView,
      -- Algolia's Hacker News index and an RSS feed all answer an anonymous
      -- GET, so the file either fills in or says in \`pull_warnings\` which
      -- source did not answer — and no page ever goes blank because a
      -- credential went stale.
      --
      -- \`metrics\` IS JSON AND EVERY FIGURE IN IT MAY BE null. Null is "not
      -- known": the link was never typed, or the source did not answer. It is
      -- never 0. A GitHub account with no followers reports 0 and a person
      -- with no GitHub link reports null, and conflating those would put
      -- "0 followers" under somebody who has an audience elsewhere.
      --
      -- \`activity_at\` IS WHEN THE PULL RAN, NOT WHEN ANYTHING HAPPENED. It
      -- is what the sweep reads to decide who is due, and what a reader is
      -- shown so that an empty timeline can be told apart from a timeline
      -- nobody has fetched yet. NULL means never pulled.
      ALTER TABLE people_watch ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE people_watch ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE people_watch ADD COLUMN activity_at TEXT;
      ALTER TABLE people_watch ADD COLUMN pull_warnings TEXT NOT NULL DEFAULT '[]';

      -- ONE PUBLIC THING A WATCHED PERSON DID, and the key is a HASH OF THE
      -- THING rather than of the source's own id.
      --
      -- Four sources with four id schemes — a GitHub event id, an AT-protocol
      -- URI, an Algolia objectID, an RSS guid that is often just the link —
      -- and one of them (RSS) has no stable id at all on a good number of real
      -- feeds. sha256(source|url|title) is an id every source can produce, and
      -- it makes re-pulling idempotent for the only definition of "the same
      -- event" that holds across all four: the same source said the same thing
      -- about the same URL.
      --
      -- \`first_seen_at\` IS KEPT ACROSS AN UPDATE AND \`at\` IS NOT. \`at\` is
      -- when the thing happened, as its source states it, and a source may
      -- restate it. \`first_seen_at\` is when THIS BOX first saw it, which is
      -- the only basis on which anything here can honestly be called new — a
      -- freshly watched person's whole timeline arrives at once, and every row
      -- of it is old news that this box has never seen before.
      CREATE TABLE IF NOT EXISTS people_watch_events (
        -- The watch row this belongs to. Its events die with it: unlike the
        -- dossiers, which are the box's own work and stay in the run ledger,
        -- these are a cache of somebody else's public timeline and mean
        -- nothing once the person is off the list.
        person_id     TEXT NOT NULL,
        -- sha256(source|url|title), first 24 characters.
        key           TEXT NOT NULL,
        -- "GitHub", "Bluesky", "Hacker News", "RSS" — as shown to a reader.
        source        TEXT NOT NULL,
        -- push, create, release, public, post, comment, story.
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        -- NULL when the source gave no link. Not every feed item has one.
        url           TEXT,
        -- When it happened, per the source.
        at            TEXT NOT NULL,
        -- When this box first pulled it. What "new" is measured from.
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (person_id, key)
      ) WITHOUT ROWID;

      -- The timeline read, which is the only read there is: one person's
      -- events, newest first.
      CREATE INDEX IF NOT EXISTS people_watch_events_at ON people_watch_events(person_id, at);
    `,
  },
  {
    name: "115_people_watch_avatar",
    sql: `
      -- THE FACE ON A WATCHED PERSON'S CARD, AND THE BYTES OF IT KEPT HERE.
      --
      -- THE WHOLE REASON THIS IS A TABLE AND NOT A COLUMN HOLDING A URL. A
      -- card that drew <img src="https://avatars.githubusercontent.com/…">
      -- would work perfectly, cost this box nothing, and tell GitHub the hour
      -- of every morning the owner opened a person's file — who he looked at,
      -- how often, and from which address. That is a log of his attention held
      -- by somebody else, produced by a feature whose entire subject is people
      -- he is quietly keeping an eye on. So the image is FETCHED ONCE by the
      -- pull, on the box's own schedule, and afterwards served from here: the
      -- third party sees one anonymous GET every seven days and never sees a
      -- reader at all.
      --
      -- A BLOB RATHER THAN A FILE ON DISK, and it is the smaller of the two
      -- decisions. These are avatars — tens of kilobytes each, at most a few
      -- hundred rows — so the whole store is smaller than one screenshot the
      -- ventures area already keeps. Against that, a directory of loose files
      -- is a second thing to back up, a second thing to clean up when a person
      -- is deleted, and a second way for the database and the disk to disagree
      -- about what exists. The row goes when the person goes, in the same
      -- transaction as the rest of them.
      --
      -- \`avatar_source\` IS AN ADDRESS, NOT A PICTURE. It is where the bytes
      -- came from, kept so the next pull can tell "the same face as last week"
      -- from "they changed their photo" without downloading anything to find
      -- out. It is also the one field an IMPORT may fill: Workdash's export
      -- carries an avatar URL per row, and recording it costs nothing and
      -- fetches nothing — the pull that follows does the fetching, because an
      -- import of two hundred rows must not become two hundred downloads
      -- inside one request.
      --
      -- NULL IN EITHER COLUMN IS "NOT KNOWN", the way every nullable figure in
      -- this area is. No GitHub or Bluesky link and no imported URL means
      -- nobody here has ever had an address to try, and it is never a claim
      -- that the person has no photograph.
      ALTER TABLE people_watch ADD COLUMN avatar_source TEXT;
      ALTER TABLE people_watch ADD COLUMN avatar_at TEXT;

      -- ONE ROW PER PERSON, AND THE PERSON IS THE KEY. There is no history of
      -- somebody's old profile pictures here: a face is a label on a card, the
      -- current one is the only one anything draws, and keeping the others
      -- would be this box quietly archiving how people used to look.
      CREATE TABLE IF NOT EXISTS people_watch_avatars (
        person_id  TEXT PRIMARY KEY,
        -- As the server declared it, verified to start with "image/". Stored
        -- because it is served back verbatim and guessing it on the way out
        -- would be guessing twice about the same bytes.
        mime       TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        -- When these bytes were read. The same instant as the row's
        -- \`avatar_at\`, kept here too because it is what the ETag is made of.
        fetched_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    name: "116_people_watch_history",
    sql: `
      -- THE NUMBERS AS A SERIES RATHER THAN AS A SNAPSHOT, AND THE CHANGES
      -- WORTH SAYING OUT LOUD.
      --
      -- 114 gave the watchlist one \`metrics\` blob per person: the figures as
      -- of the last pull, overwritten by the next one. That answers "how many
      -- followers do they have" and cannot answer the only question anybody
      -- actually asks a watchlist — "is anything happening with them?" A
      -- number on its own is a fact about a stranger; the same number beside
      -- what it was last week is a fact about a trajectory, which is the thing
      -- worth keeping a list of people for.
      --
      -- ONE ROW PER PERSON PER DAY, AND THE DAY IS HALF THE KEY. A pull is due
      -- every twenty hours and the refresh button may be pressed at any time,
      -- so a table keyed by instant would have some days with one point and
      -- some with five — and a chart drawn from it would put a kink in every
      -- line at the hour somebody happened to press a button. The day is the
      -- unit the series is ABOUT, so it is the unit the table is keyed by, and
      -- a second pull on the same day REPLACES that day's row rather than
      -- adding to it. The cost is that intra-day movement is not recorded,
      -- which is the correct thing to lose: nobody watches a follower count by
      -- the hour, and the ±10 signals below are computed against the previous
      -- PULL and not against this table, so nothing that moved goes unnoticed.
      --
      -- EVERY FIGURE IS NULLABLE FOR THE REASON EVERY FIGURE IN \`metrics\` IS.
      -- NULL is "not known" — no link of that kind on the card, or the source
      -- did not answer — and it is never 0. A row of five NULLs is a pull that
      -- reached nobody, and it is still worth keeping: it is the evidence that
      -- the box looked.
      --
      -- CAPPED AT 420 ROWS PER PERSON, which is about fourteen months. The cap
      -- is enforced by the writer rather than by a trigger, in the same
      -- transaction as the insert, the way \`people_watch_events\` is trimmed
      -- to 300. A watchlist of thirty people at the cap is thirteen thousand
      -- rows of six small integers — a table this box will never notice — and
      -- without a cap it is a table that grows for as long as the box runs.
      CREATE TABLE IF NOT EXISTS people_watch_history (
        -- Dies with the person, like the events and the face: this is a cache
        -- of what somebody else's public API said, and it means nothing once
        -- the row it describes is off the list.
        person_id      TEXT NOT NULL,
        -- "YYYY-MM-DD", UTC, cut from the pull's own stamp. A string rather
        -- than a date type because node:sqlite has none, and because the only
        -- two things done with it are ORDER BY and equality — both of which
        -- an ISO day answers correctly as text.
        day            TEXT NOT NULL,
        -- The instant the pull that produced this row ran. Kept beside the day
        -- because "how old is this point" is a question about the instant, and
        -- because a same-day replacement should move it.
        at             TEXT NOT NULL,
        gh_followers   INTEGER,
        gh_repos       INTEGER,
        bsky_followers INTEGER,
        bsky_posts     INTEGER,
        hn_karma       INTEGER,
        PRIMARY KEY (person_id, day)
      ) WITHOUT ROWID;

      -- THE PROFILE TEXT, KEPT ONLY SO THE NEXT PULL CAN TELL IT CHANGED.
      --
      -- This is not a field anybody displays and it is not part of the typed
      -- half: it is one string held from the last pull so that the next one
      -- can compare and say "Bio changed". GitHub's \`bio\` if there is a
      -- GitHub link, otherwise Bluesky's \`description\` — one column rather
      -- than two, because the signal is "the sentence they describe
      -- themselves with is different" and it does not become two facts
      -- because there are two places to read it from.
      --
      -- NULL IS "NEVER READ", and the FIRST pull of somebody deliberately
      -- records no signal: a bio that has just been seen for the first time
      -- has not changed, it has merely become known. Every signal in this
      -- feature needs BOTH readings, and one reading is not a difference.
      ALTER TABLE people_watch ADD COLUMN public_bio TEXT;
    `,
  },
];
