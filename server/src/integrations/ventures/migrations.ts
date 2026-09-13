/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "060_venture_links",
    sql: `
      -- HOW EVERYTHING ON THIS BOX IS CONNECTED TO A BUSINESS.
      --
      -- Every other table here is keyed by whatever the provider that wrote it
      -- calls a thing: a Cloudflare zone id, a Search Console property string,
      -- an npm package name, an ssh account id. None of them knows what
      -- BUSINESS it belongs to, and none of them can — a zone named
      -- acme.ie is a fact about DNS, not about a venture. This table is
      -- the join, and it is the only place the answer is written down.
      --
      -- (venture_id, plugin, entity) IS THE KEY AND \`entity\` IS THE
      -- PROVIDER'S OWN IDENTIFIER, never a URL this file invented. That is
      -- what makes a link survive a rename: a zone renamed in Cloudflare keeps
      -- its zone id, a property re-verified keeps its property string, and the
      -- edge points at the same thing it always did. \`label\` is a copy of what
      -- the entity was CALLED when the link was made — for a graph that can be
      -- drawn without fetching nine integrations first — and it is allowed to
      -- go stale, because it is a caption rather than a key.
      --
      -- \`source\` KEEPS AN OWNER'S DECISION APART FROM A GUESS. 'owner' is a
      -- link somebody made on purpose; 'auto' is one this box proposed from a
      -- hostname match and had accepted wholesale. They are stored differently
      -- because they are worth different amounts: an auto link is evidence
      -- that two strings looked alike, and an owner link is somebody saying
      -- that they ARE the same business.
      --
      -- THE CASCADE IS DELIBERATE, and it is the opposite of what board cards
      -- do with a deleted venture. A card is a record of work that happened
      -- and survives the folder it was filed in; an EDGE to a venture that no
      -- longer exists is not a record of anything — it is a line in a graph
      -- pointing at nothing, and every reader would have to filter it out.
      CREATE TABLE venture_links (
        venture_id  TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        plugin      TEXT NOT NULL,
        entity      TEXT NOT NULL,
        label       TEXT,
        source      TEXT NOT NULL CHECK(source IN ('owner','auto')),
        created_at  TEXT NOT NULL,
        PRIMARY KEY (venture_id, plugin, entity)
      );
      -- The reverse question — "which venture does this zone belong to" — is
      -- asked as often as the forward one, by every page that draws a figure
      -- and wants to caption it with a business.
      CREATE INDEX venture_links_entity ON venture_links(plugin, entity);
    `,
  },

  {
    name: "061_venture_shots",
    sql: `
      -- WHAT THE SITE LOOKED LIKE, as a picture, with the failures kept.
      --
      -- A row per ATTEMPT rather than a column on the venture, because a
      -- capture that failed is the thing worth having: "Chrome could not be
      -- found", "the page timed out at 25 seconds" and "there is no shot yet"
      -- are three different states, and a nullable path on the ventures table
      -- could only hold the third. The newest row is the current answer
      -- whether it succeeded or not; the newest SUCCESSFUL row is the picture.
      --
      -- \`path\` IS ABSOLUTE AND THE BYTES ARE NOT IN HERE. A 1280x800 PNG is a
      -- few hundred kilobytes and there is one per venture per week; putting
      -- them in the database would triple its size to store something that is
      -- already a file, and the backup that copies DATA_DIR takes the shots
      -- with it either way. NULL path with an error is a failed attempt.
      --
      -- \`brand_rendered\` IS THE SECOND THING A HEADLESS BROWSER CAN SAY.
      -- ventures/enrich.ts reads a brand off the raw HTML because this app has
      -- no browser; when there IS one on the machine, the RENDERED DOM carries
      -- what a JS framework painted after load, which the static reader cannot
      -- see. It is stored beside the picture rather than in ventures.brand
      -- because that column is enrich.ts's and a coarser reading must not
      -- overwrite a finer one. JSON, or NULL for a capture that did not dump.
      CREATE TABLE venture_shots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id     TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        ts             TEXT NOT NULL,
        path           TEXT,
        bytes          INTEGER,
        width          INTEGER,
        height         INTEGER,
        brand_rendered TEXT,
        error          TEXT
      );
      CREATE INDEX venture_shots_venture ON venture_shots(venture_id, ts DESC);
    `,
  },

  {
    name: "062_venture_audits",
    sql: `
      -- ONE CRAWL, WHOLE, AS THE DOCUMENT IT PRODUCED.
      --
      -- The findings are JSON in one column rather than a table of issues, and
      -- that is the same decision ventures.brand makes for the same reason:
      -- nothing queries an individual finding. An audit is read WHOLE, by a
      -- page that draws it and by an agent that summarises it, and its shape
      -- belongs to the crawler — which is free to learn a new check without a
      -- migration, and will.
      --
      -- \`pages\` AND \`issues\` ARE OUT HERE BECAUSE THEY ARE THE ONLY TWO THINGS
      -- ASKED OF AN AUDIT WITHOUT OPENING IT: the history list wants to say
      -- "60 pages, 14 issues" per run without parsing a hundred kilobytes of
      -- JSON per row. Every other figure is computed on the read, out of the
      -- document, which is what stops a stored count disagreeing with the rows
      -- it was counted from.
      CREATE TABLE venture_audits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id  TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        ts          TEXT NOT NULL,
        doc         TEXT NOT NULL,
        pages       INTEGER NOT NULL,
        issues      INTEGER NOT NULL
      );
      CREATE INDEX venture_audits_venture ON venture_audits(venture_id, ts DESC);
    `,
  },

  {
    name: "063_studio_posts",
    sql: `
      -- WHAT THE STUDIO MADE, including the half of it that failed.
      --
      -- A post is TWO generations — a caption from a language model and an
      -- image from Replicate — and they fail independently. So both halves
      -- have their own column and \`error\` is a note about the RUN rather than
      -- a flag on the row: a post with a caption, no image and an error saying
      -- Replicate is not connected is a useful post and a true record, and it
      -- is the exact state a box with no image token is supposed to reach.
      -- Nothing here is deleted on failure.
      --
      -- \`image_path\` IS A FILE, for venture_shots' reason: a megabyte of PNG
      -- per post does not belong in a database that is otherwise measured in
      -- kilobytes, and DATA_DIR is what the backup copies.
      --
      -- THE PROMPTS ARE STORED because they are the only way to tell a bad
      -- model from a bad brief. A post nobody likes is either the words that
      -- were sent or the model that answered them, and a row that kept neither
      -- can settle it.
      --
      -- The id is a TEXT id this app mints rather than an autoincrement,
      -- because it names a file on disk before the row is written.
      CREATE TABLE studio_posts (
        id           TEXT PRIMARY KEY,
        venture_id   TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        ts           TEXT NOT NULL,
        brief        TEXT NOT NULL,
        platform     TEXT,
        format       TEXT NOT NULL,
        caption      TEXT,
        hashtags     TEXT,
        image_prompt TEXT,
        image_path   TEXT,
        model        TEXT,
        ms           INTEGER,
        error        TEXT
      );
      CREATE INDEX studio_posts_venture ON studio_posts(venture_id, ts DESC);
    `,
  },

  {
    name: "404_venture_links_evidence",
    sql: `
      -- WHY THIS LINK EXISTS, IN THE SENTENCE THAT MADE IT.
      --
      -- \`source\` already separates a link the owner pressed from one this box
      -- derived, which is the half that decides who may overwrite it. It does
      -- not say WHAT was derived: six months later "why is this campaign filed
      -- under that business" has no answer but a guess about what the matcher
      -- used to do.
      --
      -- \`campaign_ventures\` — a second links table with the same contract,
      -- built for Meta campaigns — got this right and has carried an
      -- \`evidence\` column from the day it was written. It is the column this
      -- table is missing, and it is the one thing standing between the two
      -- tables being one: a merge that dropped the sentence would be a merge
      -- that lost the only field the second table had and the first did not.
      --
      -- NULL ON EVERY EXISTING ROW, and it stays null rather than being
      -- backfilled with a reconstruction. A derived link whose sentence was
      -- never recorded has no sentence, and inventing today's matcher output
      -- as the reason for a link made in March is the failure this column
      -- exists to prevent.
      ALTER TABLE venture_links ADD COLUMN evidence TEXT;
    `,
  },
  {
    name: "480_venture_journeys",
    sql: `
      ALTER TABLE ventures ADD COLUMN business_type TEXT CHECK (business_type IS NULL OR business_type IN ('web','mobile','desktop','website','shop','goods','service'));
      CREATE TABLE venture_journeys (
        venture_id TEXT PRIMARY KEY REFERENCES ventures(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE venture_stage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, note TEXT NOT NULL, ts TEXT NOT NULL
      );
      CREATE INDEX venture_stage_history_venture ON venture_stage_history(venture_id,id);
      CREATE TABLE venture_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        ts TEXT NOT NULL, business_type TEXT, done INTEGER NOT NULL, total INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX venture_reviews_venture ON venture_reviews(venture_id,id);
    `,
  },
];
