/** Pure SQL, no imports — see integrations/manifest.ts for why.
 *
 * THE ANALYTICS AREA'S FOUR TABLES SETS, plus one clock shared by three of
 * them. Numbers 030–039 are this area's; nothing outside it may use them.
 *
 * TWO NAMING DEVIATIONS FROM THE BRIEF, both forced by SQLite's grammar and
 * both cheap: a column called `end` has to be quoted at every mention (END is
 * a keyword, and an unquoted one inside a CREATE TABLE is a syntax error on
 * some builds and a trap on all of them), so the window bounds are
 * `start_day`/`end_day` and an event's are `starts_at`/`ends_at`. The wire
 * documents still say `start` and `end`, because that is what a reader of a
 * window calls them.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "030_analytics_clocks",
    sql: `
      -- WHEN AN EXPENSIVE COLLECTOR LAST RAN, one row per (plugin, thing).
      --
      -- Three collectors in this area are on a slow clock — Umami six hours,
      -- Calendar two, Bluesky six — for the reason collector.ts's
      -- TRAFFIC_EVERY_HOURS gives: they read day-grained figures, and asking
      -- every half hour spends requests to redraw the same buckets. The
      -- scheduler runs every connected plugin every thirty minutes and has no
      -- opinion about that, so each of these checks its own last run and
      -- returns early with note "fresh".
      --
      -- WHY NOT THE \`runs\` TABLE. A run row is per plugin and per attempt,
      -- including the attempts that returned "fresh" — so "when did we last
      -- actually READ Umami" is not a question it can answer without teaching
      -- every reader what a fresh run looks like. And the clock is per KEY:
      -- an Umami account added at nine collects immediately while its
      -- neighbour waits, exactly as a newly connected GitHub account does.
      --
      -- The key is the collector's own choice of unit — an account id for
      -- Umami and Calendar, a handle for Bluesky — as text, because a table
      -- shared by three collectors cannot have three types.
      CREATE TABLE analytics_clocks (
        plugin  TEXT NOT NULL,
        key     TEXT NOT NULL,
        at      TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );
    `,
  },

  {
    name: "031_umami",
    sql: `
      -- THE WEBSITES ONE UMAMI INSTANCE SERVES, as the last collection saw
      -- them. Replaced per account each run, so a website deleted in Umami
      -- leaves this table rather than lingering as a card with a frozen
      -- figure; the days and windows below it are keyed by website_id and are
      -- deliberately NOT deleted with it, because history that was true stays
      -- true after somebody tidies a dashboard.
      CREATE TABLE umami_websites (
        account_id  INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id  TEXT NOT NULL,
        name        TEXT,
        domain      TEXT,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id)
      );

      -- THE DAILY LINE, one row per website per day. An ACCUMULATION keyed by
      -- its own day, like the npm downloads table: a run that dies half way
      -- leaves fewer days rather than a wrong picture, and the ninety days
      -- asked for on every run rewrite themselves harmlessly.
      --
      -- \`sessions\` is Umami's own word for what it counts here and is NOT
      -- the same population as \`visitors\` in the window table below — see
      -- that table's header.
      CREATE TABLE umami_days (
        account_id  INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id  TEXT NOT NULL,
        day         TEXT NOT NULL,
        pageviews   INTEGER NOT NULL,
        sessions    INTEGER NOT NULL,
        PRIMARY KEY (account_id, website_id, day)
      );

      -- THE WINDOW AND THE ONE BEFORE IT, as Umami's own /stats answered.
      --
      -- Stored rather than summed from umami_days because two of these five
      -- figures CANNOT be summed from a daily line and never could:
      -- \`visitors\` is de-duplicated over the window Umami was asked about,
      -- so thirty daily visitor counts add up to something larger than the
      -- month's real visitors by an unknown amount, and \`bounces\` is defined
      -- against visits. Asking Umami for the window is the only way to get the
      -- window's own answer.
      --
      -- \`prev_*\` is the SAME LENGTH of window immediately before this one,
      -- fetched as a second call rather than read off Umami's own \`prev\`
      -- field, which some versions omit and others compute over a range this
      -- code did not choose. A delta computed here from two windows this code
      -- asked for is a delta whose denominator is knowable.
      --
      -- \`totaltime\` is Umami's seconds-on-site total for the window. The
      -- average visit length the route publishes is computed from it and
      -- \`visits\` at read time, never stored: a stored average is a derived
      -- number that decays.
      CREATE TABLE umami_windows (
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id      TEXT NOT NULL,
        window_days     INTEGER NOT NULL,
        start_day       TEXT NOT NULL,
        end_day         TEXT NOT NULL,
        pageviews       INTEGER,
        visitors        INTEGER,
        visits          INTEGER,
        bounces         INTEGER,
        totaltime       INTEGER,
        prev_pageviews  INTEGER,
        prev_visitors   INTEGER,
        prev_visits     INTEGER,
        prev_bounces    INTEGER,
        prev_totaltime  INTEGER,
        seen_at         TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, window_days)
      );

      -- THE RANKED BREAKDOWNS: top urls, referrers and events.
      --
      -- A RANKING, NEVER A TOTAL — the universal rule the Search Console rows
      -- keep, and for the same reason: this is the top twenty of a list Umami
      -- truncated, so the rows sum to less than the window's pageviews by an
      -- amount nobody here can measure. Replaced per (account, website, kind,
      -- window) each run, because a ranking is a snapshot and a merged one is
      -- a ranking of two different days.
      CREATE TABLE umami_top (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,   -- 'url' | 'referrer' | 'event'
        name         TEXT NOT NULL,
        count        INTEGER NOT NULL,
        window_days  INTEGER NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, kind, window_days, name)
      );
    `,
  },

  {
    name: "032_calendar",
    sql: `
      -- THE CALENDARS ON ONE GOOGLE ACCOUNT. \`selected\` is the owner's own
      -- choice inside Google — the tick beside a calendar in the web UI — and
      -- it is what decides which calendars are read, because a Google account
      -- carries holiday feeds, birthday feeds and shared read-only calendars
      -- that would triple the events and mean nothing about the owner's day.
      CREATE TABLE calendar_calendars (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        calendar_id  TEXT NOT NULL,
        summary      TEXT,
        timezone     TEXT,
        is_primary   INTEGER NOT NULL DEFAULT 0,
        selected     INTEGER NOT NULL DEFAULT 0,
        access_role  TEXT,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, calendar_id)
      );

      -- THE EVENTS IN THE WINDOW, AND NOT ONE WORD MORE THAN THE QUESTION
      -- NEEDS.
      --
      -- There is no description column and there will not be one — the same
      -- line the mail tables draw, which have no column that could hold a
      -- subject or a body. A meeting's notes are the most private text on a
      -- calendar and no figure on this dashboard is computed from them, so
      -- storing them would be collecting something in case it were wanted.
      --
      -- \`attendees\` IS A COUNT, not a list. "Is this a two-person call or a
      -- twelve-person meeting" is the only thing any figure here asks of the
      -- guest list, and a count answers it without writing down who the owner
      -- meets. \`organizer_self\` and \`response\` are about the OWNER only.
      --
      -- \`response\` is the owner's own responseStatus on the event
      -- ('accepted' | 'tentative' | 'declined' | 'needsAction'), or NULL on an
      -- event with no guest list. It is the column that makes the busy-hours
      -- figure honest: a declined meeting is not an hour of anybody's day, and
      -- without this the only alternative would be counting it.
      --
      -- \`starts_at\`/\`ends_at\` hold Google's own strings — an RFC3339
      -- timestamp WITH ITS OFFSET for a timed event, a bare 'YYYY-MM-DD' for
      -- an all-day one. Not normalised to UTC: an event at 09:00 is at 09:00
      -- in the calendar it lives in, and rewriting that to UTC would make
      -- "what is on today" a question about the reader's offset.
      CREATE TABLE calendar_events (
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        calendar_id     TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        summary         TEXT,
        starts_at       TEXT,
        ends_at         TEXT,
        all_day         INTEGER NOT NULL DEFAULT 0,
        status          TEXT,
        location        TEXT,
        attendees       INTEGER,
        organizer_self  INTEGER,
        response        TEXT,
        updated_at      TEXT,
        PRIMARY KEY (account_id, calendar_id, event_id)
      );
      CREATE INDEX calendar_events_start ON calendar_events(starts_at);
    `,
  },

  {
    name: "033_pypi",
    sql: `
      -- PyPI DOWNLOADS, one row per package per day. npm's table, one registry
      -- across.
      --
      -- IT IS DOWNLOADS AND NEVER INSTALLS, and here the word is doing even
      -- more work than it does for npm: PyPI's counter is BigQuery-derived
      -- file requests, and pypistats publishes it with mirrors excluded by
      -- request (\`?mirrors=false\`, which this collector always sends) — but
      -- CI runs, Docker layer rebuilds and a person typing \`pip install\` are
      -- still one download each and nothing can tell them apart.
      CREATE TABLE pypi_days (
        package    TEXT NOT NULL,
        day        TEXT NOT NULL,
        downloads  INTEGER NOT NULL,
        PRIMARY KEY (package, day)
      );

      -- WHAT THE PACKAGE IS, from PyPI's own JSON, beside what pypistats last
      -- said about it. The two are different services with different outages,
      -- so each keeps its own error: a package whose metadata 404s can still
      -- have downloads, and a package pypistats has never heard of can still
      -- have a version.
      --
      -- \`last_day\`/\`last_week\`/\`last_month\` are pypistats' OWN rolling
      -- windows, stored as it answered them and never recomputed from
      -- pypi_days: they end yesterday rather than on a calendar boundary, and
      -- the route says so beside them rather than quietly presenting one as
      -- "this week".
      CREATE TABLE pypi_packages (
        package       TEXT PRIMARY KEY,
        version       TEXT,
        summary       TEXT,
        home_page     TEXT,
        project_urls  TEXT,       -- JSON object as PyPI returned it
        last_day      INTEGER,
        last_week     INTEGER,
        last_month    INTEGER,
        recent_at     TEXT,
        meta_at       TEXT,
        seen_at       TEXT,
        last_ok_at    TEXT,
        last_error    TEXT
      );
    `,
  },

  {
    name: "034_bluesky",
    sql: `
      -- ONE ROW PER HANDLE, as the public AppView last answered.
      --
      -- The counts are Bluesky's own totals and are current state rather than
      -- history — the history is in \`readings\` under
      -- \`bluesky.<handle>.followers\`, appended every collection, which is
      -- what survives a handle being renamed or a profile going quiet.
      CREATE TABLE bluesky_profiles (
        handle        TEXT PRIMARY KEY,
        did           TEXT,
        display_name  TEXT,
        followers     INTEGER,
        follows       INTEGER,
        posts         INTEGER,
        avatar        TEXT,
        seen_at       TEXT,
        last_ok_at    TEXT,
        last_error    TEXT
      );

      -- WHAT THE LAST FIFTY POSTS ADD UP TO OVER 7 AND 30 DAYS.
      --
      -- \`truncated\` IS THE WHOLE POINT OF THIS TABLE. The author feed is
      -- read one page deep — fifty posts — because that is one request and a
      -- prolific account would otherwise cost a dozen. When the oldest post on
      -- that page is NEWER than the window's start, the window did not fit in
      -- the page and every figure in this row is a FLOOR: there were at least
      -- this many likes, and possibly many more. A floor drawn as a total is
      -- how a busy month reads as a quiet one, so the flag rides with the row
      -- and the route refuses to hide it.
      --
      -- Reposts BY the handle are excluded from every count here: the feed
      -- carries them with a \`reason\`, they are somebody else's post, and
      -- their likes are somebody else's likes.
      CREATE TABLE bluesky_windows (
        handle       TEXT NOT NULL,
        window_days  INTEGER NOT NULL,
        posts        INTEGER NOT NULL,
        likes        INTEGER NOT NULL,
        reposts      INTEGER NOT NULL,
        replies      INTEGER NOT NULL,
        quotes       INTEGER NOT NULL,
        truncated    INTEGER NOT NULL DEFAULT 0,
        oldest_seen  TEXT,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (handle, window_days)
      );
    `,
  },

  {
    name: "035_bluesky_posts",
    sql: `
      -- THE POSTS THEMSELVES, so a figure can be read beside the words that
      -- earned it.
      --
      -- \`bluesky_windows\` above already holds what the last fifty posts add
      -- up to. It cannot answer "which post was that" — and a likes total
      -- without the post behind it is a number nobody can act on, which is the
      -- gap this table closes. One row per post per handle, rewritten on every
      -- collection because THE COUNTS ARE CURRENT STATE: an old post gathering
      -- new likes moves them, exactly as the window figures move.
      --
      -- \`url\` IS DERIVED AND NOT FETCHED. bsky.app addresses a post by the
      -- record key already inside the at:// uri, so the link costs no request.
      -- \`image\` is a CDN thumbnail URL and nothing here downloads it.
      --
      -- Reposts BY the handle never reach this table: they are somebody else's
      -- post, the same rule the window totals keep.
      CREATE TABLE bluesky_posts (
        handle      TEXT NOT NULL,
        uri         TEXT NOT NULL,
        created_at  TEXT,
        text        TEXT,
        image       TEXT,
        url         TEXT,
        likes       INTEGER NOT NULL DEFAULT 0,
        reposts     INTEGER NOT NULL DEFAULT 0,
        replies     INTEGER NOT NULL DEFAULT 0,
        quotes      INTEGER NOT NULL DEFAULT 0,
        is_reply    INTEGER NOT NULL DEFAULT 0,
        seen_at     TEXT NOT NULL,
        PRIMARY KEY (handle, uri)
      );

      CREATE INDEX bluesky_posts_at ON bluesky_posts (created_at DESC);
    `,
  },
];
