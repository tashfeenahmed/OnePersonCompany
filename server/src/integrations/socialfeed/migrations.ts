/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "340_social_posts",
    sql: `
      -- WHAT WAS ACTUALLY PUBLISHED, as the platform reports it.
      --
      -- Everything else this box knows about social content is something it
      -- MADE: a Studio post, a video on a run page, a draft in the publishing
      -- queue. This table is the other direction — the posts that already
      -- exist on a Facebook Page or an Instagram business account, with the
      -- numbers the platform is willing to publish about them. Without it a
      -- generated draft can be judged on how it looks and never on how it did.
      --
      -- THE PRIMARY KEY IS THE PLATFORM'S OWN ID, so a re-read UPDATES a post
      -- rather than adding a second copy of it. Meta revises engagement counts
      -- for days after a post goes out; a table that appended would show one
      -- post four times with four different reach figures and no way to say
      -- which was current.
      --
      -- \`metrics\` IS JSON AND ITS KEYS ARE THE PLATFORM'S OWN METRIC NAMES.
      -- Not "reach", not "engagement". Facebook and Instagram do not measure
      -- the same things and have never agreed on a name for the things they
      -- both measure, so a column called \`reach\` would be two different
      -- quantities stacked in one place — Instagram's \`reach\` is unique
      -- people and Facebook's nearest survivor, \`post_media_view\`, counts
      -- renders. Keeping Meta's spelling means a figure can always be traced
      -- back to the field that produced it, and it means a metric Meta retires
      -- simply stops appearing instead of silently becoming a zero.
      --
      -- \`venture_id\` IS A MAPPING AND MAY BE NULL. It is read off the
      -- publishing area's destination rows — the owner said which Page belongs
      -- to which business there, and saying it twice would be two answers. A
      -- Page nobody has mapped keeps its posts with a null venture rather than
      -- being guessed at by name.
      CREATE TABLE IF NOT EXISTS social_posts (
        platform      TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        account_id    INTEGER,
        page_id       TEXT NOT NULL,
        page_name     TEXT,
        venture_id    TEXT,
        created_time  TEXT,
        permalink     TEXT,
        media_type    TEXT,
        image_url     TEXT,
        text          TEXT,
        metrics       TEXT NOT NULL DEFAULT '{}',
        -- What was missing, in words, for THIS post. A post whose insights
        -- block never arrived is not a post with no reach.
        note          TEXT,
        fetched_at    TEXT NOT NULL,
        PRIMARY KEY (platform, external_id)
      );
      CREATE INDEX IF NOT EXISTS social_posts_page ON social_posts (page_id, created_time DESC);
      CREATE INDEX IF NOT EXISTS social_posts_venture ON social_posts (venture_id, created_time DESC);
    `,
  },

  {
    name: "341_social_accounts",
    sql: `
      -- ONE ROW PER PLACE POSTS WERE READ FROM, and the state of that reading.
      --
      -- THE PERMISSION ERROR IS THE POINT AND IT IS STORED VERBATIM. Meta
      -- refuses a posts edge in half a dozen ways — (#210) wants a Page token,
      -- (#100) means the metric no longer exists, (#190) means the token is
      -- the wrong kind — and each sends somebody to a different place. A
      -- boolean \`ok\` column would flatten all of them into "it did not work",
      -- which is the least useful true sentence available.
      --
      -- FRESHNESS IS PER ACCOUNT, NOT PER TABLE. Three Pages read at three
      -- different moments, one of them failing, is the ordinary state; a
      -- single "last collected" would report the newest and hide the stale.
      CREATE TABLE IF NOT EXISTS social_accounts (
        platform       TEXT NOT NULL,
        page_id        TEXT NOT NULL,
        account_id     INTEGER,
        account_label  TEXT,
        page_name      TEXT,
        venture_id     TEXT,
        -- The last time posts came back. Null means they never have.
        last_ok_at     TEXT,
        -- The last time it was tried at all, which is a different date.
        last_try_at    TEXT,
        posts          INTEGER,
        -- Meta's own words, whole. Null when the last try worked.
        error          TEXT,
        -- Separate from \`error\`: posts can arrive while their insights are
        -- refused, and reporting that as a failure would hide the posts.
        insights_error TEXT,
        PRIMARY KEY (platform, page_id)
      );
    `,
  },

  {
    name: "342_source_candidates",
    sql: `
      -- WHAT A SHORTS JOB COULD HAVE BEEN CUT FROM, and what was refused.
      --
      -- The autopilot could not queue a shorts job at all before this: that
      -- format needs a source URL and nothing on this box knew how to find
      -- one. This is that search, written down — every candidate a query
      -- returned, its rank, and, for the ones that were not used, the sentence
      -- saying why. A discovery pass that only recorded its winner would
      -- answer "why did it pick that video" with the video.
      --
      -- \`verdict\` IS 'eligible', 'refused' OR 'chosen'. Refusal reasons are
      -- concrete and deterministic — too short, too long, already used, not a
      -- video host — and they are computed in code rather than asked of a
      -- model, because "do not repeat yourself" is a constraint and an
      -- instruction to a model is not one.
      --
      -- \`duration_from\` NAMES THE MEASUREMENT. SearXNG publishes a length
      -- string per video result that comes from the engine that found it and
      -- is sometimes wrong; yt-dlp reads the real metadata and is not. A
      -- ranking that mixed the two without saying which is which would be a
      -- ranking nobody could check.
      CREATE TABLE IF NOT EXISTS source_candidates (
        id            TEXT PRIMARY KEY,
        venture_id    TEXT NOT NULL,
        format        TEXT NOT NULL,
        query         TEXT NOT NULL,
        url           TEXT NOT NULL,
        source_id     TEXT,
        title         TEXT,
        author        TEXT,
        engine        TEXT,
        published_at  TEXT,
        duration_s    INTEGER,
        duration_from TEXT,
        score         REAL,
        rank          INTEGER,
        verdict       TEXT NOT NULL,
        reason        TEXT,
        ts            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS source_candidates_venture ON source_candidates (venture_id, ts DESC);
      CREATE INDEX IF NOT EXISTS source_candidates_source ON source_candidates (source_id);
    `,
  },

  {
    name: "343_content_history",
    sql: `
      -- WHAT HAS ALREADY BEEN MADE, so that it is not made again.
      --
      -- DURABLE, AND THAT IS THE WHOLE FEATURE. The autopilot used to avoid
      -- repeating itself by putting the last five briefs in a prompt and
      -- asking nicely. That is not a constraint: a model handed five subjects
      -- and told to pick a sixth will, often enough, pick the first one again
      -- in different words, and the failure costs a Replicate charge and a
      -- Pexels download before anybody notices. This table is what the gate in
      -- novelty.ts reads, and the gate runs BEFORE anything is spent.
      --
      -- \`fingerprint\` IS A NORMALISED FORM OF THE TOPIC and not the topic.
      -- See novelty.ts for exactly what it does: lowercase, strip URLs and
      -- punctuation, drop stop words and short words, five-character stems,
      -- sorted, joined. Two briefs that are the same video in different words
      -- have the same or nearly the same fingerprint, which is the comparison
      -- a string equality cannot make.
      --
      -- A ROW IS WRITTEN WHEN WORK IS QUEUED, not when it finishes. A run that
      -- failed still used up its topic — re-deriving the same subject the next
      -- morning because yesterday's encode crashed would be the gate failing
      -- open on exactly the day it matters.
      CREATE TABLE IF NOT EXISTS content_history (
        id          INTEGER PRIMARY KEY,
        venture_id  TEXT NOT NULL,
        -- post | faceless | shorts | ugc. The gate is per format: the same
        -- subject as a post and as a video is two pieces of work, not a repeat.
        format      TEXT NOT NULL,
        topic       TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        -- For a shorts job: the video it was cut from, and its address. Null
        -- for every format that has no source.
        source_url  TEXT,
        source_id   TEXT,
        -- For a walkthrough or a page-based brief. Null otherwise.
        page_url    TEXT,
        -- 'run' with a run id, or 'studio_post' with a post id. What this
        -- topic actually became, so the history links to the thing.
        asset_kind  TEXT,
        asset_ref   TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS content_history_key ON content_history (venture_id, format, created_at DESC);
      CREATE INDEX IF NOT EXISTS content_history_fp ON content_history (fingerprint);
      CREATE INDEX IF NOT EXISTS content_history_source ON content_history (source_id);
    `,
  },

  {
    name: "344_novelty_checks",
    sql: `
      -- EVERY VERDICT THE GATE HAS GIVEN, including the ones that let something
      -- through.
      --
      -- The same argument the autopilot log makes about its skips: a gate that
      -- only recorded refusals answers "why was there no video this week" with
      -- silence, and a gate that recorded nothing at all cannot be told apart
      -- from one that is not running. \`verdict\` is 'allow' or 'refuse',
      -- \`reason\` is the sentence a person reads, and \`matched\` is the
      -- history row that caused a refusal so the two can be put side by side.
      CREATE TABLE IF NOT EXISTS novelty_checks (
        id          INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL,
        venture_id  TEXT,
        format      TEXT NOT NULL,
        -- 'topic' or 'source'. Two different questions with two different
        -- answers: a topic is compared by fingerprint over a window, a source
        -- video is compared by id and forever.
        kind        TEXT NOT NULL,
        value       TEXT NOT NULL,
        fingerprint TEXT,
        verdict     TEXT NOT NULL,
        reason      TEXT,
        matched_id  INTEGER,
        matched     TEXT,
        -- The overlap, 0..1, where one was computed. Null for a source check,
        -- which is an identity test and not a similarity one.
        score       REAL
      );
      CREATE INDEX IF NOT EXISTS novelty_checks_ts ON novelty_checks (ts DESC);
      CREATE INDEX IF NOT EXISTS novelty_checks_venture ON novelty_checks (venture_id, ts DESC);
    `,
  },

  {
    name: "345_ugc_jobs",
    sql: `
      -- A UGC JOB: a product in a scene, animated, captioned, filed as a draft.
      --
      -- IT IS A VIDEO RUN AND THIS IS THE ROW BESIDE IT. The run row holds the
      -- ledger — queued, running, the report — and video_jobs holds the
      -- finished file the Video page draws. This holds the four things only a
      -- UGC job has: which reference assets went in, the two prompts, whether
      -- the image model could actually take a picture as an input, and WHICH
      -- STEP WAS SKIPPED AND WHY.
      --
      -- THE SKIP IS THE MOST IMPORTANT COLUMN HERE. The animation step calls a
      -- paid image-to-video model that has NO DEFAULT: with no model named in
      -- the settings the step does not run, the job finishes with a still
      -- image and a sentence, and nothing is spent. A default here would be a
      -- feature that starts charging somebody the first time they press a
      -- button they have not read about.
      CREATE TABLE IF NOT EXISTS ugc_jobs (
        run_id        TEXT PRIMARY KEY,
        venture_id    TEXT,
        ts            TEXT NOT NULL,
        asset_ids     TEXT NOT NULL DEFAULT '[]',
        image_prompt  TEXT,
        video_prompt  TEXT,
        image_path    TEXT,
        video_path    TEXT,
        image_model   TEXT,
        -- The input property the image model takes a picture in, measured off
        -- its own schema. Null means it takes none and the references were
        -- described in words instead, which is much weaker and is said so.
        image_field   TEXT,
        video_model   TEXT,
        seconds       INTEGER,
        captions      TEXT,
        publish_item  TEXT,
        -- JSON: one entry per step with what happened to it.
        steps         TEXT NOT NULL DEFAULT '[]',
        skipped       TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS ugc_jobs_venture ON ugc_jobs (venture_id, ts DESC);
    `,
  },

  {
    name: "346_socialfeed_deliveries",
    sql: `
      -- WHAT HAS BEEN HANDED OVER, so it is not handed over twice.
      --
      -- A finished asset is delivered two ways: a message on the configured
      -- channel, and a DRAFT in the publishing queue. Both are idempotent
      -- because both have to be — the sweep that finds finished runs wakes
      -- every few minutes and would otherwise send the same video every few
      -- minutes for as long as the row existed.
      --
      -- A FAILED DELIVERY IS RECORDED AS ONE. \`sent = 0\` with a reason is a
      -- Telegram that is not paired or a publishing queue that refused the
      -- item, and it is kept rather than retried forever: the reason is a
      -- setting somebody has to change, not a network blip.
      CREATE TABLE IF NOT EXISTS socialfeed_deliveries (
        ref          TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        venture_id   TEXT,
        at           TEXT NOT NULL,
        channel      TEXT,
        sent         INTEGER NOT NULL DEFAULT 0,
        reason       TEXT,
        publish_item TEXT
      );
    `,
  },
  {
    name: "347_content_history_archived",
    sql: `
      -- FORGETTING IS NOW ARCHIVING, and the column is why.
      --
      -- The first version of \`forget\` DELETED the row. That is the one shape
      -- of write this codebase flags as irreversible — \`delete_card\` is
      -- marked destructive while its sibling \`archive_card\` is not — and it
      -- was reachable by an agent with no owner in the loop. The failure is
      -- concrete: the agent is asked for a video about X, hits a refusal it can
      -- read the rules for, and forgets the history row to get past it,
      -- destroying the record of what was already made.
      --
      -- SO THE ROW STAYS AND THE GATE STOPS COUNTING IT. \`archived_at\` null
      -- is a live entry; a date is one the owner set aside. The gate skips
      -- archived rows, which is what unblocks the topic; every list still shows
      -- them, flagged, so the record of what was made survives; and
      -- \`restore\` puts one back, which is what makes the action reversible
      -- rather than merely regrettable.
      ALTER TABLE content_history ADD COLUMN archived_at TEXT;
      CREATE INDEX IF NOT EXISTS content_history_live
        ON content_history (venture_id, format, archived_at, created_at DESC);
    `,
  },

];
