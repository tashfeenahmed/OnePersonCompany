/**
 * WEB ANALYTICS — the tables behind "which audience changed, what did they
 * do, which campaign sent them, and which advertisement is wearing out".
 *
 * The four things this area adds to a box that already has Umami headlines and
 * Meta account totals, and why each one needs a table rather than a division:
 *
 *   web_dimensions     WHO the traffic was — country, device, browser, OS,
 *                      language, screen, referrer — over matched windows, so a
 *                      change has something to be a change FROM.
 *   web_bot_findings   WHEN a bot heuristic first fired, which is the only
 *                      thing that can tell a reader in November that a site did
 *                      not lose four hundred visitors overnight; it stopped
 *                      counting a crawler.
 *   web_events         WHAT was done, with the participants beside the
 *   web_event_props    occurrences, and the numbers those events carried.
 *   web_utm            WHICH tag the visit arrived with.
 *   ad_sets            The Meta rows the ad-health module said out loud it did
 *   ad_creatives       not have: an ad set, an advertisement, a creative, a
 *   ad_days            status, and a per-ad daily series.
 *   ad_windows         Meta's OWN reach and frequency over two matched weeks,
 *                      because neither can be summed out of ad_days.
 *   campaign_ventures  Which business a campaign belongs to, and whether a
 *                      person said so or a link did.
 *
 * NOTHING HERE REPLACES ANYTHING. `umami_windows`, `umami_days`, `umami_top`,
 * `meta_ad_accounts`, `meta_campaigns` and `meta_ad_days` are untouched and
 * still written by their own collectors on their own clocks. Every raw figure
 * this area publishes comes from those tables or from a fresh read; the tables
 * below are the DETAIL underneath them.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "310_web_dimensions",
    sql: `
      -- WHO THE TRAFFIC WAS, one row per (site, dimension, value, window).
      --
      -- WHY A WINDOW AND NOT A DAY, which is the first question to ask of this
      -- table. Umami's HTTP API answers one metric for one window in one
      -- request; a day-grained country breakdown for eighteen sites over
      -- thirty days is 3,240 requests against somebody's own analytics server
      -- every collection. So the grain is the WINDOW, three of them —
      -- 30 days, the last 7, and the 7 before those — which is exactly what
      -- the two questions this table exists for need: "what share is this
      -- audience" (the 30-day distribution) and "what changed" (7 against the
      -- 7 before). start_day and end_day are on every row so nothing has to
      -- reconstruct which days a figure covered.
      --
      -- \`counts\` IS THE POPULATION, IN WORDS, AND IT IS NOT ONE POPULATION.
      -- Measured against three live sites on 2026-09-06 by summing every row
      -- of a metric and comparing with /stats: country, device, browser, os,
      -- language and screen sum to the window's VISITORS (543/527, 1167/1164,
      -- 1883/1883 — the shortfall is sessions Umami dropped for a null field);
      -- referrer counts VIEWS on a pageview-keyed metric and is NOT the
      -- window's pageview total. One count column with the population written
      -- beside it, rather than two columns of which one would always be a
      -- guess.
      --
      -- REPLACED PER (account, website, dimension, window), because a
      -- distribution is a snapshot: merged across two runs it is a
      -- distribution of two different fortnights, and every share computed
      -- from it would be wrong by an amount nobody could measure.
      CREATE TABLE IF NOT EXISTS web_dimensions (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id   TEXT NOT NULL,
        dimension    TEXT NOT NULL,   -- country|device|browser|os|language|screen|referrer
        value        TEXT NOT NULL,   -- '(none)' is Umami's own null bucket, kept
        window_days  INTEGER NOT NULL,
        offset_days  INTEGER NOT NULL, -- 0 = the window ending yesterday
        start_day    TEXT NOT NULL,
        end_day      TEXT NOT NULL,
        count        INTEGER NOT NULL,
        counts       TEXT NOT NULL,   -- 'visitors' | 'views'
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, dimension, window_days, offset_days, value)
      );
      CREATE INDEX IF NOT EXISTS web_dimensions_site ON web_dimensions(website_id, dimension, window_days, offset_days);

      -- THE WINDOW'S OWN HEADLINE, BESIDE THE DISTRIBUTION IT IS THE
      -- DENOMINATOR FOR.
      --
      -- umami_windows already holds a 30-day pair, and it is not enough here
      -- for two reasons: this area needs the SAME 7-day and previous-7-day
      -- windows the dimensions were read over (a share against a different
      -- window is not a share), and it needs \`unattributed\` — the visitors
      -- /stats counted that no dimension row accounted for. Without that
      -- figure every share silently sums to 100% of a smaller number than the
      -- site actually had.
      CREATE TABLE IF NOT EXISTS web_site_windows (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id   TEXT NOT NULL,
        window_days  INTEGER NOT NULL,
        offset_days  INTEGER NOT NULL,
        start_day    TEXT NOT NULL,
        end_day      TEXT NOT NULL,
        pageviews    INTEGER,
        visitors     INTEGER,
        visits       INTEGER,
        bounces      INTEGER,
        totaltime    INTEGER,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, window_days, offset_days)
      );
    `,
  },

  {
    name: "311_web_bot_findings",
    sql: `
      -- WHEN A HEURISTIC FIRST SAW THIS FINGERPRINT.
      --
      -- The verdicts themselves are computed on every read out of
      -- web_dimensions — a stored verdict is a verdict about last Tuesday's
      -- thresholds — but ONE fact cannot be recomputed and must be kept: the
      -- date this box first said a given fingerprint looked automated.
      --
      -- An earlier system learned this the expensive way and hard-coded a
      -- date per trigger. A series that steps down by a third overnight is either a
      -- story about the internet or a story about a policy, and a chart cannot
      -- tell the two apart on its own. This table is how a reader in November
      -- learns which it was, per site and per fingerprint rather than per
      -- release.
      --
      -- NOTHING IS EVER SUBTRACTED FROM A RAW FIGURE ANYWHERE IN THIS AREA.
      -- A finding produces an ADJUSTED series that sits beside the raw one
      -- carrying the heuristic id and the size of the excluded population; the
      -- raw figure is what /api/umami has always published and it does not
      -- move.
      CREATE TABLE IF NOT EXISTS web_bot_findings (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id   TEXT NOT NULL,
        heuristic    TEXT NOT NULL,   -- the id in webanalytics/bots.ts
        fingerprint  TEXT NOT NULL,   -- dimension:value, e.g. 'screen:800x600'
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL,
        excluded     INTEGER,         -- the population when last seen
        PRIMARY KEY (account_id, website_id, heuristic, fingerprint)
      );
    `,
  },

  {
    name: "312_web_events",
    sql: `
      -- WHAT WAS DONE, WITH THE PARTICIPANTS BESIDE THE OCCURRENCES.
      --
      -- THIS IS THE WHOLE POINT OF THE TABLE. umami_top holds an event
      -- ranking by COUNT; on the connected instance 'checkout-started' fired
      -- 5,978 times in 4,434 sessions, and a document that published the
      -- larger figure as though it were people would overstate that funnel
      -- step by a third. The two are read from two different endpoints —
      -- /metrics?type=event for the occurrences, /sessions?event=<name> for
      -- the participants — and the endpoint that answered is stored, because
      -- an Umami build that does not honour the session filter must read as
      -- "not measured" rather than as nought.
      --
      -- A PARTICIPANT IS A SESSION IDENTITY, NOT A PERSON. Umami hashes the
      -- site, the address and the user agent: one person on a phone and a
      -- laptop is two, one office behind one address may be one. Every
      -- document that prints this figure says so.
      CREATE TABLE IF NOT EXISTS web_events (
        account_id           INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id           TEXT NOT NULL,
        event_name           TEXT NOT NULL,
        window_days          INTEGER NOT NULL,
        start_day            TEXT NOT NULL,
        end_day              TEXT NOT NULL,
        occurrences          INTEGER,
        participants         INTEGER,
        participants_source  TEXT,    -- the endpoint that answered
        participants_error   TEXT,    -- why there is no participant figure
        seen_at              TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, event_name, window_days)
      );
      CREATE INDEX IF NOT EXISTS web_events_site ON web_events(website_id, window_days);

      -- THE NUMBERS THOSE EVENTS CARRIED.
      --
      -- Umami has no aggregate for a numeric property: /event-data/events
      -- answers each distinct VALUE with how often it occurred. The count,
      -- sum, mean and range below are computed from that complete value list
      -- and are therefore EXACT rather than sampled — \`truncated\` records
      -- the one case where they would not be, and a truncated row's
      -- aggregates are refused rather than published short.
      --
      -- \`unit\` IS THE OWNER'S, NEVER THIS BOX'S GUESS. A property called
      -- 'revenue' might be cents, dollars or credits and nothing in the API
      -- says which. It comes from a setting; NULL means the unit was never
      -- stated and every document that prints the figure must say the unit is
      -- unknown rather than assume one.
      --
      -- A NON-NUMERIC PROPERTY KEEPS ITS TOP VALUES AND NO ARITHMETIC.
      -- \`top_values\` is a JSON array of {value, count}, capped, and it is a
      -- RANKING: it sums to less than \`records\` and no total may be drawn
      -- from it.
      CREATE TABLE IF NOT EXISTS web_event_props (
        account_id     INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id     TEXT NOT NULL,
        event_name     TEXT NOT NULL,
        property       TEXT NOT NULL,
        data_type      TEXT NOT NULL,  -- string|number|boolean|date|array
        window_days    INTEGER NOT NULL,
        start_day      TEXT NOT NULL,
        end_day        TEXT NOT NULL,
        records        INTEGER NOT NULL,
        distinct_values INTEGER NOT NULL,
        truncated      INTEGER NOT NULL,
        num_count      INTEGER,
        num_sum        REAL,
        num_avg        REAL,
        num_min        REAL,
        num_max        REAL,
        unit           TEXT,
        top_values     TEXT,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, event_name, property, window_days)
      );
      CREATE INDEX IF NOT EXISTS web_event_props_site ON web_event_props(website_id, window_days);
    `,
  },

  {
    name: "313_web_utm",
    sql: `
      -- THE TAG A VISIT ARRIVED WITH.
      --
      -- Umami stores the query string VERBATIM and never splits it, so
      -- /metrics?type=query is the only place on the HTTP API a campaign tag
      -- appears. Each raw string is parsed here into the five UTM parameters,
      -- lowercased on key and value so ?utm_Source=Google and
      -- ?utm_source=google are one row.
      --
      -- \`views\` IS UMAMI'S OWN COUNT FOR A PAGEVIEW-KEYED METRIC and is not
      -- the window's pageview total — measured, and stated on every document.
      -- IT IS NOT SESSIONS AND IT IS NOT PEOPLE. A visitor who reloaded a
      -- tagged landing page four times is four here, which is why the join in
      -- attribution.ts labels this column "tagged views" everywhere and never
      -- "visits from the campaign".
      --
      -- A STRING WITH NO UTM AT ALL IS NOT STORED. That is every organic visit
      -- on the site and it carries nothing this table is for.
      CREATE TABLE IF NOT EXISTS web_utm (
        account_id   INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id   TEXT NOT NULL,
        window_days  INTEGER NOT NULL,
        offset_days  INTEGER NOT NULL,
        start_day    TEXT NOT NULL,
        end_day      TEXT NOT NULL,
        utm_source   TEXT NOT NULL,   -- '' where the tag was absent
        utm_medium   TEXT NOT NULL,
        utm_campaign TEXT NOT NULL,
        utm_content  TEXT NOT NULL,
        utm_term     TEXT NOT NULL,
        views        INTEGER NOT NULL,
        seen_at      TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, window_days, offset_days,
                     utm_source, utm_medium, utm_campaign, utm_content, utm_term)
      );
      CREATE INDEX IF NOT EXISTS web_utm_campaign ON web_utm(utm_campaign);
    `,
  },

  {
    name: "314_ad_level",
    sql: `
      -- AD SETS. The row growth/ads.ts names in its own limitations block as
      -- the thing it does not have.
      --
      -- WHAT IS STILL NOT CLAIMED FROM IT, and this is written into the table
      -- rather than only into a document: an ad set id, a name and an
      -- optimisation goal DO NOT establish learning status and DO NOT
      -- establish audience overlap. Meta publishes a learning phase field only
      -- through delivery insights this token has not been asked for, and the
      -- targeting specification is not read at all. Two ad sets that spend on
      -- the same day are two ad sets that spend on the same day.
      CREATE TABLE IF NOT EXISTS ad_sets (
        adset_id          TEXT PRIMARY KEY,
        ad_account_id     TEXT NOT NULL,
        campaign_id       TEXT,
        name              TEXT,
        -- effective_status, never configured_status: an ad set left ACTIVE
        -- inside a paused campaign is not running.
        status            TEXT,
        optimization_goal TEXT,
        billing_event     TEXT,
        bid_strategy      TEXT,
        -- Meta sends budgets as MINOR UNITS of the account's currency, as a
        -- quoted string. Stored as the number Meta sent, in minor units, with
        -- the currency beside it; nothing divides by a hundred without saying
        -- so.
        daily_budget      REAL,
        lifetime_budget   REAL,
        currency          TEXT,
        start_time        TEXT,
        end_time          TEXT,
        seen_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ad_sets_account ON ad_sets(ad_account_id);

      -- THE ADVERTISEMENTS THEMSELVES, AND WHAT THEY LOOK LIKE.
      --
      -- image_url AND thumbnail_url ARE SIGNED AND EXPIRE. Meta stamps an
      -- oe= deadline a few days out, exactly as it does on a Page picture, so
      -- these are only as good as the row is fresh: nothing may cache one and
      -- whatever renders it must survive a 403. They are stored because an
      -- ad-level view with no picture is a list of ids.
      --
      -- issues IS META'S OWN issues_info, AS JSON AND UNEDITED. A disapproval
      -- is the platform's sentence about the platform's own policy and
      -- paraphrasing it would be inventing a reason.
      CREATE TABLE IF NOT EXISTS ad_creatives (
        ad_id             TEXT PRIMARY KEY,
        ad_account_id     TEXT NOT NULL,
        adset_id          TEXT,
        campaign_id       TEXT,
        name              TEXT,
        status            TEXT,   -- effective_status
        configured_status TEXT,
        creative_id       TEXT,
        creative_name     TEXT,
        title             TEXT,
        body              TEXT,
        call_to_action    TEXT,
        link_url          TEXT,
        image_url         TEXT,
        thumbnail_url     TEXT,
        issues            TEXT,
        created_time      TEXT,
        updated_time      TEXT,
        seen_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ad_creatives_account ON ad_creatives(ad_account_id);
      CREATE INDEX IF NOT EXISTS ad_creatives_adset ON ad_creatives(adset_id);

      -- ONE ADVERTISEMENT ON ONE DAY.
      --
      -- A DAY META DID NOT REPORT HAS NO ROW, meta_ad_days' rule and for its
      -- reason: an invented zero turns "this ad stopped delivering on the
      -- 16th" into a measured flat line.
      --
      -- reach AND frequency ARE HERE AND ARE PER-DAY FIGURES. They are stored
      -- because a daily reach is a real measurement of that day, and they are
      -- NEVER summed or averaged into a window figure — Meta de-duplicates
      -- reach over the row's own window, so seven daily reaches do not make a
      -- week's reach and seven daily frequencies do not average into a week's
      -- frequency. The week's own figures live in ad_windows below, asked for
      -- as their own request. Every read enforces this; the columns exist so
      -- a per-day chart is possible, not so a total is.
      CREATE TABLE IF NOT EXISTS ad_days (
        ad_id          TEXT NOT NULL,
        ad_account_id  TEXT NOT NULL,
        adset_id       TEXT,
        campaign_id    TEXT,
        day            TEXT NOT NULL,
        impressions    INTEGER,
        reach          INTEGER,
        frequency      REAL,
        clicks         INTEGER,
        spend          REAL,
        ctr            REAL,
        cpm            REAL,
        actions        TEXT,   -- JSON {action_type: value}
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (ad_id, day)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ad_days_day ON ad_days(day);
      CREATE INDEX IF NOT EXISTS ad_days_account ON ad_days(ad_account_id, day);

      -- META'S OWN ANSWER FOR TWO MATCHED WEEKS, PER ADVERTISEMENT.
      --
      -- THE FATIGUE VIEW CANNOT BE BUILT WITHOUT THIS AND THAT IS THE ONLY
      -- REASON IT EXISTS. Fatigue is frequency rising while click-through
      -- falls, and a window frequency is not derivable from daily rows at any
      -- grain. So the collector asks Meta twice with an explicit time_range —
      -- the last seven complete days, and the seven before those — and stores
      -- what it said, with the dates it covered.
      CREATE TABLE IF NOT EXISTS ad_windows (
        ad_id          TEXT NOT NULL,
        ad_account_id  TEXT NOT NULL,
        window_days    INTEGER NOT NULL,
        offset_days    INTEGER NOT NULL,
        start_day      TEXT NOT NULL,
        end_day        TEXT NOT NULL,
        impressions    INTEGER,
        reach          INTEGER,
        frequency      REAL,
        clicks         INTEGER,
        spend          REAL,
        ctr            REAL,
        cpm            REAL,
        seen_at        TEXT NOT NULL,
        PRIMARY KEY (ad_id, window_days, offset_days)
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "315_campaign_ventures",
    sql: `
      -- WHICH BUSINESS A CAMPAIGN BELONGS TO.
      --
      -- venture_links' contract, deliberately: a SUGGESTION is computed on
      -- every read out of live rows and carries the sentence that produced it;
      -- a LINK is a row somebody wrote. \`source\` records which happened —
      -- 'auto-by-link' means the owner accepted a suggestion this box derived
      -- from a URL in the campaign, ad set, advertisement or creative, and
      -- 'manual' means they picked the business themselves. Neither is
      -- written without a press.
      --
      -- \`evidence\` IS THE SENTENCE, KEPT. Six months later "why is this
      -- campaign filed under that business" has an answer that is not a guess
      -- about what the matcher used to do.
      --
      -- ONE CAMPAIGN, ONE VENTURE. A campaign that genuinely advertises two
      -- businesses would need a share to split its spend by, and there is no
      -- honest one available, so the primary key refuses the arrangement
      -- rather than inventing a denominator.
      CREATE TABLE IF NOT EXISTS campaign_ventures (
        platform     TEXT NOT NULL,   -- 'meta'
        campaign_id  TEXT NOT NULL,
        venture_id   TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        source       TEXT NOT NULL,   -- 'auto-by-link' | 'manual'
        evidence     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (platform, campaign_id)
      );
      CREATE INDEX IF NOT EXISTS campaign_ventures_venture ON campaign_ventures(venture_id);
    `,
  },

  {
    name: "316_web_clocks",
    sql: `
      -- PER-UNIT CLOCKS FOR THIS AREA'S TWO COLLECTORS.
      --
      -- A full dimensional, event and property read costs roughly fifty
      -- requests per website against somebody's own analytics server, and the
      -- connected instance carries eighteen sites. Doing all of them every
      -- half hour would be nine hundred requests a tick for figures that move
      -- daily. So the collector takes a BUDGET of sites per pass and rotates:
      -- each site has its own clock, the least recently read go first, and a
      -- site added this morning is read on the next tick rather than tomorrow.
      CREATE TABLE IF NOT EXISTS web_clocks (
        kind  TEXT NOT NULL,
        key   TEXT NOT NULL,
        at    TEXT NOT NULL,
        PRIMARY KEY (kind, key)
      );
    `,
  },

  {
    name: "317_web_dimension_cap",
    sql: `
      -- WAS THIS DISTRIBUTION THE WHOLE DISTRIBUTION?
      --
      -- Added after the first live collection proved the assumption 310 was
      -- written on. Umami's /metrics answers at most the row limit asked for
      -- and says nothing about a tail; one live site's screen dimension came
      -- back exactly 500 rows long in all three windows, which is the cap and
      -- not the site. Two things were wrong as a result and both are the same
      -- error: every share in that block was computed against a short
      -- denominator, and the route published the missing tail as "sessions
      -- with no screen on them", which is a reason that was not true.
      --
      -- The flag is per ROW rather than per block because the block is not a
      -- row anywhere — it is (account, website, dimension, window, offset), and
      -- a second table keyed on that to hold one boolean would be a join for a
      -- flag. Every row of a block carries the same value; the readers take it
      -- from the first.
      --
      -- DEFAULT 0 IS "NOT CAPPED", which is what every row written before this
      -- migration was, or was not, without anybody knowing. That is a real
      -- limitation of the backfill and not a claim: those rows are replaced
      -- wholesale on the site's next rotation, at which point the flag is
      -- measured rather than assumed.
      ALTER TABLE web_dimensions ADD COLUMN capped INTEGER NOT NULL DEFAULT 0;
    `,
  },

  {
    name: "401_site_windows",
    sql: `
      -- ONE WINDOW TABLE, BECAUSE TWO OF THEM WERE TWO CLOCKS ON THE SAME
      -- MEASUREMENT.
      --
      -- \`umami_windows\` is written by the traffic collector every six hours
      -- for every website. \`web_site_windows\` is written by this area's own
      -- collector on a twelve-hour ROTATION that reaches a few sites a pass.
      -- Both ask the same analytics instance for the last 30 complete days, so
      -- the two rows are read hours to days apart — and the two surfaces that
      -- publish them, a traffic headline and an audience breakdown, are
      -- registered as agent skills on the SAME plugin. An agent's answer to
      -- "how many visitors last month" depended on which skill it picked.
      --
      -- THE KEY IS (account, website, window_days, offset_days).
      -- \`umami_windows\` had no offset — every row of it is the window ending
      -- yesterday — so it carries across as offset 0, which is what
      -- \`web_site_windows\` already calls that window.
      --
      -- THE PREVIOUS-WINDOW COLUMNS COME ACROSS TOO, and stay nullable.
      -- \`umami_windows\` fetched the same length of window immediately before
      -- this one as a second call rather than reading Umami's own \`prev\`
      -- field, which some versions omit and others compute over a range this
      -- code did not choose; a delta computed from two windows this box asked
      -- for is a delta whose denominator is knowable. The rotation collector
      -- never asked for one, and null says exactly that.
      --
      -- \`source\` IS KEPT ON THE ROW rather than dropped as an implementation
      -- detail, because two collectors still write here and "which one last
      -- touched this figure" is the question that could not be answered when
      -- the two disagreed.
      CREATE TABLE IF NOT EXISTS site_windows (
        account_id      INTEGER NOT NULL REFERENCES plugin_accounts(id) ON DELETE CASCADE,
        website_id      TEXT NOT NULL,
        window_days     INTEGER NOT NULL,
        offset_days     INTEGER NOT NULL,  -- 0 = the window ending yesterday
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
        source          TEXT NOT NULL,
        PRIMARY KEY (account_id, website_id, window_days, offset_days)
      );

      -- THE AUTHORITATIVE TABLE GOES IN FIRST, and the rotation's rows follow
      -- with OR IGNORE, so a key both tables hold keeps the traffic
      -- collector's figure. That is the same winner the read half already
      -- names: it is the fresher and the complete one — every site, four times
      -- a day, against a rotation that may not have reached this site yet.
      INSERT INTO site_windows
        (account_id, website_id, window_days, offset_days, start_day, end_day,
         pageviews, visitors, visits, bounces, totaltime,
         prev_pageviews, prev_visitors, prev_visits, prev_bounces, prev_totaltime,
         seen_at, source)
      SELECT account_id, website_id, window_days, 0, start_day, end_day,
             pageviews, visitors, visits, bounces, totaltime,
             prev_pageviews, prev_visitors, prev_visits, prev_bounces, prev_totaltime,
             seen_at, 'umami_windows'
        FROM umami_windows;

      INSERT OR IGNORE INTO site_windows
        (account_id, website_id, window_days, offset_days, start_day, end_day,
         pageviews, visitors, visits, bounces, totaltime,
         prev_pageviews, prev_visitors, prev_visits, prev_bounces, prev_totaltime,
         seen_at, source)
      SELECT account_id, website_id, window_days, offset_days, start_day, end_day,
             pageviews, visitors, visits, bounces, totaltime,
             NULL, NULL, NULL, NULL, NULL,
             seen_at, 'web_site_windows'
        FROM web_site_windows;

      -- THE TWO SOURCE TABLES ARE STILL HERE, AND THAT IS THE UNFINISHED HALF.
      -- Their writers live in two areas this step may not edit
      -- (\`analytics/store.ts::writeUmamiWindow\` and
      -- \`webanalytics/store.ts::writeSiteWindow\`), and dropping a table whose
      -- writer still names it is an outage. Repointing both writers and both
      -- readers at \`site_windows\` is one commit; the DROP is the migration
      -- after it, and until then this table is a complete copy that nothing
      -- reads.
    `,
  },
];
