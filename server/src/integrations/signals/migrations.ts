/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    /*
      BACKLINKS — TWO TABLES, AND THE FIRST ONE IS ONE ROW PER SOURCE ON
      PURPOSE.

      Three free sources answer the "who links to this" question and they
      DISAGREE BY DESIGN: a crawler that fetched the page, an index that
      remembers a page, and a commons that captured a domain are three
      different measurements of three different things. A schema with one
      `referring_domains` column per host would force a merge at write time
      and lose the only fact that makes the numbers usable — which source
      said it, and how much that source is worth. So the source is half the
      primary key, its confidence is stored beside its numbers, and nothing
      in this codebase adds two of these rows together.

      EVERY NUMBER HERE IS NULLABLE AND `ok` IS THREE-VALUED, because the
      difference between "Common Crawl has never captured this domain" (a
      real zero) and "Common Crawl did not answer" (a null) is the whole
      point of the collector. `ok = 1` with a null count means the source
      answered but has no figure of that kind to give — which is exactly
      what Bing does for a site whose link index is empty.

      THE COLUMNS ARE PER-SOURCE RATHER THAN GENERIC. `crawl_pages` is only
      ever Common Crawl's, `linked_pages` is only ever Bing's, and the three
      verification counts are only ever the crawler's. One "value" column
      with a "kind" beside it would have been shorter and would have made
      every reader look up what this row's number means.
    */
    name: "050_backlinks",
    sql: `
      CREATE TABLE backlink_sources (
        host              TEXT NOT NULL,
        -- commoncrawl | bing | verify. Named, not free text: the route's
        -- confidence table and the collector both key off these three.
        source            TEXT NOT NULL,
        ts                TEXT NOT NULL,
        -- 1 answered, 0 refused, NULL never asked (no credential, no clock).
        ok                INTEGER,
        -- Distinct external hosts with at least one link in. NULL is "this
        -- source cannot say", never zero.
        referring_domains INTEGER,
        -- Total links in, as counted by an index. Bing's only.
        backlinks         INTEGER,
        -- How many of OUR OWN urls have any link into them. Bing's only.
        linked_pages      INTEGER,
        -- Pages of this host the commons captured. Common Crawl's only, and
        -- it is CRAWL PRESENCE rather than in-degree — see the collector.
        crawl_pages       INTEGER,
        -- The verification crawler's three counts: pages fetched, pages that
        -- still carried the link, and of those, the ones that pass authority.
        checked           INTEGER,
        live              INTEGER,
        followed          INTEGER,
        -- What this source's word is worth, 0..1, copied onto the row so a
        -- stored answer keeps the confidence it was collected under.
        confidence        REAL NOT NULL,
        note              TEXT,
        error             TEXT,
        PRIMARY KEY (host, source)
      );

      -- The rows behind the counts: one per page that links (or is claimed to
      -- link) to a host. Capped per host by the collector, newest kept.
      CREATE TABLE backlink_rows (
        host        TEXT NOT NULL,
        source      TEXT NOT NULL,
        from_domain TEXT NOT NULL,
        from_url    TEXT NOT NULL,
        -- The url of OURS the link points at, where the source named one.
        to_url      TEXT,
        anchor      TEXT,
        -- Only the verification crawler can answer these two: 1/0 from a page
        -- this box fetched and read, NULL from an index's recollection.
        live        INTEGER,
        nofollow    INTEGER,
        error       TEXT,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (host, source, from_url)
      );
      CREATE INDEX backlink_rows_host ON backlink_rows(host, seen_at);
    `,
  },

  {
    /*
      PRESENCE — one row per product per source, replaced on every check.

      `status` IS A CLOSED SET OF FOUR AND THE FOURTH IS THE REASON THE TABLE
      EXISTS: present, absent, blocked, error. A directory that answers 403
      is BLOCKED, not absent — recording a WAF as "this product is listed
      nowhere" would put homework on a page that nobody owes, and it is the
      single most damaging thing this collector could get wrong.

      `evidence` SAYS WHICH KIND OF ANSWER IT IS, because three kinds are not
      one: `linked` (the record names the brand AND points back at the
      product's own host — the only thing counted as present from a search-
      shaped source), `named` (names the brand and does not point back: a
      candidate for the owner to judge, never a detection), and `page` (the
      directory's own url for this name answered, and the page names it).
    */
    name: "051_presence",
    sql: `
      CREATE TABLE presence (
        product  TEXT NOT NULL,
        host     TEXT NOT NULL,
        source   TEXT NOT NULL,
        ts       TEXT NOT NULL,
        status   TEXT NOT NULL,
        url      TEXT,
        evidence TEXT,
        note     TEXT,
        PRIMARY KEY (product, source)
      );
      CREATE INDEX presence_host ON presence(host);
    `,
  },

  {
    /*
      VOICE — one row per transcription, per synthesis, per conversion.

      A LOG OF ATTEMPTS RATHER THAN A CACHE OF AUDIO. Nothing here holds a
      word that was said or a byte that was heard: the transcript goes into
      the chat transcript where the typed message would have gone, and the
      audio file goes on disk under DATA_DIR. What is kept is how long it
      took, how big it was and whether it worked — which is what "is the
      voice path healthy" needs and is the least this can store to answer it.
    */
    name: "052_voice",
    sql: `
      CREATE TABLE voice_runs (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts    TEXT NOT NULL,
        -- stt | tts | ogg | probe
        kind  TEXT NOT NULL,
        ms    INTEGER,
        bytes INTEGER,
        ok    INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX voice_runs_ts ON voice_runs(ts);
    `,
  },
];
